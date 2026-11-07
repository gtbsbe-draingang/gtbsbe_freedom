"""Second opinion on an appeal (extra 6). Advises the reviewer; never decides.

Owner: #22 (PLAN.md S10). Tests: test_second_opinion.py.
Request = prompt.build_blocks(...) (same cached prefix) + a third block: original answer,
explanation, evidence quotes, then the comment inside <appeal_comment> (prompt.neutralize_tags).
One retry via checking.check_answer, then JudgmentFailed("invalid_answer").
C never sets `second_opinion_status`: B maps ModelKeyMissing / JudgmentFailed to "unavailable".
"""

from __future__ import annotations

from evaluator import client  # noqa: F401  call as client.call_structured(...) so tests can script it
from evaluator._compat import (
    ChecklistVersion,
    Conversation,
    Criterion,
    CriterionResult,
    LLMCallRecord,
    SecondOpinion,
)

EFFORT_SECOND = "medium"


def appeal_block(result: CriterionResult, comment: str) -> dict:
    """The third text block (original judgment + neutralised appeal comment)."""
    raise NotImplementedError("S10 (#22): appeal_block")


async def second_opinion(
    conv: Conversation,
    checklist: ChecklistVersion,
    criterion: Criterion,
    result: CriterionResult,
    comment: str,
) -> tuple[SecondOpinion, list[LLMCallRecord]]:
    """Public API. Model = criterion.model or settings.default_model."""
    raise NotImplementedError("S10 (#22): second_opinion")
