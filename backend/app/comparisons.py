"""Before/after comparison of final totals across checklist versions or checklists (Extra 1).

`compare()` lines up the latest done evaluation of each dialogue on two sides and reports the
difference of their *final* totals (the model's answers with the reviewers' decisions applied, own
or carried), so every difference comes from the change of checklist itself and not from a decision
that was made on one side only.

Arithmetic is exact: a total is a `Decimal`, the difference is taken on exact `Fraction`s and rounded
once, half-up to two decimals, by `scoring.round2` (the same rounding as every total). The average
delta is the mean of the exact differences, rounded once, never the mean of the rounded ones. No
floating point.
"""

from decimal import Decimal
from fractions import Fraction

from app import store
from app.errors import ApiError
from app.models import Comparison, ComparisonRow, ComparisonSide, ComparisonSummary
from app.scoring import round2


def _side(ref: tuple[str, int]) -> ComparisonSide:
    checklist_id, version = ref
    found = store.get_checklist_version(checklist_id, version)
    if found is None:
        raise ApiError(404, "not_found", f"No checklist version {checklist_id!r} v{version}.")
    return ComparisonSide(checklist_id=found.checklist_id, version=found.version, name=found.name)


def _final_totals(side: ComparisonSide, group_id: str | None) -> dict[str, Decimal | None]:
    """The final total of the latest done evaluation of each dialogue on this side (None = not
    calculated), by conversation id."""
    return {
        evaluation.conversation: evaluation.final_total
        for evaluation in store.list_evaluations(side.checklist_id, side.version, group_id)
    }


def compare(
    from_ref: tuple[str, int],
    to_ref: tuple[str, int],
    group_id: str | None = None,
    conversations: list[str] | None = None,
) -> Comparison:
    """Compare `from_ref` ("old") with `to_ref` ("new"), each a `(checklist_id, version)`.

    Rows: the dialogues in scope with a done evaluation on at least one side, ordered by group id
    and conversation id. `group_id` (None or "" = every group) and `conversations` (conversation
    ids; None = every dialogue; an empty list is an empty scope) narrow the scope. A dialogue
    graded on one side only has a row with the other total null. A conversation that is not stored
    has no group to show and is left out.

    `delta` = new - old, null when either total is null. `summary.total` counts the rows,
    `summary.changed` the rows whose two totals differ (a number against null differs) and
    `summary.avg_delta` is the mean of the exact differences of the rows that have one (null when
    none does).

    Raises ApiError 404 `not_found` when either checklist version does not exist."""
    old_side = _side(from_ref)
    new_side = _side(to_ref)
    group = group_id or None
    old_totals = _final_totals(old_side, group)
    new_totals = _final_totals(new_side, group)

    in_scope = old_totals.keys() | new_totals.keys()
    if conversations is not None:
        in_scope &= set(conversations)

    rows: list[ComparisonRow] = []
    exact_deltas: list[Fraction] = []
    changed = 0
    for conversation, (row_group, conversation_id) in store.conversation_keys(list(in_scope)).items():
        old_total = old_totals.get(conversation)
        new_total = new_totals.get(conversation)
        delta = None
        if old_total is not None and new_total is not None:
            exact = Fraction(new_total) - Fraction(old_total)
            exact_deltas.append(exact)
            delta = round2(exact)
        changed += old_total != new_total
        rows.append(
            ComparisonRow(
                conversation=conversation,
                conversation_id=conversation_id,
                group_id=row_group,
                old_total=old_total,
                new_total=new_total,
                delta=delta,
            )
        )
    rows.sort(key=lambda row: (row.group_id, row.conversation_id))

    average = round2(sum(exact_deltas, Fraction(0)) / len(exact_deltas)) if exact_deltas else None
    return Comparison(
        from_=old_side,
        to=new_side,
        summary=ComparisonSummary(total=len(rows), changed=changed, avg_delta=average),
        rows=rows,
    )
