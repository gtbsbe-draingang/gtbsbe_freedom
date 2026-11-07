"""Jobs: progress per dialogue, and a retry of the failed ones."""

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app import jobs, store
from app.errors import ApiError
from app.models import Role, dump

router = APIRouter()


class RetryRequest(BaseModel):
    role: Role


@router.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict[str, Any]:
    found = store.get_job(job_id)
    if found is None:
        raise ApiError(404, "not_found", f"No job {job_id!r}.")
    return dump(found)


@router.post("/jobs/{job_id}/retry")
async def retry_job(job_id: str, request: RetryRequest) -> dict[str, Any]:
    """Re-run the job's unfinished items; the job as it is now (items back to `queued`, the retry
    recorded with its role in `retries`)."""
    return dump(await jobs.retry_job(job_id, request.role))
