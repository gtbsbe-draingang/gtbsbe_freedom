from typing import Any

from fastapi import APIRouter, Body

from app import store
from app.errors import ApiError
from app.importer import import_records, parse_upload, upload_group_id
from app.models import dump

router = APIRouter()


@router.post("/conversations")
async def upload_conversations(payload: Any = Body()) -> dict[str, Any]:
    """Import dialogues from an uploaded JSON body: one record, an array, `{"records": [...]}` or
    the organisers' full response. The group is the one the body names, else `upload-<UTC time>`."""
    records, group = parse_upload(payload)
    return dump(await import_records(records, group or upload_group_id()))


@router.get("/conversations/{conversation}")
def get_conversation(conversation: str) -> dict[str, Any]:
    found = store.get_conversation(conversation)
    if found is None:
        raise ApiError(404, "not_found", f"No conversation {conversation!r}.")
    return dump(found)
