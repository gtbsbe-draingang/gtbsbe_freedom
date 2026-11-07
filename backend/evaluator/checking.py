"""Answer checking: evidence that can be trusted.

Owner: #18 (PLAN.md S5). Tests: test_checking.py.
`Problem`, the codes and FATAL_CODES are final (scaffold): S6 (judge) and S10 (second opinion)
consume them. Quote matching starts with difflib (PLAN.md Conflicts 7).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

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


FUZZY_MIN_LEN = 12  # quotes shorter than this must match exactly (after normalising)
FUZZY_RATIO = 0.85

_NON_WORD = re.compile(r"\W+")


def normalize(text: str) -> str:
    """Lower case, ё->е, punctuation dropped, whitespace collapsed."""
    return _NON_WORD.sub(" ", text.casefold().replace("ё", "е")).strip()


def _found_in(nq: str, nt: str) -> bool:
    if nq in nt:
        return True
    if len(nq) < FUZZY_MIN_LEN:
        return False
    # ponytail: windows start at word starts only, O(words * len^2); fine for chat-sized messages.
    starts = [0] + [m.end() for m in re.finditer(" ", nt)]
    span = len(nq)
    for st in starts:
        for ln in (span, span - span // 8, span + span // 8):
            if SequenceMatcher(None, nq, nt[st : st + ln], autojunk=False).ratio() >= FUZZY_RATIO:
                return True
    return False


def quote_matches(quote: str, original: str, masked: str) -> bool:
    """Quote matches the original OR the masked text (`[ИМЯ]`); fuzzy for quotes of 12+ characters."""
    nq = normalize(quote)
    if not nq:
        return False
    return any(_found_in(nq, normalize(t)) for t in (original, masked))


def check_answer(answer: str, step: int | None, kinds: list[str], criterion: Criterion) -> list[Problem]:
    """Fatal checks only (answer type, N/A, step VALUE in scale, gross-error kinds)."""
    allowed = {"yes", "no"} if criterion.answer_type == "yes_no" else {"step"}
    if answer == "na":
        if not criterion.na_allowed:
            return [Problem(NA_NOT_ALLOWED, f"{criterion.id}: N/A is not allowed for this criterion")]
    elif answer not in allowed:
        return [Problem(ANSWER_NOT_ALLOWED, f"{criterion.id}: answer {answer!r} is not allowed, use one of {sorted(allowed | ({'na'} if criterion.na_allowed else set()))}")]
    problems: list[Problem] = []
    if answer == "step":
        values = [s.value for s in criterion.scale_steps]
        if step not in values:
            problems.append(Problem(STEP_NOT_IN_SCALE, f"step {step!r} is not a scale value; use one of {values} (the value, not the position)"))
    if answer == "yes" and criterion.kind == "gross_error" and not kinds:
        problems.append(Problem(KINDS_MISSING, f"kinds is required when the answer is yes; choose from {criterion.kinds}"))
    elif kinds and (answer != "yes" or any(k not in criterion.kinds for k in kinds)):
        problems.append(Problem(KINDS_NOT_ALLOWED, f"kinds {kinds} not allowed here; only for answer yes, from {criterion.kinds}"))
    return problems


def check_output(
    out: CriterionOutput, criterion: Criterion, conv: Conversation, masked: list[Message]
) -> list[Problem]:
    """check_answer + evidence index/quote + checked_range + na_reason + explanation."""
    problems = check_answer(out.answer, out.step, out.kinds, criterion)
    n = len(conv.transcript)
    for i, ev in enumerate(out.evidence):
        if not 0 <= ev.message_index < n:
            problems.append(Problem(INDEX_OUT_OF_RANGE, f"evidence[{i}]: message_index {ev.message_index} does not exist (0..{n - 1})", i))
            continue
        masked_text = masked[ev.message_index].text if ev.message_index < len(masked) else ""
        if not quote_matches(ev.quote, conv.transcript[ev.message_index].text, masked_text):
            problems.append(Problem(QUOTE_MISMATCH, f"evidence[{i}]: the quote is not in message {ev.message_index}; quote it exactly", i))
    expected = any(e.role == "expected_here" for e in out.evidence)
    if out.checked_range is None:
        if expected or (out.answer == "no" and not out.evidence):
            problems.append(Problem(CHECKED_RANGE_MISSING, "checked_range is required when an expected action is missing"))
    else:
        lo, hi = out.checked_range.from_index, out.checked_range.to_index
        if not 0 <= lo <= hi < n:
            problems.append(Problem(CHECKED_RANGE_INVALID, f"checked_range {lo}..{hi} must satisfy 0 <= from <= to <= {n - 1}"))
    if out.answer == "na" and not (out.na_reason or "").strip():
        problems.append(Problem(NA_REASON_MISSING, "na_reason is required when the answer is na"))
    if not out.explanation.strip():
        problems.append(Problem(EXPLANATION_MISSING, "explanation must not be empty"))
    return problems
