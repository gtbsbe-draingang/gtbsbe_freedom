"""GET /conversations/{conversation}/audio (issue #27).

Serves the call recording from our own origin, so the UI stays within `media-src 'self'` and
seeking works through HTTP range requests. The first request resolves a fresh MP3 link from the
record's player page and caches the file; the signed link is never stored, logged or returned.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter
from fastapi.responses import FileResponse

from app.errors import ApiError
from audio import recording
from audio.source import AudioSourceError

logger = logging.getLogger(__name__)
router = APIRouter(tags=["audio"])


@router.get("/conversations/{conversation}/audio")
async def get_audio(conversation: str):
    try:
        path = await recording.ensure_recording(conversation)
    except AudioSourceError as e:
        logger.warning("audio for %s unavailable: %s", conversation, e)
        raise ApiError(502, "audio_fetch_failed", "The recording could not be fetched from the organisers. Try again.") from None
    if path is None:
        raise ApiError(404, "audio_unavailable", "This conversation has no recording. Import its group to get one.")
    # FileResponse answers Range requests with 206 and Content-Range.
    return FileResponse(path, media_type="audio/mpeg", headers={"Cache-Control": "private, max-age=3600"})
