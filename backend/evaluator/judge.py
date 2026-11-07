"""judge_criterion: one criterion of one dialogue -> one checked Judgment.

Owner: #17 + #18 (PLAN.md S6); cost logging hook S7 (#19). Tests: test_judge.py.

Flow: get_client() first (ModelKeyMissing before any work) -> mask_transcript -> build_blocks ->
call_structured(CriterionOutput) -> check_output. On problems: ONE retry with a third block listing
them (first two blocks identical, so the cache holds). Still fatal -> JudgmentFailed("invalid_answer").
Only non-fatal left -> drop bad evidence items, needs_review=True. Low confidence -> needs_review.
Then to_judgment(). Unit-test with `evaluator.testing.ScriptedCalls` (no S3 needed).
"""

from __future__ import annotations

from evaluator import client, cost, keys, masking, prompt
from evaluator._compat import (
    CheckedRange,
    ChecklistVersion,
    Conversation,
    Criterion,
    Evidence,
    Judgment,
    LLMCallRecord,
    StepAnswer,
)
from evaluator.checking import CHECKED_RANGE_INVALID, Problem, check_output
from evaluator.schemas import CriterionOutput

EFFORT_CRITERION = "medium"


def retry_block(problems: list[Problem]) -> dict:
    """The third (uncached) text block that lists the problems found in the first answer."""
    lines = [f"- {p.code}: {p.message}" for p in problems]
    text = (
        "Your previous answer for this criterion has problems:\n"
        + "\n".join(lines)
        + "\nAnswer the same criterion again and fix every problem. Return the full corrected JSON object."
    )
    return {"type": "text", "text": text}


def to_judgment(
    out: CriterionOutput,
    *,
    criterion: Criterion,
    model: str,
    reuse_key: str,
    calls: list[LLMCallRecord],
    needs_review: bool,
) -> Judgment:
    """Map the model output to the shared Judgment: `step` -> StepAnswer(step=value),
    OutRange -> CheckedRange(from_, to), low confidence forces needs_review."""
    answer = (
        StepAnswer(step=out.step)
        if out.answer == "step" and out.step is not None
        else out.answer
    )
    rng = out.checked_range
    return Judgment(
        criterion_id=criterion.id,
        answer=answer,  # type: ignore[arg-type]
        kinds=list(out.kinds),
        explanation=out.explanation,
        evidence=[
            Evidence(message_index=e.message_index, quote=e.quote, role=e.role)
            for e in out.evidence
        ],
        checked_range=CheckedRange(**{"from": rng.from_index, "to": rng.to_index})
        if rng
        else None,
        na_reason=out.na_reason if out.answer == "na" else None,
        confidence=out.confidence,
        needs_review=needs_review or out.confidence == "low",
        coaching=out.coaching,
        model=model,
        reuse_key=reuse_key,
        calls=calls,
    )


async def judge_criterion(
    conv: Conversation, checklist: ChecklistVersion, criterion: Criterion, *, model: str
) -> Judgment:
    """Public API (B's job loop). Raises ModelKeyMissing or JudgmentFailed."""
    client.get_client()  # ModelKeyMissing before any work
    masked = masking.mask_transcript(conv.transcript)
    blocks = prompt.build_blocks(conv, masked, checklist, criterion)
    key = keys.reuse_key(conv, checklist, criterion, model)
    calls: list[LLMCallRecord] = []

    async def ask(extra: list[dict]) -> CriterionOutput:
        return await client.call_into(
            calls,
            purpose="criterion",
            model=model,
            effort=EFFORT_CRITERION,
            system=prompt.SYSTEM_PROMPT,
            blocks=[*blocks, *extra],
            output_type=CriterionOutput,
            reuse_key=key,
        )

    try:
        out = await ask([])
        problems = check_output(out, criterion, conv, masked)
        if problems:  # one retry; blocks 1 and 2 stay identical so the cache holds
            out = await ask([retry_block(problems)])
            problems = check_output(out, criterion, conv, masked)
            if any(p.fatal for p in problems):
                raise client.JudgmentFailed("invalid_answer", retryable=False)
            bad = {p.evidence_index for p in problems if p.evidence_index is not None}
            update: dict = {"evidence": [e for i, e in enumerate(out.evidence) if i not in bad]}
            if any(p.code == CHECKED_RANGE_INVALID for p in problems):
                update["checked_range"] = None
            out = out.model_copy(update=update)
    except client.JudgmentFailed as exc:
        exc.calls = list(calls)  # every paid call, including the one that failed
        raise
    finally:
        cost.log_calls_quietly(calls, conversation=conv.id, criterion_id=criterion.id)
    return to_judgment(
        out,
        criterion=criterion,
        model=model,
        reuse_key=key,
        calls=calls,
        needs_review=bool(problems),
    )
