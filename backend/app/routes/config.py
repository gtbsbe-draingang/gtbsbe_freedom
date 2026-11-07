from typing import Any

from fastapi import APIRouter, Depends

from app.models import Config, dump
from app.settings import Settings, get_settings

router = APIRouter()

DEFAULT_CHECKLIST = {"checklist_id": "official-chat", "version": 1}


@router.get("/config")
def get_config(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return dump(
        Config(
            models=list(settings.prices),
            prices=settings.prices,
            model_key_configured=settings.model_key_configured,
            default_checklist=dict(DEFAULT_CHECKLIST),
        )
    )
