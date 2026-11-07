"""Appeals, reviewer decisions, the second opinion and carry-forward (system design 10; front-end
design sections 6 and 7).

* **Filing** (`file_appeal`): a controller disputes one criterion of a done evaluation. At most
  one open appeal per criterion per evaluation (the database enforces it). Filing never needs a
  model key and never waits for the model: the second opinion is asked for in the background and
  the UI polls `GET /appeals/{id}`. The conversation becomes `disputed` when the appealed
  evaluation graded its current transcript (after a re-import it stays `new`); only appeals on the
  current transcript keep it disputed.
* **Second opinion**: `unavailable` without a key or an evaluator; otherwise `pending` until a
  background task stores C's `second_opinion` (`done`) or fails (`unavailable`). Failures are
  logged by exception class only (an exception's text may carry a URL).
* **Deciding** (`decide`): a reviewer confirms or changes the answer, with a reason. A
  confirmation keeps the score that was under appeal: it stores the evaluation's final answer (and
  gross-error kinds) at that moment, which is a carried or an earlier decision's when there is one,
  else the model's. The appeal, the recalculated evaluation and the conversation's status are
  written in one transaction.
* **Final answers** (`final_answers`, `recompute`): per result, the evaluation's own decided
  appeal, else its carried decision, else the model's answer. `original_total` always comes from
  the model's answers; `final_total`, points, effective weights, sections and the gross-error flag
  from the final answers. Jobs build every evaluation through `apply_decisions` too, so a job and
  a decision compute the final values the same way.
* **Carry-forward** (`carry_forward`): a later evaluation of the same transcript takes over the
  latest decided answer for each criterion whose fingerprint is unchanged (a weight-only change
  keeps the fingerprint; a reworded or replaced criterion does not). It is applied when an
  evaluation is built, and again when a decision is made: every later `done` evaluation of the same
  conversation and transcript (any checklist) whose criterion has the appealed fingerprint takes
  the new decision and is recomputed in the decision's transaction, so an evaluation made while
  the appeal was open shows it too. An evaluation's own decision still outranks a carried one.
"""

import asyncio
import logging
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal

from app import store
from app.errors import ApiError
from app.evaluator_port import find_evaluator
from pydantic import TypeAdapter

from app.models import (
    Answer,
    Appeal,
    ChecklistVersion,
    Criterion,
    CriterionResult,
    Decision,
    Evaluation,
    GrossError,
    Role,
    SecondOpinion,
)
from app.scoring import ScoringError, score, validate_answer
from app.settings import get_settings

__all__ = [
    "apply_decisions",
    "carried_decisions",
    "carry_forward",
    "decide",
    "file_appeal",
    "final_answers",
    "recompute",
    "recover_pending",
    "shutdown",
    "wait_for_second_opinions",
]

logger = logging.getLogger(__name__)

Final = tuple[Answer, list[str]]  # (answer, gross-error kinds), what score() takes per criterion
Outcome = Literal["confirmed", "changed"]

_ANSWER = TypeAdapter(Answer)


def _now() -> datetime:
    return datetime.now(UTC)


def _not_found(message: str) -> ApiError:
    return ApiError(404, "not_found", message)


def _role_not_allowed(action: str, needed: Role) -> ApiError:
    return ApiError(403, "role_not_allowed", f"Only the {needed} role can {action}.")


# --- final answers and recomputation -------------------------------------------------------


def _decided(appeal: Appeal) -> Final:
    assert appeal.decision is not None
    return appeal.decision.answer, list(appeal.decision.kinds)


def _carried_appeal_id(result: CriterionResult) -> str | None:
    carried = result.carried_decision or {}
    appeal_id = carried.get("appeal_id")
    return appeal_id if isinstance(appeal_id, str) and appeal_id else None


def _final_answers(evaluation: Evaluation, own: dict[str, Final], carried: dict[str, Final]) -> dict[str, Final]:
    """Per result, the first that applies: the evaluation's own decided appeal (`own`, by
    criterion id), its carried decision (`carried`, by appeal id), the model's answer."""
    finals: dict[str, Final] = {}
    for result in evaluation.results:
        appeal_id = _carried_appeal_id(result)
        if result.criterion_id in own:
            finals[result.criterion_id] = own[result.criterion_id]
        elif appeal_id is not None and appeal_id in carried:
            finals[result.criterion_id] = carried[appeal_id]
        else:
            finals[result.criterion_id] = (result.answer, list(result.kinds))
    return finals


