from fastapi import APIRouter

from app.routes.appeals import router as appeals_router
from app.routes.checklists import router as checklists_router
from app.routes.config import router as config_router
from app.routes.conversations import router as conversations_router
from app.routes.datasets import router as datasets_router
from app.routes.evaluations import router as evaluations_router
from app.routes.jobs import router as jobs_router
from app.routes.reports import router as reports_router


def all_routers() -> list[APIRouter]:
    """Routers owned by app/. Each is mounted under settings.base_path by create_app()."""
    return [
        config_router,
        conversations_router,
        datasets_router,
        checklists_router,
        evaluations_router,
        jobs_router,
        appeals_router,
        reports_router,
    ]
