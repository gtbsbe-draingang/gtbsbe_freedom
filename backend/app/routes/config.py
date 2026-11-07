from typing import Any

from fastapi import APIRouter, Depends

from app.settings import Settings, get_settings

router = APIRouter()

DEFAULT_CHECKLIST = {"checklist_id": "official-chat", "version": 1}


@router.get("/config")
def get_config(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    # Task 2 replaces this dict with the Config model (same keys).
    return {
        "models": list(settings.prices),
        "prices": {
            model: {kind: float(price) for kind, price in per_kind.items()}
            for model, per_kind in settings.prices.items()
        },
        "model_key_configured": settings.model_key_configured,
        "default_checklist": dict(DEFAULT_CHECKLIST),
    }