def _load_decisions(evaluation: Evaluation, conn=None) -> tuple[dict[str, Final], dict[str, Final]]:
    """The evaluation's own decided appeals (by criterion id) and its carried ones (by appeal id),
    in one query; on `conn` when given (inside the caller's transaction)."""
    carried_ids = [aid for r in evaluation.results if (aid := _carried_appeal_id(r)) is not None]
    own, named = store.decided_appeals(evaluation.id, carried_ids, conn=conn)
    return (
        {cid: _decided(appeal) for cid, appeal in own.items()},
        {aid: _decided(appeal) for aid, appeal in named.items()},
    )


def final_answers(evaluation: Evaluation) -> dict[str, Final]:
    """The final (answer, kinds) of every result, by criterion id: the evaluation's own decided
    appeal, else its carried decision, else the model's answer. Also sets each
    `result.final_answer`."""
    own, carried = _load_decisions(evaluation)
    finals = _final_answers(evaluation, own, carried)
    for result in evaluation.results:
        result.final_answer = finals[result.criterion_id][0]
    return finals


def recompute(evaluation: Evaluation, version: ChecklistVersion, *, conn=None) -> Evaluation:
    """The evaluation with its values recomputed from the stored decisions (see `apply_decisions`).
    With `conn`, the decisions are read inside the caller's transaction. Raises ScoringError."""
    own, carried = _load_decisions(evaluation, conn)
    return apply_decisions(evaluation, version, own, carried)


def apply_decisions(
    evaluation: Evaluation,
    version: ChecklistVersion,
    own: dict[str, Final],
    carried: dict[str, Final],
) -> Evaluation:
    """A copy of `evaluation` with `original_total` from the model's answers and, from the final
    answers, every result's `final_answer`, `points` and `effective_weight`, the `final_total`,
    the sections and the gross-error flag (with the explanation and evidence of the flagged
    gross-error result, else of the first one). Pure; raises ScoringError for an answer that
    does not fit `version`."""
    model_answers = {r.criterion_id: (r.answer, list(r.kinds)) for r in evaluation.results}
    original = score(version, model_answers)
    finals = _final_answers(evaluation, own, carried)
    final = score(version, finals)

    results = []
    for result in evaluation.results:
        points, effective_weight = final.results[result.criterion_id]
        results.append(
            result.model_copy(
                update={
                    "final_answer": finals[result.criterion_id][0],
                    "points": points,
                    "effective_weight": effective_weight,
                }
            )
        )

    by_id = {r.criterion_id: r for r in results}
    gross = [c.id for c in version.criteria if c.kind == "gross_error" and c.id in by_id]
    flagged = [cid for cid in gross if finals[cid][0] == "yes"]
    source = by_id[(flagged or gross)[0]] if gross else None
    gross_error = GrossError(
        flag=final.gross_error.flag,
        kinds=final.gross_error.kinds,
        explanation=source.explanation if source else None,
        evidence=source.evidence if source else [],
    )
    return evaluation.model_copy(
        update={
            "results": results,
            "original_total": original.total,
            "final_total": final.total,
            "sections": final.sections,
            "gross_error": gross_error,
        }
    )


# --- carry-forward -------------------------------------------------------------------------


def carry_forward(
    conversation: str, transcript_hash: str, version: ChecklistVersion, *, conn=None
) -> dict[str, dict]:
    """Reviewer decisions to carry into an evaluation of `conversation` with `version`, by
    criterion id: `{"appeal_id", "evaluation_id", "answer", "kinds"}`.

    For each criterion, the most recent decided appeal (by `decided_at`) on an evaluation of this
    conversation whose criterion had the same fingerprint and whose graded transcript had this
    hash. A confirmed decision carries the answer it confirmed. An evaluation being built has no
    appeals of its own yet (appeals need a done evaluation), so every match is on an earlier one.
    Blocking (one database query, on `conn` when given): call it off the event loop."""
    fingerprints = [c.fingerprint for c in version.criteria]
    latest = store.latest_decisions(conversation, transcript_hash, fingerprints, conn=conn)
    carries: dict[str, dict] = {}
    for c in version.criteria:
        appeal = latest.get(c.fingerprint)
        if appeal is None or appeal.decision is None:
            continue
        carries[c.id] = {
            "appeal_id": appeal.id,
            "evaluation_id": appeal.evaluation_id,
            "answer": appeal.decision.answer,
            "kinds": list(appeal.decision.kinds),
        }
    return carries


