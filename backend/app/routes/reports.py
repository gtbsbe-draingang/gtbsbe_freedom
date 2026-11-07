"""Reports over the stored evaluations: the before/after comparison (Extra 1).

`GET /comparisons?from_checklist&from_version&to_checklist&to_version&group_id&conversations`
compares the final totals of two checklist versions (see app.comparisons). `conversations` is
optional and takes ids in either form, or both at once: one parameter per id
(`conversations=DEV%3Ap1-ru-001&conversations=DEV%3Ap1-ru-010`, what the UI sends) and comma-
separated values (`conversations=a,b`; an id never contains a comma). Blanks are trimmed and
repeats counted once; nothing left means no filter, like a blank `group_id`. 404 `not_found` when
either version does not exist.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Query

from app.comparisons import compare
from app.models import dump

router = APIRouter()


def split_conversations(values: list[str] | None) -> list[str] | None:
    """The distinct conversation ids of a `conversations` query, in order of appearance, or None
    when there are none."""
    if values is None:
        return None
    ids = dict.fromkeys(part.strip() for value in values for part in value.split(","))
    ids.pop("", None)
    return list(ids) or None


@router.get("/comparisons")
def get_comparison(
    from_checklist: str,
    from_version: int,
    to_checklist: str,
    to_version: int,
    group_id: str | None = None,
    conversations: Annotated[list[str] | None, Query()] = None,
) -> dict[str, Any]:
    return dump(
        compare(
            (from_checklist, from_version),
            (to_checklist, to_version),
            group_id or None,
            split_conversations(conversations),
        )
    )
