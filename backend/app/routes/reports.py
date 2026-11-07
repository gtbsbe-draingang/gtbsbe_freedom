"""Reports over the stored evaluations: the before/after comparison (Extra 1), analytics (Extra 4)
and the CSV export (Extra 9).

`GET /comparisons?from_checklist&from_version&to_checklist&to_version&group_id&conversations`
compares the final totals of two checklist versions (see app.comparisons). `conversations` is
optional and takes ids in either form, or both at once: one parameter per id
(`conversations=DEV%3Ap1-ru-001&conversations=DEV%3Ap1-ru-010`, what the UI sends) and comma-
separated values (`conversations=a,b`; an id never contains a comma). Blanks are trimmed and
repeats counted once; nothing left means no filter, like a blank `group_id`. 404 `not_found` when
either version does not exist.

`GET /analytics?checklist_id&version&group_id` and `GET /export.csv?group_id&checklist_id&version`
report the final results of one checklist version (see app.analytics). An omitted or blank
`checklist_id` or `version` takes the default checklist's (settings), each on its own; a blank
`group_id` means every group. 404 `not_found` when the version does not exist. The export is
`text/csv; charset=utf-8`, an attachment named `cqa-<group>.csv` (`cqa-all.csv` without a group;
characters of the group id outside `A-Za-z0-9._-` become `_`).
"""

import re
from typing import Annotated, Any

from fastapi import APIRouter, Query, Response
from pydantic import BeforeValidator

from app.analytics import analytics, export_csv
from app.comparisons import compare
from app.models import dump
from app.settings import DEFAULT_CHECKLIST_ID, DEFAULT_CHECKLIST_VERSION

router = APIRouter()

# A version number that is blank (`version=`) is an omitted one, like a blank `group_id`.
OptionalVersion = Annotated[int | None, BeforeValidator(lambda v: None if isinstance(v, str) and not v.strip() else v)]


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


def _checklist(checklist_id: str | None, version: int | None) -> tuple[str, int]:
    """The checklist version asked for; what is omitted (or blank) is the default checklist's."""
    return checklist_id or DEFAULT_CHECKLIST_ID, DEFAULT_CHECKLIST_VERSION if version is None else version


@router.get("/analytics")
def get_analytics(
    checklist_id: str | None = None, version: OptionalVersion = None, group_id: str | None = None
) -> dict[str, Any]:
    return dump(analytics(*_checklist(checklist_id, version), group_id or None))


def export_filename(group_id: str | None) -> str:
    """`cqa-<group>.csv` with the group id reduced to `A-Za-z0-9._-` (`cqa-all.csv` for no group)."""
    return f"cqa-{re.sub(r'[^A-Za-z0-9._-]', '_', group_id) if group_id else 'all'}.csv"


@router.get("/export.csv")
def get_export(
    group_id: str | None = None, checklist_id: str | None = None, version: OptionalVersion = None
) -> Response:
    content = export_csv(*_checklist(checklist_id, version), group_id or None)
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{export_filename(group_id)}"'},
    )