def carried_decisions(version: ChecklistVersion, carries: dict[str, dict]) -> tuple[dict[str, Final], dict[str, dict]]:
    """`carries` (from `carry_forward`) as what `apply_decisions` takes and what a result records:
    the carried (answer, kinds) by appeal id, and each criterion's `carried_decision` marker
    (`{"appeal_id", "evaluation_id"}`) by criterion id. A carry whose answer does not fit the
    criterion is dropped (the same fingerprint means the same scale, so this is only a safeguard)."""
    criteria = {c.id: c for c in version.criteria}
    carried: dict[str, Final] = {}
    markers: dict[str, dict] = {}
    for cid, carry in carries.items():
        criterion = criteria.get(cid)
        if criterion is None:
            continue
        answer = _ANSWER.validate_python(carry["answer"])
        if validate_answer(criterion, answer) is not None:
            continue
        carried[carry["appeal_id"]] = (answer, list(carry.get("kinds") or []))
        markers[cid] = {"appeal_id": carry["appeal_id"], "evaluation_id": carry["evaluation_id"]}
    return carried, markers


def _carry_into_later(conn, appeal: Appeal, appealed: Evaluation) -> None:
    """Carry a decision just made into the later `done` evaluations of the same conversation and
    graded transcript, of any checklist: each criterion with the appealed fingerprint gets the
    marker `carry_forward` picks now (the most recent decision: this one), and the evaluation is
    recomputed from its stored decisions (`recompute`: its own decision still outranks it). Inside
    the decision's transaction. An evaluation that cannot be recomputed is left as it was."""
    match = store.appeal_match(conn, appeal.id)
    if match is None:
        return
    fingerprint, graded_hash = match
    versions: dict[tuple[str, int], ChecklistVersion | None] = {}
    for later in store.later_done_evaluations(conn, appealed, graded_hash):
        key = (later.checklist_id, later.version)
        if key not in versions:
            versions[key] = store.get_checklist_version(*key)
        version = versions[key]
        if version is None:
            continue
        concerned = {c.id for c in version.criteria if c.fingerprint == fingerprint}
        _, markers = carried_decisions(version, carry_forward(appealed.conversation, graded_hash, version, conn=conn))
        results = [
            r.model_copy(update={"carried_decision": markers[r.criterion_id]})
            if r.criterion_id in concerned and r.criterion_id in markers
            else r
            for r in later.results
        ]
        if results == later.results:
            continue
        try:
            updated = recompute(later.model_copy(update={"results": results}), version, conn=conn)
        except ScoringError as exc:
            logger.warning("Decision %s not carried into evaluation %s: %s", appeal.id, later.id, exc.code)
            continue
        store.write_evaluation(conn, updated)
        logger.info("Decision %s carried into evaluation %s", appeal.id, later.id)


# --- filing --------------------------------------------------------------------------------


def _criterion(version: ChecklistVersion, criterion_id: str) -> Criterion | None:
    return next((c for c in version.criteria if c.id == criterion_id), None)


def _result(evaluation: Evaluation, criterion_id: str) -> CriterionResult | None:
    return next((r for r in evaluation.results if r.criterion_id == criterion_id), None)


def _second_opinion_possible() -> bool:
    return get_settings().model_key_configured and find_evaluator() is not None


