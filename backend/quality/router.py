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


def latest_model_runs(store, checklist_id: str, version: int, conversations: set[str]):
    """The newest done model run per conversation for this exact version.

    Mock runs are dropped BEFORE picking the newest, so a later mock run never hides an earlier
    real one. The shared `store.list_evaluations` (newest done run of any source) is left as is
    for the other reports."""
    latest = {}
    for e in store.find_evaluations(checklist_id=checklist_id):  # newest first
        if (e.version == version and e.status == "done" and e.source == "model"
                and e.conversation in conversations):
            latest.setdefault(e.conversation, e)
    return list(latest.values())


@router.get("/reports/accuracy")
def report(checklist_id: str = "official-chat", version: int | None = Query(None, ge=1), group_id: str = "DEV"):
    if not REFERENCE_PATH.is_file():
        raise ApiError(404, "reference_missing", "Reference answers are not installed.")
    reference = load_reference(REFERENCE_PATH)
    if version is None:
        version = reference.version  # the version the references were written for
    store = get_store()
    checklist = store.get_checklist_version(checklist_id, version)
    if checklist is None:
        raise ApiError(404, "not_found", "Checklist version not found.")
    if group_id != "DEV" or (checklist_id, version) != (reference.checklist_id, reference.version):
        raise ApiError(409, "reference_mismatch",
                       "References cover only the DEV group and the checklist version they were written for.")
    ids = {f"DEV:{r.conversation_id}" for r in reference.labels}
    conversations = {key: store.get_conversation(key) for key in ids}
    runs = latest_model_runs(store, checklist_id, version, ids)
    return accuracy_report(reference, runs, checklist=checklist, conversations=conversations).model_dump()
