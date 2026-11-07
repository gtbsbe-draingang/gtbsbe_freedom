from fastapi import APIRouter

from app.routes.config import router as config_router
from app.routes.conversations import router as conversations_router
from app.routes.datasets import router as datasets_router


def all_routers() -> list[APIRouter]:
    """Routers owned by app/. Each is mounted under settings.base_path by create_app()."""
    return [config_router, conversations_router, datasets_router]
