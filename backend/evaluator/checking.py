"""Answer checking: evidence that can be trusted.

Owner: #18 (PLAN.md S5). Tests: test_checking.py.
`Problem`, the codes and FATAL_CODES are final (scaffold): S6 (judge) and S10 (second opinion)
consume them. Quote matching starts with difflib (PLAN.md Conflicts 7).
"""

from __future__ import annotations

from dataclasses import dataclass

from evaluator._compat import Conversation, Criterion, Message
from evaluator.schemas import CriterionOutput

# Problem codes (exact strings).
ANSWER_NOT_ALLOWED = "answer_not_allowed"
NA_NOT_ALLOWED = "na_not_allowed"
STEP_NOT_IN_SCALE = "step_not_in_scale"
KINDS_NOT_ALLOWED = "kinds_not_allowed"
KINDS_MISSING = "kinds_missing"
INDEX_OUT_OF_RANGE = "index_out_of_range"
QUOTE_MISMATCH = "quote_mismatch"
CHECKED_RANGE_MISSING = "checked_range_missing"
CHECKED_RANGE_INVALID = "checked_range_invalid"
NA_REASON_MISSING = "na_reason_missing"
EXPLANATION_MISSING = "explanation_missing"

FATAL_CODES = frozenset({ANSWER_NOT_ALLOWED, NA_NOT_ALLOWED, STEP_NOT_IN_SCALE, KINDS_NOT_ALLOWED, KINDS_MISSING})


@dataclass(frozen=True)
class Problem:
    code: str
    message: str
    evidence_index: int | None = None  # position in out.evidence, for evidence problems

    @property
    def fatal(self) -> bool:
        return self.code in FATAL_CODES


def normalize(text: str) -> str:
    """Lower case, ё->е, punctuation dropped, whitespace collapsed."""
    raise NotImplementedError("S5 (#18): normalize")


def quote_matches(quote: str, original: str, masked: str) -> bool:
    """Quote matches the original OR the masked text (`[ИМЯ]`); fuzzy for quotes of 12+ chars."""
    raise NotImplementedError("S5 (#18): quote_matches")


def check_answer(answer: str, step: int | None, kinds: list[str], criterion: Criterion) -> list[Problem]:
    """Fatal checks only (answer type, N/A, step VALUE in scale, gross-error kinds)."""
    raise NotImplementedError("S5 (#18): check_answer")


def check_output(
    out: CriterionOutput, criterion: Criterion, conv: Conversation, masked: list[Message]
) -> list[Problem]:
    """check_answer + evidence index/quote + checked_range + na_reason + explanation."""
    raise NotImplementedError("S5 (#18): check_output")
