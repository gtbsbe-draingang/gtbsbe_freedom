"""Evaluation jobs: apply a checklist version to a set of dialogues (system design 7.3-7.5).

The model judges each criterion through stream C's evaluator (app.evaluator_port); this module
decides what needs a call, caches what comes back, scores in code and stores everything.

* **Reuse.** Every judgment is cached under the evaluator's reuse key (criterion fingerprint,
  checklist guidance, transcript, model, prompt version). In `reuse` mode a criterion whose key is
  cached costs no call, so a weight-only change re-grades a whole set without the model. `full`
  mode ignores the cache (it still refreshes it).
* **Dry run.** `plan_run` counts the calls a run would make, without making any.
* **Order and limits.** Per dialogue the first uncached criterion is awaited alone, then the rest
  run at once, so they read the prompt cache the first call wrote (C's request). Dialogues run
  concurrently; one semaphore per job (`settings.max_parallel_calls`) bounds the model calls in
  flight across the whole job.
* **Failures.** A criterion call is retried once, except on ModelKeyMissing or a non-retryable
  JudgmentFailed. A dialogue whose criterion still fails, or whose answer is invalid, ends
  `failed` with a short error code; the others carry on. `retry_job` re-runs the failed items.
  An item's error is never an exception's own text (it may carry a URL): it is C's
  `JudgmentFailed.reason`, `validation:<code>`, `scoring:<code>` or the exception's class name.
* **Recovery.** `recover_interrupted` (at startup) fails the items a dead process left queued or
  running, with the error "interrupted"; a retry completes them.

Database work runs in short synchronous transactions off the event loop (asyncio.to_thread); no
connection is held across an await.
"""

import asyncio
import logging
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import TypeAdapter

from app import store
from app.errors import ApiError
from app.evaluator_port import (
    EvaluatorPort,
    find_evaluator,
    get_evaluator,
    judgment_failed_class,
    model_key_missing_class,
    reset_evaluator,
    set_evaluator,
)
from app.models import (
    Answer,
    ChecklistVersion,
    Conversation,
    Criterion,
    CriterionResult,
    Evaluation,
    GrossError,
    Job,
    JobItem,
    Judgment,
    Role,
)
from app.scoring import ScoringError, score, validate_answer
from app.settings import get_settings
from app.transcript import transcript_hash

__all__ = [
    "RunPlan",
    "carry_forward",
    "plan_run",
    "recover_interrupted",
    "reset_evaluator",
    "retry_job",
    "run_job",
    "set_evaluator",
    "shutdown",
    "start_job",
    "wait_for_job",
]

logger = logging.getLogger(__name__)

Mode = Literal["reuse", "full"]

RETRY_DELAY_SECONDS = 1.0  # pause before the one retry of a failed criterion call
_MAX_ERROR_LENGTH = 200
_ANSWER = TypeAdapter(Answer)


# --- planning ------------------------------------------------------------------------------


@dataclass
class RunPlan:
    total: int  # conversations
    model_calls: int
    reused: int
    work: list[tuple[str, str, str]] = field(default_factory=list)  # (conversation, criterion_id, reuse_key) to call


def model_for(criterion: Criterion) -> str:
    return criterion.model or get_settings().default_model


def _unique(ids: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(ids))


def _not_found(message: str) -> ApiError:
    return ApiError(404, "not_found", message)


def load_version(checklist_id: str, version: int) -> ChecklistVersion:
    found = store.get_checklist_version(checklist_id, version)
    if found is None:
        raise _not_found(f"No version {version} of checklist {checklist_id!r}.")
    return found


def _load_conversations(ids: list[str]) -> list[Conversation]:
    """Every conversation, in order; ApiError 404 naming the unknown ones before anything else."""
    found = {conversation: store.get_conversation(conversation) for conversation in ids}
    missing = [conversation for conversation, conv in found.items() if conv is None]
    if missing:
        shown = ", ".join(repr(m) for m in missing[:3]) + (" ..." if len(missing) > 3 else "")
        raise _not_found(f"No conversation {shown}.")
    return [conv for conv in found.values() if conv is not None]


