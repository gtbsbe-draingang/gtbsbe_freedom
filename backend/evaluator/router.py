"""HTTP routes owned by the evaluator.

Owner: #23 (PLAN.md S11). Tests: test_router.py.
B mounts it with one line in app/main.py: include_router(evaluator.router.router, prefix=settings.base_path).
C never edits app/main.py.

GET /conversations/{conversation}/translation?to=ru
  200 {"conversation": "<id>", "to": "ru", "messages": [{"message_index": 0, "text": "..."}]}
  422 unsupported_language | 404 not_found | 409 model_key_missing (nothing cached) | 502 model_failed
"""

from __future__ import annotations

from fastapi import APIRouter

from app.errors import ApiError

router = APIRouter(tags=["evaluator"])


@router.get("/conversations/{conversation}/translation")
async def get_translation(conversation: str, to: str = "ru") -> dict:
    raise ApiError(501, "not_implemented", "translation is not implemented yet (#23)")
