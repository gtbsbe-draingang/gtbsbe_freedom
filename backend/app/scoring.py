"""Exact scoring: the model judges the criteria, this module does all the arithmetic.

Section 6 of the front-end design is the authority (steps 1-7 and the test vectors T1-T4).
`score()` is pure: no database, no I/O, no clock. Everything is computed with `Fraction`;
`Decimal` appears only in `round2`, the single place a number is rounded for output. There is no
floating point anywhere in this module (a test enforces it).

Conventions callers can rely on:

* A criterion is *applicable* when it is `kind == "scored"`, its weight is > 0 and its answer is
  not N/A. A scored criterion that is not applicable (N/A, or weight 0) has `(None, None)` as its
  result: no points and effective weight `None` (never `Decimal(0)`). The gross-error criterion
  also has `(None, None)`: it gives no points and carries no weight.
* `Scored.results` holds the rounded values for output. The totals are computed from the exact
  values, never from the rounded ones, so rounded per-criterion points may not add up to the
  rounded total by a cent. `Scored.exact_results` and `Scored.exact_total` expose the exact
  `Fraction`s for callers that need them (comparisons, analytics, tests).
* `score()` and `fraction()` raise `ScoringError`, a `ValueError` whose only argument is the
  code (`"na_not_allowed"`, `"step_not_in_scale"`, `"bad_answer"`, plus `"missing_answer"` and
  `"unknown_criterion"` for answers that do not match the checklist, and `"bad_scale"` for a scale
  without a positive top step). `.code` and `.criterion_id` say which. Callers validate first.
* Sections are returned in their `order`. A section with nothing applicable (every criterion N/A
  or weight 0, or only gross-error criteria, like the official "gross" section) has
  `points`, `available` and `percent` all `None`.
"""

import math
from dataclasses import dataclass, field
from decimal import Decimal
from fractions import Fraction

from app.models import (
    Answer,
    ChecklistVersion,
    Criterion,
    GrossError,
    SectionScore,
    StepAnswer,
)

_HUNDRED = Fraction(100)
_HALF = Fraction(1, 2)


