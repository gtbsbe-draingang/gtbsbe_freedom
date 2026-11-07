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
  concurrently; one process-wide semaphore (`settings.max_parallel_calls`) bounds the model calls
  in flight across all jobs. If the first call fails with ModelKeyMissing or a non-retryable
  JudgmentFailed, the rest are not launched; otherwise every sibling call finishes before the
  dialogue is resolved.
* **Failures.** A criterion call is retried once, except on ModelKeyMissing or a non-retryable
  JudgmentFailed. A dialogue whose criterion still fails, or whose answer is invalid, ends
  `failed` with a short error code; the others carry on. A store failure never leaves an item
  stuck for good: `retry_job` re-runs failed items and queued or running ones no run of this
  process owns, and records who retried in the job's `retries`. Retries of one job run one at a
  time (a per-job lock), so two at once (a double click) never run an item twice.
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
import weakref
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal

from app import store
from app.appeals import apply_decisions, carried_decisions, carry_forward
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
    ChecklistVersion,
    Conversation,
    Criterion,
    CriterionResult,
    Evaluation,
    Job,
    JobItem,
    Judgment,
    Role,
)
from app.scoring import ScoringError, validate_answer
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

    A cached judgment counts as reused only when its answer is valid for the current criterion,
    the same test the run applies (`_reusable`), so the estimate and the keyless 409 match the run.

    Raises ApiError 404 for an unknown conversation (checked first) and 503 when there is no
    evaluator."""
    convs = _load_conversations(_unique(conversations))
    evaluator = evaluator or get_evaluator()
    keyed = [
        (conv.id, c, evaluator.reuse_key(conv, version, c, model_for(c)))
        for conv in convs
        for c in version.criteria
    ]
    cached = store.get_judgments([key for _, _, key in keyed]) if mode == "reuse" else {}
    work = [
        (conversation, c.id, key)
        for conversation, c, key in keyed
        if _reusable(c, cached.get(key)) is None
    ]
    return RunPlan(total=len(convs), model_calls=len(work), reused=len(keyed) - len(work), work=work)


def _reusable(c: Criterion, cached: Judgment | None) -> Judgment | None:
    """A cached judgment usable for `c`: its answer must fit the criterion. The key covers what the
    criterion asks, not its id, so a renamed copy reuses it too, under its own id."""
    if cached is None or validate_answer(c, cached.answer) is not None:
        return None
    return cached.model_copy(update={"criterion_id": c.id, "calls": []})


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


@asynccontextmanager
async def _one_retry_at_a_time(job_id: str) -> AsyncIterator[None]:
    """Hold the job's retry lock. Without it, a second retry could check ownership before the
    first scheduled its run, then requeue an item that run had already claimed: run twice. The
    lock lives while someone holds or waits for it, one table per event loop (asyncio locks belong
    to one loop; tests run several)."""
    locks = _retry_locks.setdefault(asyncio.get_running_loop(), {})
    entry = locks.get(job_id)
    if entry is None:
        entry = locks[job_id] = _RetryLock()
    entry.users += 1
    try:
        async with entry.lock:
            yield
    finally:
        entry.users -= 1
        if entry.users == 0:
            del locks[job_id]


async def retry_job(job_id: str, role: Role) -> Job:
    """Re-run the job's unfinished items: the failed ones, and queued or running ones that no run
    of this process owns (left behind by a store failure). Done items are never re-run. A job with
    nothing to retry is returned as it is. The retry is recorded in the job's `retries` with
    `role`. 404 for an unknown job, 409 `model_key_missing` when those items need model calls and
    no key is configured (nothing is reset then). Retries of one job run one after the other: the
    second sees the items the first scheduled as owned, and leaves them alone."""
    async with _one_retry_at_a_time(job_id):
        return await _retry(job_id, role)


async def _retry(job_id: str, role: Role) -> Job:
    job = await asyncio.to_thread(store.get_job, job_id)
    context = await asyncio.to_thread(store.get_job_checklist, job_id)
    if job is None or context is None:
        raise _not_found(f"No job {job_id!r}.")
    owned = _owned_items(job_id)
    candidates = [
        item.conversation
        for item in job.items
        if item.status == "failed" or (item.status in ("queued", "running") and item.conversation not in owned)
    ]
    if not candidates:
        return job
    checklist_id, version, _ = context
    checklist = await asyncio.to_thread(load_version, checklist_id, version)
    plan = await asyncio.to_thread(plan_run, candidates, checklist, job.mode)
    _require_key_for(plan)

    # Ownership is read again: a run scheduled while we were planning keeps its items.
    owned = _owned_items(job_id)
    candidates = [conversation for conversation in candidates if conversation not in owned]
    reset = await asyncio.to_thread(store.requeue_items, job_id, candidates, role)
    if reset:
        logger.info("Job %s: %d item(s) retried by %s", job_id, len(reset), role)
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
# also lets tests (and shutdown) wait for them. `_remaining` holds, per run, the items it has not
# finished yet: the items "owned" by this process, which a retry must not reset.
_tasks: dict[str, set[asyncio.Task[None]]] = {}
_remaining: dict[asyncio.Task[None], set[str]] = {}

# One semaphore for all jobs: model calls in flight across the whole process stay under
# settings.max_parallel_calls. An asyncio primitive belongs to one event loop, so there is one per
# running loop (tests run several), created lazily and dropped with its loop.
_semaphores: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]" = (
    weakref.WeakKeyDictionary()
)


@dataclass
class _RetryLock:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    users: int = 0  # holding or waiting; the entry is dropped when it reaches 0


# Per event loop, by job id: the lock `retry_job` holds (see `_one_retry_at_a_time`).
_retry_locks: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[str, _RetryLock]]" = (
    weakref.WeakKeyDictionary()
)


def _schedule(job_id: str, conversations: list[str]) -> None:
    task = asyncio.get_running_loop().create_task(run_job(job_id, conversations))
    _tasks.setdefault(job_id, set()).add(task)
    _remaining[task] = set(conversations)
    task.add_done_callback(lambda done: _forget(job_id, done))


def _forget(job_id: str, task: asyncio.Task[None]) -> None:
    _remaining.pop(task, None)
    running = _tasks.get(job_id)
    if running is not None:
        running.discard(task)
        if not running:
            del _tasks[job_id]
    if not task.cancelled() and task.exception() is not None:
        # run_job handles every failure itself; reaching here is a bug. Type only, as everywhere.
        logger.error("Job %s run ended with %s", job_id, type(task.exception()).__name__)


def _owned_items(job_id: str) -> set[str]:
    """The job's items that a run of this process still has to finish."""
    owned: set[str] = set()
    for task in _tasks.get(job_id, ()):
        if not task.done():
            owned |= _remaining.get(task, set())
    return owned