def _file(evaluation_id: str, criterion_id: str, comment: str, role: Role) -> Appeal:
    evaluation = store.get_evaluation(evaluation_id)
    if evaluation is None:
        raise _not_found(f"No evaluation {evaluation_id!r}.")
    if role != "controller":
        raise _role_not_allowed("file an appeal", "controller")
    if evaluation.status != "done":
        raise ApiError(409, "evaluation_not_done", "Only a finished evaluation can be appealed.")
    if _result(evaluation, criterion_id) is None:
        raise _not_found(f"Evaluation {evaluation_id!r} has no criterion {criterion_id!r}.")
    version = store.get_checklist_version(evaluation.checklist_id, evaluation.version)
    criterion = None if version is None else _criterion(version, criterion_id)
    if criterion is None:
        raise _not_found(
            f"No criterion {criterion_id!r} in checklist {evaluation.checklist_id!r} v{evaluation.version}."
        )
    graded_hash = evaluation.transcript_hash or store.get_transcript_hash(evaluation.conversation) or ""

    appeal = Appeal(
        id=uuid.uuid4().hex,
        created_at=_now(),
        evaluation_id=evaluation.id,
        conversation=evaluation.conversation,
        criterion_id=criterion_id,
        comment=comment,
        role=role,
        status="open",
        second_opinion=None,
        second_opinion_status="pending" if _second_opinion_possible() else "unavailable",
        decision=None,
    )
    already_open = ApiError(
        409, "appeal_already_open", f"Criterion {criterion_id!r} of this evaluation already has an open appeal."
    )
    try:
        with store.write_transaction() as conn:
            if store.has_open_appeal(conn, evaluation.id, criterion_id):
                raise already_open
            store.insert_appeal(appeal, fingerprint=criterion.fingerprint, transcript_hash=graded_hash, conn=conn)
            store.mark_disputed(conn, evaluation.conversation, graded_hash)
    except store.AppealAlreadyOpen:
        raise already_open from None
    logger.info("Appeal %s filed by %s on %s of evaluation %s", appeal.id, role, criterion_id, evaluation.id)
    return appeal


async def file_appeal(evaluation_id: str, criterion_id: str, comment: str, role: Role) -> Appeal:
    """File an appeal and, when a second opinion is possible, start asking for it.

    Errors: 404 for an unknown evaluation, 403 `role_not_allowed` unless `role` is `controller`,
    409 `evaluation_not_done`, 404 for a criterion the evaluation has no result for, 409
    `appeal_already_open`."""
    appeal = await asyncio.to_thread(_file, evaluation_id, criterion_id, comment, role)
    if appeal.second_opinion_status == "pending":
        _schedule_second_opinion(appeal.id)
    return appeal


# --- the second opinion --------------------------------------------------------------------

# Tasks in flight. The event loop only holds tasks weakly, so this keeps them alive; it also lets
# tests (and shutdown) wait for them.
_tasks: set[asyncio.Task[None]] = set()


class _Unavailable(Exception):
    """The second opinion cannot be asked for (no evaluator, or the data is gone)."""


def _schedule_second_opinion(appeal_id: str) -> None:
    task = asyncio.get_running_loop().create_task(_second_opinion(appeal_id))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


def _context(appeal_id: str):
    appeal = store.get_appeal(appeal_id)
    evaluation = None if appeal is None else store.get_evaluation(appeal.evaluation_id)
    if appeal is None or evaluation is None:
        raise _Unavailable()
    conv = store.get_conversation(evaluation.conversation)
    version = store.get_checklist_version(evaluation.checklist_id, evaluation.version)
    criterion = None if version is None else _criterion(version, appeal.criterion_id)
    result = _result(evaluation, appeal.criterion_id)
    if conv is None or version is None or criterion is None or result is None:
        raise _Unavailable()
    return appeal, conv, version, criterion, result


async def _ask(appeal_id: str) -> SecondOpinion:
    evaluator = find_evaluator()
    if evaluator is None:
        raise _Unavailable()
    appeal, conv, version, criterion, result = await asyncio.to_thread(_context, appeal_id)
    opinion, calls = await evaluator.second_opinion(conv, version, criterion, result, appeal.comment)
    if validate_answer(criterion, opinion.answer) is not None:
        raise _Unavailable()  # an answer the reviewer could not even pick
    cost = sum((call.cost_usd for call in calls), Decimal(0))
    logger.info("Second opinion for appeal %s: %d call(s), $%s", appeal_id, len(calls), cost)
    return opinion


async def _second_opinion(appeal_id: str) -> None:
    opinion: SecondOpinion | None = None
    try:
        opinion = await _ask(appeal_id)
    except Exception as exc:  # cancellation is not caught: the appeal stays pending until startup
        logger.warning("Second opinion for appeal %s failed: %s", appeal_id, type(exc).__name__)
    try:
        await asyncio.to_thread(store.set_second_opinion, appeal_id, opinion)
    except Exception as exc:
        logger.error("Could not store the second opinion of appeal %s: %s", appeal_id, type(exc).__name__)


