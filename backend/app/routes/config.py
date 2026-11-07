from typing import Any

from fastapi import APIRouter, Depends

from app.models import Config, dump
from app.settings import DEFAULT_CHECKLIST_ID, DEFAULT_CHECKLIST_VERSION, Settings, get_settings

router = APIRouter()


@router.get("/config")
def get_config(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return dump(
        Config(
            models=list(settings.prices),
            prices=settings.prices,
            model_key_configured=settings.model_key_configured,
            default_checklist={"checklist_id": DEFAULT_CHECKLIST_ID, "version": DEFAULT_CHECKLIST_VERSION},
        )
    )
