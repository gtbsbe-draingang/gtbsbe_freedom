"""Analytics and CSV export over the final results of one checklist version (Extras 4 and 9).

Both reports read the same scope: the latest `done` evaluation of each conversation for one
checklist version (`store.list_evaluations`), optionally of one group, and they use its *final*
values: every result's `final_answer` (the model's answer with the reviewers' decisions, own or
carried, applied; `answer` when there is none), the final total, the final gross-error flag. A
conversation that is not stored has no group, channel or language, so its evaluations are left out
of both reports (the app never creates one). Rows are ordered by group id and then conversation id,
like every other list of the API.

Three reads, whatever the number of conversations: the checklist version, the evaluations and the
conversations' columns (`store.conversation_profiles`).

**Analytics** (`analytics`):

* `by_criterion`: the criteria of the checklist in their order. `n` is the number of evaluations
  that contain the criterion, `fail_rate` the share of them whose final answer is a failure and
  `na_rate` the share answered N/A (na counts in `n`, so the two never add up beyond 1). A failure
  is `no`; a step below the top step of a scale; for the gross-error criterion `yes`. A criterion
  that no evaluation contains (n = 0) is left out: the contract wants numbers there, not nulls.
* `by_language` and `by_channel`: the evaluations by the conversation's language (RU, KZ, EN) and
  channel (agent chat, voice call), in that fixed order, only the values that occur. `n` counts the
  evaluations, `avg_total` is the mean of the final totals that are calculated (null when none is).
* `gross_errors`: `count` evaluations with the flag on, `by_kind` the number of those that carry
  each kind (a kind counts once per evaluation), ordered by count descending and then kind, and the
  `conversations` ids, ordered by group id and conversation id.

Rates and means are computed on exact `Fraction`s and rounded once, half-up: rates to 4 decimals
(`rate`), the average total to 2 (`scoring.round2`, the one place a total is rounded). No floating
point.

**CSV** (`export_csv`): one row per evaluation, built for Excel with a Russian locale. UTF-8 with a
byte order mark; `;` between columns; `.` as the decimal point; CRLF line ends (what Excel and
RFC 4180 use; the `csv` module also quotes a cell that holds `\\r`, `\\n`, `;` or a quote, so every
row stays one row). The columns are `conversation_id;group_id;channel;language;checklist_id;
version;original_total;final_total;gross_error;gross_error_kinds`, then
`<criterion_id>_answer;<criterion_id>_points` for each criterion in the checklist's order.

* `conversation_id` is the organisers' id without the group (`group_id` is its own column).
* An answer is `yes`, `no`, `na` or the value of the step (`15`), the final answer; points are the
  result's final points with two decimals. Totals are written with two decimals. A total, points
  or an answer that does not exist (not calculated, a gross-error criterion, no result) is an
  empty cell.
* `gross_error` is `1` or `0` (a number: Excel turns `true` into a locale-dependent word);
  `gross_error_kinds` are joined with `,`.
* CSV injection: ids come from uploads and checklist ids from users, and a spreadsheet reads a text
  cell that starts with `=`, `+`, `-` or `@` as a formula. Every text cell (the header's too) that
  starts with one of those, or with a tab or a carriage return (which spreadsheets also treat as a
  way in), gets a leading apostrophe. Numbers are written as they are, never prefixed.
"""

import csv
import io
import math
from collections import Counter
from decimal import Decimal
from fractions import Fraction

from app import store
from app.errors import ApiError
from app.models import (
    Analytics,
    AnalyticsChannel,
    AnalyticsCriterion,
    AnalyticsLanguage,
    Answer,
    ChecklistVersion,
    Criterion,
    CriterionResult,
    Evaluation,
    GrossErrorKindCount,
    GrossErrorStats,
    StepAnswer,
)
from app.scoring import round2
from app.store import ConversationProfile

BOM = "﻿"
DELIMITER = ";"
LINE_END = "\r\n"

_LANGUAGES = ("RU", "KZ", "EN")
_CHANNELS = ("agent chat", "voice call")
_HALF = Fraction(1, 2)
# A spreadsheet reads a text cell that starts with one of these as a formula (OWASP's list).
_FORMULA_STARTS = ("=", "+", "-", "@", "\t", "\r")

Row = tuple[Evaluation, ConversationProfile]


# --- shared scope ----------------------------------------------------------------------------


def _scope(checklist_id: str, version: int, group_id: str | None) -> tuple[ChecklistVersion, list[Row]]:
    """The checklist version and its evaluations with their conversations' profiles, ordered by
    group id and conversation id. Raises ApiError 404 `not_found` for an unknown version."""
    found = store.get_checklist_version(checklist_id, version)
    if found is None:
        raise ApiError(404, "not_found", f"No checklist version {checklist_id!r} v{version}.")
    evaluations = store.list_evaluations(checklist_id, version, group_id or None)
    profiles = store.conversation_profiles([evaluation.conversation for evaluation in evaluations])
    rows = [(e, profiles[e.conversation]) for e in evaluations if e.conversation in profiles]
    rows.sort(key=lambda row: (row[1].group_id, row[1].conversation_id))
    return found, rows


def _criteria(version: ChecklistVersion) -> list[Criterion]:
    return sorted(version.criteria, key=lambda c: c.order)  # stable: ties keep the stored order


def _final_answer(result: CriterionResult) -> Answer:
    return result.final_answer if result.final_answer is not None else result.answer


# --- analytics -------------------------------------------------------------------------------


def rate(count: int, n: int) -> Decimal:
    """`count / n` rounded half-up to four decimals, from the exact fraction ("0.0313" for 1/32).
    `n` must be positive."""
    scaled = math.floor(Fraction(count, n) * 10_000 + _HALF)
    return Decimal(f"{scaled}e-4")


