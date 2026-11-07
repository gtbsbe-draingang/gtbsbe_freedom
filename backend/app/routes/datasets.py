from typing import Any

from fastapi import APIRouter

from app.importer import fetch_group, import_records
from app.models import dump

router = APIRouter()


@router.get("/datasets/{group_id}")
async def import_dataset(group_id: str) -> dict[str, Any]:
    """Fetch a dataset group from the organisers' API and store it. Importing a group again
    changes only what changed upstream; the answer counts what happened."""
    records = await fetch_group(group_id)
    return dump(await import_records(records, group_id))
