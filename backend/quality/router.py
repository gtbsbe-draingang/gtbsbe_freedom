from pathlib import Path

from fastapi import APIRouter, Query

from app.errors import ApiError
from quality.accuracy import accuracy_report, load_reference

router = APIRouter(tags=["quality"])
REFERENCE_PATH = Path(__file__).resolve().parents[2] / "data" / "reference" / "dev_labels.json"
# __file__ = repo/backend/quality/router.py; parents[2] is the repository root.


def get_store():
    try:
        from app import store
        return store
    except ImportError:
        raise ApiError(503, "storage_unavailable", "Conversation storage is not integrated yet.") from None


@router.get("/reports/accuracy")
def report(checklist_id: str = "official-chat", version: int = Query(1, ge=1), group_id: str = "DEV"):
    if not REFERENCE_PATH.is_file():
        raise ApiError(404, "reference_missing", "Reference answers are not installed.")
    store = get_store()
    checklist = store.get_checklist_version(checklist_id, version)
    if checklist is None:
        raise ApiError(404, "not_found", "Checklist version not found.")
    reference = load_reference(REFERENCE_PATH)
    if group_id != "DEV" or (checklist_id, version) != (reference.checklist_id, reference.version):
        raise ApiError(409, "reference_mismatch", "References cover only the DEV group and their original checklist version.")
    ids = {f"DEV:{r.conversation_id}" for r in reference.labels}
    conversations = {key: store.get_conversation(key) for key in ids}
    return accuracy_report(reference, store.list_evaluations(checklist_id, version, group_id=group_id),
                           checklist=checklist, conversations=conversations).model_dump()