def _semaphore() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    semaphore = _semaphores.get(loop)
    if semaphore is None:
        semaphore = _semaphores[loop] = asyncio.Semaphore(max(1, get_settings().max_parallel_calls))
    return semaphore


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
    semaphore = _semaphore()
    remaining = _remaining.get(asyncio.current_task(), set())  # type: ignore[arg-type]
    items = _unique(conversations)
    outcomes = await asyncio.gather(
        *(
            _run_item(job_id, conversation, version, job.mode, evaluator, semaphore, remaining)
            for conversation in items
        ),
        return_exceptions=True,
    )
    for conversation, outcome in zip(items, outcomes, strict=True):
        if isinstance(outcome, BaseException):  # _run_item catches everything: a bug if reached
            logger.error("Item %s of job %s ended with %s", conversation, job_id, type(outcome).__name__)


async def _run_item(
    job_id: str,
    conversation: str,
    version: ChecklistVersion | None,
    mode: Mode,
    evaluator: EvaluatorPort | None,
    semaphore: asyncio.Semaphore,
    remaining: set[str],
) -> None:
    try:
        await _run_claimed_item(job_id, conversation, version, mode, evaluator, semaphore)
    finally:
        remaining.discard(conversation)  # no longer owned: a retry may reset it


async def _run_claimed_item(
    job_id: str,
    conversation: str,
    version: ChecklistVersion | None,
    mode: Mode,
    evaluator: EvaluatorPort | None,
    semaphore: asyncio.Semaphore,
) -> None:
    try:
        evaluation_id = await asyncio.to_thread(store.start_item, job_id, conversation)
    except Exception as exc:
        # The item stays queued and unowned: POST /jobs/{id}/retry picks it up.
        logger.error("Could not start %s in job %s: %s", conversation, job_id, type(exc).__name__)
        return
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
    except Exception as exc:
        logger.error("Could not store the outcome of %s in job %s: %s", conversation, job_id, type(exc).__name__)
        try:
            await asyncio.to_thread(store.finish_item, job_id, conversation, error="store_failed")
        except Exception as again:
            # Left `running` and unowned: a retry (or the next startup) resets it.
            logger.error("Could not mark %s in job %s failed: %s", conversation, job_id, type(again).__name__)
        return
    if evaluation is not None and error is None and evaluated_hash is not None:
        try:
            await asyncio.to_thread(store.mark_conversation_evaluated, conversation, evaluated_hash)
        except Exception as exc:
            logger.error("Could not update the status of %s: %s", conversation, type(exc).__name__)