class ScoringError(ValueError):
    """A ValueError carrying a machine-readable code; `str(e)` and `e.args[0]` are the code."""

    def __init__(self, code: str, criterion_id: str | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.criterion_id = criterion_id


@dataclass
class Scored:
    # criterion id -> (points, effective weight), rounded to 2 places for output
    results: dict[str, tuple[Decimal | None, Decimal | None]]
    total: Decimal | None  # None = not calculated (nothing applicable), never 0
    sections: list[SectionScore]
    gross_error: GrossError
    # the same numbers, exact
    exact_results: dict[str, tuple[Fraction | None, Fraction | None]] = field(default_factory=dict)
    exact_total: Fraction | None = None


def validate_answer(c: Criterion, answer: Answer) -> str | None:
    """The error code for an answer that does not fit the criterion, or None when it fits."""
    if isinstance(answer, StepAnswer):
        if c.answer_type != "scale":
            return "bad_answer"
        if answer.step not in {s.value for s in c.scale_steps}:
            return "step_not_in_scale"
        return None
    if answer == "na":
        return None if c.na_allowed else "na_not_allowed"
    if answer == "yes" or answer == "no":
        return None if c.answer_type == "yes_no" else "bad_answer"
    return "bad_answer"


def _fraction(c: Criterion, answer: Answer) -> Fraction | None:
    # The answer is already validated.
    if isinstance(answer, StepAnswer):
        top = max(s.value for s in c.scale_steps)
        if top <= 0:
            raise ScoringError("bad_scale", c.id)
        return Fraction(answer.step, top)
    if answer == "na":
        return None
    return Fraction(1) if answer == "yes" else Fraction(0)


def fraction(c: Criterion, answer: Answer) -> Fraction | None:
    """yes -> 1, no -> 0, a step -> value / top step value, na -> None."""
    code = validate_answer(c, answer)
    if code is not None:
        raise ScoringError(code, c.id)
    return _fraction(c, answer)


def round2(x: Fraction) -> Decimal:
    """Half-up, away from zero, to two decimals: floor(|x| * 100 + 1/2) with the sign restored."""
    hundredths = math.floor(abs(x) * 100 + _HALF)
    if x < 0:
        hundredths = -hundredths
    # Built from text so the result is exact whatever the Decimal context is, and always has
    # exactly two decimals ("100.00", "0.00").
    return Decimal(f"{hundredths}e-2")


def _round_or_none(x: Fraction | None) -> Decimal | None:
    return None if x is None else round2(x)


def score(version: ChecklistVersion, answers: dict[str, tuple[Answer, list[str]]]) -> Scored:
    """Score one evaluation. `answers` maps every criterion id to (answer, gross-error kinds)."""
    criteria = version.criteria
    known = {c.id for c in criteria}
    for cid in answers:
        if cid not in known:
            raise ScoringError("unknown_criterion", cid)

    fractions: dict[str, Fraction] = {}  # applicable criteria only
    weights: dict[str, Fraction] = {}
    flagged = False
    kinds: list[str] = []

    for c in criteria:
        if c.id not in answers:
            raise ScoringError("missing_answer", c.id)
        answer, answer_kinds = answers[c.id]
        code = validate_answer(c, answer)
        if code is not None:
            raise ScoringError(code, c.id)
        if c.kind == "gross_error":
            if answer == "yes":
                flagged = True
                for kind in answer_kinds:
                    if kind not in kinds:
                        kinds.append(kind)
            continue
        frac = _fraction(c, answer)
        weight = Fraction(c.weight)  # exact for a Decimal
        if frac is not None and weight > 0:
            fractions[c.id] = frac
            weights[c.id] = weight

    weight_sum = sum(weights.values(), Fraction(0))
    effective: dict[str, Fraction] = {}
    points: dict[str, Fraction] = {}
    if weights:
        factor = _HUNDRED / weight_sum
        for cid, weight in weights.items():
            effective[cid] = weight * factor
            points[cid] = fractions[cid] * effective[cid]
    exact_total = sum(points.values(), Fraction(0)) if points else None

    exact_results: dict[str, tuple[Fraction | None, Fraction | None]] = {}
    results: dict[str, tuple[Decimal | None, Decimal | None]] = {}
    for c in criteria:
        pair = (points.get(c.id), effective.get(c.id))
        exact_results[c.id] = pair
        results[c.id] = (_round_or_none(pair[0]), _round_or_none(pair[1]))

    sections = []
    for section in sorted(version.sections, key=lambda s: s.order):
        ids = [c.id for c in criteria if c.section_id == section.id]
        sections.append(_section_score(section.id, ids, fractions, weights, effective, points))

    return Scored(
        results=results,
        total=_round_or_none(exact_total),
        sections=sections,
        gross_error=GrossError(flag=flagged, kinds=kinds),
        exact_results=exact_results,
        exact_total=exact_total,
    )


def _section_score(
    section_id: str,
    criterion_ids: list[str],
    fractions: dict[str, Fraction],
    weights: dict[str, Fraction],
    effective: dict[str, Fraction],
    points: dict[str, Fraction],
) -> SectionScore:
    applicable = [cid for cid in criterion_ids if cid in weights]
    if not applicable:
        return SectionScore(section_id=section_id, points=None, available=None, percent=None)
    weight_sum = sum((weights[cid] for cid in applicable), Fraction(0))
    earned = sum((fractions[cid] * weights[cid] for cid in applicable), Fraction(0))
    return SectionScore(
        section_id=section_id,
        points=round2(sum((points[cid] for cid in applicable), Fraction(0))),
        available=round2(sum((effective[cid] for cid in applicable), Fraction(0))),
        percent=round2(earned / weight_sum * _HUNDRED),
    )
