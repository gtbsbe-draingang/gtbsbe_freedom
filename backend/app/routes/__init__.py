from fastapi import APIRouter

from app.routes.config import router as config_router


def all_routers() -> list[APIRouter]:
    """Routers owned by app/. Each is mounted under settings.base_path by create_app()."""
    return [config_router]
