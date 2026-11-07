"""Proxy recordings without persisting audio or returning organizer URLs."""
import logging

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import Response, StreamingResponse
from starlette.background import BackgroundTask

from app.errors import ApiError
from audio.resolve import open_audio
from audio.source import AudioSourceError, TIMEOUT

router = APIRouter(tags=["audio"])
logger = logging.getLogger(__name__)
FORWARDED_HEADERS = ("content-length", "content-range", "accept-ranges")


def get_store():
    try:
        from app import store
        return store
    except ImportError:
        raise ApiError(503, "storage_unavailable", "Conversation storage is not integrated yet.") from None


def make_client():
    return httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True)


@router.get("/conversations/{conversation}/audio")
async def get_audio(conversation: str, request: Request):
    store = get_store()
    conv = store.get_conversation(conversation)
    if conv is None:
        raise ApiError(404, "not_found", "Conversation not found.")
    player = store.get_audio_url(conversation) if conv.channel == "voice call" else None
    if not player:
        raise ApiError(404, "audio_unavailable", "Recording unavailable. Import the group if needed.")
    client = make_client()
    try:
        upstream = await open_audio(player, client, request.headers.get("range"))
    except (httpx.HTTPError, AudioSourceError):
        await client.aclose()
        raise ApiError(502, "audio_fetch_failed", "Recording could not be fetched. Try again.") from None
    except BaseException:
        await client.aclose()
        raise

    async def close():
        await upstream.aclose()
        await client.aclose()

    headers = {k: upstream.headers[k] for k in FORWARDED_HEADERS if k in upstream.headers}
    headers["Cache-Control"] = "private, no-store"
    if upstream.status_code == 416:
        await close()
        headers.pop("content-length", None)
        return Response(status_code=416, headers=headers)

    async def chunks():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        except httpx.HTTPError:
            logger.warning("Recording stream interrupted")
        finally:
            await close()

    return StreamingResponse(chunks(), status_code=upstream.status_code, media_type="audio/mpeg",
                             headers=headers, background=BackgroundTask(close))
