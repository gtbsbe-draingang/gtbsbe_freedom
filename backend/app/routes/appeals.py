"""Appeals: file one, list and read them, and decide one.

`POST /appeals` answers 201 with the Appeal (its second opinion `pending` or `unavailable`; poll
`GET /appeals/{id}` for it). `POST /appeals/{id}/decision` answers 200 with the recalculated
Evaluation. `GET /appeals` lists newest first; `status`, `evaluation_id` and `conversation` are
optional exact filters (a blank one is no filter).
"""

from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel

from app import appeals, store
from app.errors import ApiError
from app.models import Answer, Role, dump

router = APIRouter()

_STATUSES = ("open", "decided")


class AppealRequest(BaseModel):
    evaluation_id: str
    criterion_id: str
    comment: str
    role: Role


class DecisionRequest(BaseModel):
    outcome: Literal["confirmed", "changed"]
    answer: Answer | None = None  # required for "changed"; ignored for "confirmed"
    reason: str = ""  # a blank reason is 422 reason_required, checked after 404/403/409
    role: Role


@router.post("/appeals", status_code=201)
async def file_appeal(request: AppealRequest) -> dict[str, Any]:
    appeal = await appeals.file_appeal(request.evaluation_id, request.criterion_id, request.comment, request.role)
    return dump(appeal)


@router.get("/appeals")
def list_appeals(
    status: str | None = None, evaluation_id: str | None = None, conversation: str | None = None
) -> list[dict[str, Any]]:
    if status and status not in _STATUSES:
        raise ApiError(422, "invalid_request", "status: must be open or decided.")
    return [
        dump(appeal)
        for appeal in store.list_appeals(status or None, evaluation_id=evaluation_id, conversation=conversation)
    ]


@router.get("/appeals/{appeal_id}")
def get_appeal(appeal_id: str) -> dict[str, Any]:
    found = store.get_appeal(appeal_id)
    if found is None:
        raise ApiError(404, "not_found", f"No appeal {appeal_id!r}.")
    return dump(found)


@router.post("/appeals/{appeal_id}/decision")
def decide(appeal_id: str, request: DecisionRequest) -> dict[str, Any]:
    """The reviewer's decision; the evaluation as recalculated (runs in the thread pool)."""
    return dump(appeals.decide(appeal_id, request.outcome, request.answer, request.reason, request.role))