def plan_run(
    conversations: list[str],
    version: ChecklistVersion,
    mode: Mode,
    evaluator: EvaluatorPort | None = None,
) -> RunPlan:
    """What applying `version` to `conversations` would cost: per conversation and criterion, a
    reuse when its key is cached (and the mode is `reuse`), else a model call. `total` is the
    number of conversations. Blocking (database reads): call it off the event loop.

    Raises ApiError 404 for an unknown conversation and 503 when there is no evaluator."""
    evaluator = evaluator or get_evaluator()
    convs = _load_conversations(_unique(conversations))
    keyed = [
        (conv.id, c.id, evaluator.reuse_key(conv, version, c, model_for(c)))
        for conv in convs
        for c in version.criteria
    ]
    cached = store.get_judgments([key for _, _, key in keyed]) if mode == "reuse" else {}
    work = [entry for entry in keyed if entry[2] not in cached]
    return RunPlan(total=len(convs), model_calls=len(work), reused=len(keyed) - len(work), work=work)


def _require_key_for(plan: RunPlan) -> None:
    if plan.model_calls > 0 and not get_settings().model_key_configured:
        raise ApiError(
            409,
            "model_key_missing",
            f"This needs {plan.model_calls} new model call(s) and no model key is configured "
            "(set ANTHROPIC_API_KEY). Results that are already stored can still be reused.",
        )


# --- starting, retrying, recovering --------------------------------------------------------


def _now() -> datetime:
    return datetime.now(UTC)


def _new_id() -> str:
    return uuid.uuid4().hex


async def start_job(
    conversations: list[str], checklist_id: str, version: int, mode: Mode, role: Role
) -> Job:
    """Create a job with one queued evaluation per conversation and start running it.

    Errors, before anything is stored: 422 for no conversations, 404 for an unknown checklist
    version or conversation, 503 without an evaluator, 409 `model_key_missing` when the run needs
    model calls and no key is configured."""
    ids = _unique(conversations)
    if not ids:
        raise ApiError(422, "invalid_request", "conversations: at least one conversation is needed.")
    checklist = await asyncio.to_thread(load_version, checklist_id, version)
    plan = await asyncio.to_thread(plan_run, ids, checklist, mode)
    _require_key_for(plan)

    created = _now()
    evaluations = [
        Evaluation(
            id=_new_id(), created_at=created, conversation=conversation,
            checklist_id=checklist_id, version=version, status="queued",
        )  # fmt: skip
        for conversation in ids
    ]
    job = Job(
        id=_new_id(),
        created_at=created,
        status="queued",
        mode=mode,
        total=len(ids),
        done=0,
        failed=0,
        items=[
            JobItem(conversation=ev.conversation, status="queued", evaluation_id=ev.id)
            for ev in evaluations
        ],
    )
    job = await asyncio.to_thread(store.create_job, job, evaluations, checklist_id, version, role)
    logger.info(
        "Job %s started by %s: %d conversation(s), %s:%d, mode %s, %d call(s), %d reused",
        job.id, role, job.total, checklist_id, version, mode, plan.model_calls, plan.reused,
    )  # fmt: skip
    _schedule(job.id, ids)
    return job


async def dry_run(
    conversations: list[str], checklist_id: str, version: int, mode: Mode
) -> RunPlan:
    """The plan of a run, starting nothing. Same 404/422/503 errors as `start_job`; never 409."""
    ids = _unique(conversations)
    if not ids:
        raise ApiError(422, "invalid_request", "conversations: at least one conversation is needed.")
    checklist = await asyncio.to_thread(load_version, checklist_id, version)
    return await asyncio.to_thread(plan_run, ids, checklist, mode)


async def retry_job(job_id: str, role: Role | None = None) -> Job:
    """Re-run the job's failed items (and only those). A job with nothing failed is returned as
    it is. 404 for an unknown job, 409 `model_key_missing` when the failed items need model calls
    and no key is configured (nothing is reset then)."""
    job = await asyncio.to_thread(store.get_job, job_id)
    context = await asyncio.to_thread(store.get_job_checklist, job_id)
    if job is None or context is None:
        raise _not_found(f"No job {job_id!r}.")
    failed = [item.conversation for item in job.items if item.status == "failed"]
    if not failed:
        return job
    checklist_id, version, _ = context
    checklist = await asyncio.to_thread(load_version, checklist_id, version)
    plan = await asyncio.to_thread(plan_run, failed, checklist, job.mode)
    _require_key_for(plan)

    reset = await asyncio.to_thread(store.requeue_failed_items, job_id, failed)
    if reset:
        logger.info("Job %s: %d failed item(s) retried by %s", job_id, len(reset), role)
        _schedule(job_id, reset)
    refreshed = await asyncio.to_thread(store.get_job, job_id)
    assert refreshed is not None  # jobs are never deleted
    return refreshed