@dataclass
class _Judged:
    judgment: Judgment | None = None
    error: str | None = None
    reused: bool = False
    cost: Decimal = Decimal(0)
    fatal: bool = False  # no point in calling the other criteria (no key, or a final refusal)


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
        reusable = _reusable(c, cached.get(keys[c.id]))
        if reusable is not None:
            judged[c.id] = _Judged(judgment=reusable.model_copy(update={"reuse_key": keys[c.id]}), reused=True)
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
        first = judged[pending[0].id]
        if first.fatal:
            raise _ItemFailed(first.error or "failed")  # the rest would fail the same way
    rest = [judge(c) for c in pending[1:]]
    if wants_info:
        rest.append(info())
    # Every sibling call finishes before the item is resolved: no call outlives its item.
    outcomes = await asyncio.gather(*rest, return_exceptions=True)
    unexpected = next((o for o in outcomes if isinstance(o, BaseException)), None)
    if unexpected is not None:
        if not isinstance(unexpected, Exception):
            raise unexpected  # cancellation and the like are not an item failure
        raise _ItemFailed(type(unexpected).__name__)

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
        graded_hash=evaluated_hash,
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
            return _Judged(error="model_key_missing", fatal=True)
        except judgment_failed as exc:
            reason = getattr(exc, "reason", None)
            error = _short(reason) if isinstance(reason, str) and reason else type(exc).__name__
            retryable = bool(getattr(exc, "retryable", False))
            if not retryable or attempt == 2:
                return _Judged(error=error, fatal=not retryable)
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


def build_evaluation(
    base: Evaluation,
    version: ChecklistVersion,
    judgments: dict[str, Judgment],
    *,
    reused: set[str],
    carries: dict[str, dict],
    cost: Decimal,
    graded_hash: str | None = None,
) -> Evaluation:
    """The done evaluation: one result per criterion in checklist order, marked with the decision
    carried into it (`carries`, from `appeals.carry_forward`) where there is one. The totals,
    points, sections and gross-error flag come from `appeals.apply_decisions`, the code path a
    reviewer's decision takes too: `original_total` from the model's answers, the rest from the
    final answers (a carried decision's answer, else the model's)."""
    carried, markers = carried_decisions(version, carries)  # by appeal id; by criterion id
    results = [
        CriterionResult.model_validate(
            {
                **judgments[c.id].model_dump(),
                "final_answer": judgments[c.id].answer,
                "points": None,
                "effective_weight": None,
                "reused": c.id in reused,
                "carried_decision": markers.get(c.id),
            }
        )
        for c in version.criteria
    ]
    models = {j.model for j in judgments.values()}
    draft = base.model_copy(
        update={
            "status": "done",
            "source": "model",
            "model": next(iter(models)) if len(models) == 1 else ("mixed" if models else None),
            "cost_usd": cost,
            "results": results,
            "transcript_hash": graded_hash,
        }
    )
    try:
        return apply_decisions(draft, version, own={}, carried=carried)
    except ScoringError as exc:
        raise _ItemFailed(f"scoring:{exc.code}") from None
