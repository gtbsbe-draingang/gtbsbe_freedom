"""HTTP routes owned by the evaluator.

Owner: #23 (PLAN.md S11). Tests: test_router.py.
B mounts it with one line in app/main.py: include_router(evaluator.router.router, prefix=settings.base_path).
C never edits app/main.py.

GET /conversations/{conversation}/translation?to=ru
  200 {"conversation": "<id>", "to": "ru", "messages": [{"message_index": 0, "text": "..."}]}
  422 unsupported_language | 404 not_found | 409 model_key_missing (nothing cached) | 502 model_failed
"""

from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter

from app.errors import ApiError
from evaluator import client, translation
from evaluator._compat import Conversation

router = APIRouter(tags=["evaluator"])


def _from_store(conversation: str) -> Conversation | None:
    from app.store import get_conversation  # lazy: app.main imports this module while it starts

    return get_conversation(conversation)


# Hook: the conversation lookup (B's store; C owns no conversation storage). Returns the
# Conversation or None. Unit tests monkeypatch it; tests/app/test_evaluator_wiring.py does not.
find_conversation: Callable[[str], Conversation | None] = _from_store


def _payload(conversation: str, to: str, texts: list[str]) -> dict:
    return {
        "conversation": conversation,
        "to": to,
        "messages": [{"message_index": i, "text": t} for i, t in enumerate(texts)],
    }


@router.get("/conversations/{conversation}/translation")
async def get_translation(conversation: str, to: str = "ru") -> dict:
    if to not in translation.SUPPORTED_TARGETS:
        raise ApiError(422, "unsupported_language", f"Translation into {to!r} is not supported.")
    conv = find_conversation(conversation)
    if conv is None:
        raise ApiError(404, "not_found", "Conversation not found.")
    if conv.language.lower() == to:  # already in the target language: originals, no call
        return _payload(conversation, to, [m.text for m in conv.transcript])
    cached = translation.load_translation(conversation, to)
    if cached is not None:
        return _payload(conversation, to, cached)
    try:
        client.get_client()
    except client.ModelKeyMissing:
        raise ApiError(409, "model_key_missing", "No model key is configured and nothing is cached.") from None
    try:
        texts, _calls = await translation.translate(conv, to)  # translate logs its own calls
    except client.JudgmentFailed:
        raise ApiError(502, "model_failed", "The model could not translate this conversation.") from None
    translation.save_translation(conversation, to, texts)
    return _payload(conversation, to, texts)