def recover_interrupted() -> None:
    """At startup: items a previous process left queued or running become failed ("interrupted"),
    and so do their evaluations. A retry completes them."""
    changed = store.fail_interrupted()
    if changed:
        logger.warning("Marked %d interrupted job item(s) as failed; retry their jobs to finish them", changed)


# --- background tasks ----------------------------------------------------------------------

# Runs in flight, by job id. The event loop only holds tasks weakly, so this keeps them alive; it
# also lets tests (and shutdown) wait for them. One semaphore per job, shared by every run of it
# (a retry while the first run is still going stays under the same limit).
_tasks: dict[str, set[asyncio.Task[None]]] = {}
_semaphores: dict[str, asyncio.Semaphore] = {}


def _schedule(job_id: str, conversations: list[str]) -> None:
    task = asyncio.get_running_loop().create_task(run_job(job_id, conversations))
    _tasks.setdefault(job_id, set()).add(task)
    task.add_done_callback(lambda done: _forget(job_id, done))


def _forget(job_id: str, task: asyncio.Task[None]) -> None:
    running = _tasks.get(job_id)
    if running is None:
        return
    running.discard(task)
    if not running:
        del _tasks[job_id]
        _semaphores.pop(job_id, None)
    if not task.cancelled() and task.exception() is not None:
        # run_job handles every failure itself; reaching here is a bug. Type only, as everywhere.
        logger.error("Job %s run ended with %s", job_id, type(task.exception()).__name__)


def _semaphore(job_id: str) -> asyncio.Semaphore:
    if job_id not in _semaphores:
        _semaphores[job_id] = asyncio.Semaphore(max(1, get_settings().max_parallel_calls))
    return _semaphores[job_id]


async def wait_for_job(job_id: str) -> None:
    """Return once no run of this job is in flight (also the ones a retry starts meanwhile)."""
    while running := [t for t in _tasks.get(job_id, ()) if not t.done()]:
        await asyncio.gather(*running, return_exceptions=True)


async def shutdown() -> None:
    """Cancel the runs of this event loop and wait for them. Their items stay `running` in the
    database and the next startup marks them interrupted."""
    loop = asyncio.get_running_loop()
    mine = [t for tasks in _tasks.values() for t in tasks if t.get_loop() is loop and not t.done()]
    for task in mine:
        task.cancel()
    if mine:
        await asyncio.gather(*mine, return_exceptions=True)


# --- running -------------------------------------------------------------------------------


class _ItemFailed(Exception):
    def __init__(self, error: str) -> None:
        super().__init__(error)
        self.error = error


def _short(text: str) -> str:
    return text[:_MAX_ERROR_LENGTH]


async def run_job(job_id: str, conversations: list[str] | None = None) -> None:
    """Run the job's queued items among `conversations` (all queued items when None). Each item is
    claimed first (queued -> running), so an item is never run twice. Never raises for a failing
    item: it ends `failed` and the others carry on."""
    job = await asyncio.to_thread(store.get_job, job_id)
    context = await asyncio.to_thread(store.get_job_checklist, job_id)
    if job is None or context is None:
        return
    if conversations is None:
        conversations = [item.conversation for item in job.items if item.status == "queued"]
    checklist_id, version_number, _ = context
    version = await asyncio.to_thread(store.get_checklist_version, checklist_id, version_number)
    evaluator = find_evaluator()
    semaphore = _semaphore(job_id)
    # _run_item handles its own failures; return_exceptions keeps one database error from
    # abandoning the other items' results.
    await asyncio.gather(
        *(
            _run_item(job_id, conversation, version, job.mode, evaluator, semaphore)
            for conversation in _unique(conversations)
        ),
        return_exceptions=True,
    )


async def _run_item(
    job_id: str,
    conversation: str,
    version: ChecklistVersion | None,
    mode: Mode,
    evaluator: EvaluatorPort | None,
    semaphore: asyncio.Semaphore,
) -> None:
    evaluation_id = await asyncio.to_thread(store.start_item, job_id, conversation)
    if evaluation_id is None:
        return  # not queued: another run has it
    evaluation: Evaluation | None = None
    evaluated_hash: str | None = None
    error: str | None = None
    try:
        if version is None:
            raise _ItemFailed("checklist_not_found")
        if evaluator is None:
            raise _ItemFailed("evaluator_unavailable")
        evaluation, evaluated_hash = await _evaluate(
            evaluation_id, conversation, version, mode, evaluator, semaphore
        )
    except _ItemFailed as failure:
        error = failure.error
    except Exception as exc:
        error = type(exc).__name__
        logger.error("Evaluation of %s in job %s failed: %s", conversation, job_id, error)
    try:
        await asyncio.to_thread(store.finish_item, job_id, conversation, evaluation=evaluation, error=error)
        if evaluation is not None and error is None and evaluated_hash is not None:
            await asyncio.to_thread(store.mark_conversation_evaluated, conversation, evaluated_hash)
    except Exception as exc:
        # The item stays `running` until the next startup marks it interrupted.
        logger.error("Could not store the outcome of %s in job %s: %s", conversation, job_id, type(exc).__name__)


