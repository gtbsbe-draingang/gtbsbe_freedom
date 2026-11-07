from typing import Any

from fastapi import APIRouter, Body

from app import store
from app.errors import ApiError
from app.importer import import_records, parse_upload, upload_group_id
from app.models import Conversation, Evaluation, FinalSummary, QueueItem, dump
from app.settings import DEFAULT_CHECKLIST_ID, DEFAULT_CHECKLIST_VERSION

router = APIRouter()


@router.post("/conversations")
async def upload_conversations(payload: Any = Body()) -> dict[str, Any]:
    """Import dialogues from an uploaded JSON body: one record, an array, `{"records": [...]}` or
    the organisers' full response. The group is the one the body names, else `upload-<UTC time>`."""
    records, group = parse_upload(payload)
    return dump(await import_records(records, group or upload_group_id()))


def _final_summary(evaluation: Evaluation, open_appeals: int) -> FinalSummary:
    return FinalSummary(
        checklist_id=evaluation.checklist_id,
        version=evaluation.version,
        total=evaluation.final_total,
        gross_error=evaluation.gross_error.flag,
        open_appeals=open_appeals,
        needs_review=any(result.needs_review for result in evaluation.results),
    )


def _queue_item(conversation: Conversation, final: FinalSummary | None) -> QueueItem:
    return QueueItem(**conversation.model_dump(exclude={"transcript"}), final=final)


@router.get("/conversations")
def list_queue(
    group_id: str | None = None,
    status: str | None = None,
    channel: str | None = None,
    language: str | None = None,
    q: str | None = None,
) -> list[dict[str, Any]]:
    """The queue: every conversation that matches the filters, without its transcript, ordered by
    group and conversation id. `final` summarises the latest done evaluation of the default
    checklist and is null for a conversation without one. `group_id`, `status`, `channel` and
    `language` match exactly; `q` is a case-insensitive search of the conversation id, the topic and
    the messages. A blank filter is no filter."""
    conversations = store.list_conversations(
        group_id=group_id, status=status, channel=channel, language=language, q=q
    )
    latest = {
        evaluation.conversation: evaluation
        for evaluation in store.list_evaluations(
            DEFAULT_CHECKLIST_ID, DEFAULT_CHECKLIST_VERSION, group_id or None
        )
    }
    open_appeals = store.count_open_appeals([latest[conv.id].id for conv in conversations if conv.id in latest])
    queue: list[dict[str, Any]] = []
    for conv in conversations:
        graded = latest.get(conv.id)
        final = None if graded is None else _final_summary(graded, open_appeals[graded.id])
        queue.append(dump(_queue_item(conv, final)))
    return queue


@router.get("/conversations/{conversation}")
def get_conversation(conversation: str) -> dict[str, Any]:
    found = store.get_conversation(conversation)
    if found is None:
        raise ApiError(404, "not_found", f"No conversation {conversation!r}.")
    return dump(found)
