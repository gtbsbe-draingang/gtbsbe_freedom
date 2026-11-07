"""judge_criterion: one criterion of one dialogue -> one checked Judgment.

Owner: #17 + #18 (PLAN.md S6); cost logging hook S7 (#19). Tests: test_judge.py.

Flow: get_client() first (ModelKeyMissing before any work) -> mask_transcript -> build_blocks ->
call_structured(CriterionOutput) -> check_output. On problems: ONE retry with a third block listing
them (first two blocks identical, so the cache holds). Still fatal -> JudgmentFailed("invalid_answer").
Only non-fatal left -> drop bad evidence items, needs_review=True. Low confidence -> needs_review.
Then to_judgment(). Unit-test with `evaluator.testing.ScriptedCalls` (no S3 needed).
"""

from __future__ import annotations

from evaluator import client  # noqa: F401  call as client.call_structured(...) so tests can script it
from evaluator._compat import ChecklistVersion, Conversation, Criterion, Judgment, LLMCallRecord
from evaluator.checking import Problem
from evaluator.schemas import CriterionOutput

EFFORT_CRITERION = "medium"


def retry_block(problems: list[Problem]) -> dict:
    """The third (uncached) text block that lists the problems found in the first answer."""
    raise NotImplementedError("S6 (#18): retry_block")


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
    raise NotImplementedError("S6 (#17): to_judgment")


async def judge_criterion(
    conv: Conversation, checklist: ChecklistVersion, criterion: Criterion, *, model: str
) -> Judgment:
    """Public API (B's job loop). Raises ModelKeyMissing or JudgmentFailed."""
    raise NotImplementedError("S6 (#17, #18): judge_criterion")