@dataclass
class _Judged:
    judgment: Judgment | None = None
    error: str | None = None
    reused: bool = False
    cost: Decimal = Decimal(0)


async def _evaluate(
    evaluation_id: str,
    conversation: str,
    version: ChecklistVersion,
    mode: Mode,
    evaluator: EvaluatorPort,
    semaphore: asyncio.Semaphore,
) -> tuple[Evaluation, str]:
    """One conversation against one checklist version: the done Evaluation and the hash of the
    transcript it graded. Raises _ItemFailed with the item's error."""
    conv = await asyncio.to_thread(store.get_conversation, conversation)
    if conv is None:
        raise _ItemFailed("conversation_not_found")
    evaluated_hash = transcript_hash(conv.transcript)

    keys = {c.id: evaluator.reuse_key(conv, version, c, model_for(c)) for c in version.criteria}
    cached = await asyncio.to_thread(store.get_judgments, list(keys.values())) if mode == "reuse" else {}
    judged: dict[str, _Judged] = {}
    pending: list[Criterion] = []
    for c in version.criteria:
        hit = cached.get(keys[c.id])
        if hit is not None and validate_answer(c, hit.answer) is None:
            # The key covers what the criterion asks, not its id: a renamed copy reuses it too.
            judgment = hit.model_copy(update={"criterion_id": c.id, "reuse_key": keys[c.id], "calls": []})
            judged[c.id] = _Judged(judgment=judgment, reused=True)
        else:
            pending.append(c)

    async def judge(c: Criterion) -> None:
        judged[c.id] = await _judge(evaluator, semaphore, conv, version, c, keys[c.id])

    wants_info = conv.info is None and get_settings().model_key_configured
    info_cost = Decimal(0)

    async def info() -> None:
        nonlocal info_cost
        info_cost = await _dialog_info(evaluator, semaphore, conv, evaluated_hash)

    if pending:
        await judge(pending[0])  # alone: the rest then read the prompt cache it wrote
    rest = [judge(c) for c in pending[1:]]
    if wants_info:
        rest.append(info())
    await asyncio.gather(*rest)

    for c in version.criteria:  # the first failure in checklist order names the item's error
        if judged[c.id].error is not None:
            raise _ItemFailed(judged[c.id].error)

    carries = await asyncio.to_thread(carry_forward, conversation, evaluated_hash, version)
    cost = sum((j.cost for j in judged.values()), Decimal(0)) + info_cost
    base = await asyncio.to_thread(store.get_evaluation, evaluation_id)
    if base is None:
        raise _ItemFailed("evaluation_not_found")
    evaluation = build_evaluation(
        base, version, {cid: j.judgment for cid, j in judged.items()},  # type: ignore[misc]
        reused={cid for cid, j in judged.items() if j.reused}, carries=carries, cost=cost,
    )  # fmt: skip
    return evaluation, evaluated_hash


async def _judge(
    evaluator: EvaluatorPort,
    semaphore: asyncio.Semaphore,
    conv: Conversation,
    version: ChecklistVersion,
    c: Criterion,
    key: str,
) -> _Judged:
    """One criterion call with the retry policy; a valid judgment is cached."""
    model_key_missing = model_key_missing_class(evaluator)
    judgment_failed = judgment_failed_class(evaluator)
    judgment: Judgment | None = None
    for attempt in (1, 2):
        try:
            async with semaphore:
                judgment = await evaluator.judge_criterion(conv, version, c, model=model_for(c))
            break
        except model_key_missing:
            return _Judged(error="model_key_missing")
        except judgment_failed as exc:
            reason = getattr(exc, "reason", None)
            error = _short(reason) if isinstance(reason, str) and reason else type(exc).__name__
            if not getattr(exc, "retryable", False) or attempt == 2:
                return _Judged(error=error)
        except Exception as exc:
            if attempt == 2:
                return _Judged(error=type(exc).__name__)
        await asyncio.sleep(RETRY_DELAY_SECONDS)
    assert judgment is not None

    judgment = judgment.model_copy(update={"criterion_id": c.id, "reuse_key": key})
    code = validate_answer(c, judgment.answer)
    cost = sum((call.cost_usd for call in judgment.calls), Decimal(0))
    if code is not None:
        return _Judged(error=f"validation:{code}", cost=cost)
    await asyncio.to_thread(store.save_judgment, judgment)
    return _Judged(judgment=judgment, cost=cost)