def _failed(criterion: Criterion, answer: Answer, top: int | None) -> bool:
    if criterion.kind == "gross_error":
        return answer == "yes"
    if isinstance(answer, StepAnswer):
        return top is not None and answer.step < top
    return answer == "no"


def _by_criterion(criteria: list[Criterion], rows: list[Row]) -> list[AnalyticsCriterion]:
    finals = [{r.criterion_id: _final_answer(r) for r in evaluation.results} for evaluation, _ in rows]
    stats = []
    for criterion in criteria:
        top = max((step.value for step in criterion.scale_steps), default=None)
        answers = [final[criterion.id] for final in finals if criterion.id in final]
        if answers:
            stats.append(
                AnalyticsCriterion(
                    criterion_id=criterion.id,
                    title=criterion.title,
                    fail_rate=rate(sum(_failed(criterion, answer, top) for answer in answers), len(answers)),
                    na_rate=rate(sum(answer == "na" for answer in answers), len(answers)),
                    n=len(answers),
                )
            )
    return stats


def _average_total(evaluations: list[Evaluation]) -> Decimal | None:
    totals = [Fraction(e.final_total) for e in evaluations if e.final_total is not None]
    return round2(sum(totals, Fraction(0)) / len(totals)) if totals else None


def _by_value(rows: list[Row], column: str, order: tuple[str, ...]) -> list[tuple[str, Decimal | None, int]]:
    """`(value, average total, n)` for each value of the profile's `column` that occurs, in `order`."""
    groups = {value: [e for e, profile in rows if getattr(profile, column) == value] for value in order}
    return [(value, _average_total(group), len(group)) for value, group in groups.items() if group]


def _gross_errors(rows: list[Row]) -> GrossErrorStats:
    flagged = [(evaluation, profile) for evaluation, profile in rows if evaluation.gross_error.flag]
    kinds = Counter(kind for evaluation, _ in flagged for kind in dict.fromkeys(evaluation.gross_error.kinds))
    return GrossErrorStats(
        count=len(flagged),
        by_kind=[
            GrossErrorKindCount(kind=kind, count=count)
            for kind, count in sorted(kinds.items(), key=lambda item: (-item[1], item[0]))
        ],
        conversations=[evaluation.conversation for evaluation, _ in flagged],
    )


def analytics(checklist_id: str, version: int, group_id: str | None = None) -> Analytics:
    """The analytics of the final results of `checklist_id` v`version` (see the module docstring);
    `group_id` (None or "" = every group) narrows it to one group's conversations.

    Raises ApiError 404 `not_found` when the checklist version does not exist."""
    found, rows = _scope(checklist_id, version, group_id)
    return Analytics(
        by_criterion=_by_criterion(_criteria(found), rows),
        by_language=[
            AnalyticsLanguage(language=value, avg_total=average, n=n)
            for value, average, n in _by_value(rows, "language", _LANGUAGES)
        ],
        by_channel=[
            AnalyticsChannel(channel=value, avg_total=average, n=n)
            for value, average, n in _by_value(rows, "channel", _CHANNELS)
        ],
        gross_errors=_gross_errors(rows),
    )


# --- CSV -------------------------------------------------------------------------------------


def _text(value: str) -> str:
    """A text cell, safe to open in a spreadsheet: a leading apostrophe when it could be a formula."""
    return f"'{value}" if value.startswith(_FORMULA_STARTS) else value


def _number(value: Decimal | None) -> str:
    """A total or points with two decimals and a decimal point (exact, half-up), "" for null."""
    return "" if value is None else str(round2(Fraction(value)))


def _answer_cell(answer: Answer) -> str:
    return str(answer.step) if isinstance(answer, StepAnswer) else answer  # yes / no / na


def _header(criteria: list[Criterion]) -> list[str]:
    columns = [
        "conversation_id", "group_id", "channel", "language", "checklist_id", "version",
        "original_total", "final_total", "gross_error", "gross_error_kinds",
    ]  # fmt: skip
    # the criterion ids are text too (a user's checklist), so the header takes the same care
    columns += [_text(f"{c.id}_{part}") for c in criteria for part in ("answer", "points")]
    return columns


def _row(criteria: list[Criterion], evaluation: Evaluation, profile: ConversationProfile) -> list[str]:
    cells = [
        _text(profile.conversation_id),
        _text(profile.group_id),
        _text(profile.channel),
        _text(profile.language),
        _text(evaluation.checklist_id),
        str(evaluation.version),
        _number(evaluation.original_total),
        _number(evaluation.final_total),
        "1" if evaluation.gross_error.flag else "0",
        _text(",".join(evaluation.gross_error.kinds)),
    ]
    results = {result.criterion_id: result for result in evaluation.results}
    for criterion in criteria:
        result = results.get(criterion.id)
        if result is None:
            cells += ["", ""]
        else:
            cells += [_answer_cell(_final_answer(result)), _number(result.points)]
    return cells


def export_csv(checklist_id: str, version: int, group_id: str | None = None) -> bytes:
    """The final results of `checklist_id` v`version` as CSV bytes (see the module docstring), one
    row per evaluation; the header alone when there is none.

    Raises ApiError 404 `not_found` when the checklist version does not exist."""
    found, rows = _scope(checklist_id, version, group_id)
    criteria = _criteria(found)
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, delimiter=DELIMITER, lineterminator=LINE_END)
    writer.writerow(_header(criteria))
    writer.writerows(_row(criteria, evaluation, profile) for evaluation, profile in rows)
    return (BOM + buffer.getvalue()).encode("utf-8")
