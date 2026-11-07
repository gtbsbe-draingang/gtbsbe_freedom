"""Evaluations: start a batch (or estimate it with a dry run) and read one evaluation.

`POST /evaluations` answers 201 with the Job it started, or 200 with `{total, model_calls,
reused}` when `dry_run` is true (nothing is started or stored then, so `role` is optional). The
list endpoint (`GET /evaluations?conversation&checklist_id`) comes with the read endpoints (#11).
"""

from typing import Any, Literal

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app import jobs, store
from app.errors import ApiError
from app.models import DryRun, Role, dump

router = APIRouter()


class EvaluationRequest(BaseModel):
    conversations: list[str] = Field(min_length=1)
    checklist_id: str
    version: int
    mode: Literal["reuse", "full"] = "reuse"
    dry_run: bool = False
    role: Role | None = None  # required unless dry_run


@router.post("/evaluations", status_code=201, response_model=None)
async def start_evaluations(request: EvaluationRequest) -> dict[str, Any] | JSONResponse:
    if request.dry_run:
        plan = await jobs.dry_run(request.conversations, request.checklist_id, request.version, request.mode)
        estimate = DryRun(total=plan.total, model_calls=plan.model_calls, reused=plan.reused)
        return JSONResponse(dump(estimate), status_code=200)
    if request.role is None:
        raise ApiError(422, "invalid_request", "role: Field required")
    job = await jobs.start_job(
        request.conversations, request.checklist_id, request.version, request.mode, request.role
    )
    return dump(job)


@router.get("/evaluations/{evaluation_id}")
def get_evaluation(evaluation_id: str) -> dict[str, Any]:
    found = store.get_evaluation(evaluation_id)
    if found is None:
        raise ApiError(404, "not_found", f"No evaluation {evaluation_id!r}.")
    return dump(found)