def _mine() -> list[asyncio.Task[None]]:
    loop = asyncio.get_running_loop()
    return [t for t in _tasks if t.get_loop() is loop and not t.done()]


async def wait_for_second_opinions() -> None:
    """Return once no second opinion of this event loop is being asked for."""
    while running := _mine():
        await asyncio.gather(*running, return_exceptions=True)


async def shutdown() -> None:
    """Cancel the second opinions of this event loop and wait for them. Their appeals stay
    `pending` and the next startup marks them `unavailable`."""
    running = _mine()
    for task in running:
        task.cancel()
    if running:
        await asyncio.gather(*running, return_exceptions=True)


def recover_pending() -> None:
    """At startup: second opinions a previous process left pending become `unavailable`."""
    changed = store.fail_pending_second_opinions()
    if changed:
        logger.warning("Marked %d pending second opinion(s) as unavailable", changed)


# --- deciding ------------------------------------------------------------------------------


def decide(appeal_id: str, outcome: Outcome, answer: Answer | None, reason: str, role: Role) -> Evaluation:
    """Decide an open appeal and return the recalculated evaluation.

    Checked in this order: 404 for an unknown appeal, 403 `role_not_allowed` unless `role` is
    `reviewer`, 409 `appeal_already_decided`, 422 `reason_required` for a blank reason, then for
    `changed` 422 `invalid_request` without an answer or 422 with the `validate_answer` code. For
    `confirmed` the stored answer and kinds are the ones under appeal, the evaluation's final ones
    (a sent answer is ignored). A recalculation that fails is 422 with the scoring code, and
    nothing is stored.

    The decision, the recalculated evaluation, the later evaluations it carries into (see
    `_carry_into_later`) and the conversation's status (`evaluated` once no appeal on its current
    transcript is open) are written in one transaction. Blocking: call it off the event loop."""
    found = store.get_appeal(appeal_id)
    if found is None:
        raise _not_found(f"No appeal {appeal_id!r}.")
    if role != "reviewer":
        raise _role_not_allowed("decide an appeal", "reviewer")
    evaluation = store.get_evaluation(found.evaluation_id)
    version = None if evaluation is None else store.get_checklist_version(evaluation.checklist_id, evaluation.version)
    criterion = None if version is None else _criterion(version, found.criterion_id)
    if version is None or criterion is None:
        raise _not_found(f"The checklist criterion of appeal {appeal_id!r} no longer exists.")

    with store.write_transaction() as conn:
        appeal = store.read_appeal(conn, appeal_id)
        assert appeal is not None  # appeals are never deleted
        if appeal.status != "open":
            raise ApiError(409, "appeal_already_decided", "This appeal has already been decided.")
        if not reason.strip():
            raise ApiError(422, "reason_required", "A decision needs a reason.")
        current = store.read_evaluation(conn, appeal.evaluation_id)
        result = None if current is None else _result(current, appeal.criterion_id)
        if current is None or result is None:
            raise _not_found(f"The evaluation of appeal {appeal_id!r} has no criterion {appeal.criterion_id!r}.")
        if outcome == "confirmed":
            # What was under appeal: the final answer now, a carried or earlier decision included.
            own, carried = _load_decisions(current, conn)
            decided_answer, kinds = _final_answers(current, own, carried)[appeal.criterion_id]
        else:
            if answer is None:
                raise ApiError(422, "invalid_request", "answer: required when the outcome is changed.")
            code = validate_answer(criterion, answer)
            if code is not None:
                raise ApiError(422, code, f"The answer does not fit criterion {criterion.id!r}.")
            decided_answer = answer
            # The model's kinds go with the model's answer; a different answer has none.
            kinds = list(result.kinds) if decided_answer == result.answer else []
        decision = Decision(
            outcome=outcome, answer=decided_answer, reason=reason.strip(), role=role, decided_at=_now(), kinds=kinds
        )
        store.update_appeal(conn, appeal.model_copy(update={"status": "decided", "decision": decision}))
        try:
            updated = recompute(current, version, conn=conn)
        except ScoringError as exc:
            raise ApiError(422, exc.code, "The evaluation cannot be recalculated with this answer.") from None
        store.write_evaluation(conn, updated)
        _carry_into_later(conn, appeal, updated)
        store.settle_dispute(conn, updated.conversation)
    logger.info("Appeal %s decided by %s: %s", appeal_id, role, outcome)
    return updated