async def _dialog_info(
    evaluator: EvaluatorPort, semaphore: asyncio.Semaphore, conv: Conversation, evaluated_hash: str
) -> Decimal:
    """Ask for the dialogue info once and store it. A failure is logged (type only) and ignored.
    Returns the cost of the call."""
    try:
        async with semaphore:
            info, calls = await evaluator.dialog_info(conv)
        await asyncio.to_thread(store.update_conversation_info, conv.id, info, evaluated_hash)
        return sum((call.cost_usd for call in calls), Decimal(0))
    except Exception as exc:
        logger.warning("Dialogue info for %s failed: %s", conv.id, type(exc).__name__)
        return Decimal(0)


# --- building the evaluation ---------------------------------------------------------------


def carry_forward(conversation: str, transcript_hash: str, version: ChecklistVersion) -> dict[str, dict]:
    """Reviewer decisions carried from earlier evaluations of this transcript, by criterion id:
    `{"appeal_id", "evaluation_id", "answer", "kinds"}`. A stub until appeals exist (#12)."""
    return {}


def _scored(version: ChecklistVersion, answers: dict[str, tuple[Any, list[str]]]):
    try:
        return score(version, answers)
    except ScoringError as exc:
        raise _ItemFailed(f"scoring:{exc.code}") from None


def build_evaluation(
    base: Evaluation,
    version: ChecklistVersion,
    judgments: dict[str, Judgment],
    *,
    reused: set[str],
    carries: dict[str, dict],
    cost: Decimal,
) -> Evaluation:
    """The done evaluation: one result per criterion in checklist order. `original_total` comes
    from the model's answers; `final_answer`, points, sections, `final_total` and the gross-error
    flag from the final answers (a carried decision's answer, else the model's)."""
    model_answers = {cid: (j.answer, list(j.kinds)) for cid, j in judgments.items()}
    original = _scored(version, model_answers)

    criteria = {c.id: c for c in version.criteria}
    final_answers = dict(model_answers)
    carried: dict[str, dict] = {}
    for cid, carry in carries.items():
        criterion = criteria.get(cid)
        if criterion is None:
            continue
        answer = _ANSWER.validate_python(carry["answer"])
        if validate_answer(criterion, answer) is not None:
            continue
        final_answers[cid] = (answer, list(carry.get("kinds") or []))
        carried[cid] = {"appeal_id": carry["appeal_id"], "evaluation_id": carry["evaluation_id"]}
    final = _scored(version, final_answers) if carried else original

    results: list[CriterionResult] = []
    for c in version.criteria:
        judgment = judgments[c.id]
        points, effective_weight = final.results[c.id]
        results.append(
            CriterionResult.model_validate(
                {
                    **judgment.model_dump(),
                    "final_answer": final_answers[c.id][0],
                    "points": points,
                    "effective_weight": effective_weight,
                    "reused": c.id in reused,
                    "carried_decision": carried.get(c.id),
                }
            )
        )

    by_id = {r.criterion_id: r for r in results}
    gross = [c.id for c in version.criteria if c.kind == "gross_error"]
    flagged = [cid for cid in gross if final_answers[cid][0] == "yes"]
    source = by_id[(flagged or gross)[0]] if gross else None
    gross_error = GrossError(
        flag=final.gross_error.flag,
        kinds=final.gross_error.kinds,
        explanation=source.explanation if source else None,
        evidence=source.evidence if source else [],
    )

    models = {j.model for j in judgments.values()}
    return base.model_copy(
        update={
            "status": "done",
            "source": "model",
            "model": next(iter(models)) if len(models) == 1 else ("mixed" if models else None),
            "cost_usd": cost,
            "results": results,
            "original_total": original.total,
            "final_total": final.total,
            "sections": final.sections,
            "gross_error": gross_error,
        }
    )
