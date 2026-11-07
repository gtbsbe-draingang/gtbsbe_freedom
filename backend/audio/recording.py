"""Get a call's recording onto disk, once."""

from __future__ import annotations

import asyncio
from pathlib import Path

from audio.source import download_mp3
from audio.store import cached_path, find_cached

_locks: dict[str, asyncio.Lock] = {}


def audio_url_for(conversation: str) -> str | None:
    from app.store import get_audio_url  # owned by stream B; private, never sent to the UI

    return get_audio_url(conversation)


async def ensure_recording(conversation: str, audio_url: str | None = None) -> Path | None:
    """Path of the cached recording, downloading it first if needed. None when there is no audio."""
    path = find_cached(conversation)
    if path:
        return path
    audio_url = audio_url or audio_url_for(conversation)
    if not audio_url:
        return None
    lock = _locks.setdefault(conversation, asyncio.Lock())
    async with lock:  # one download per call even if the player fires several range requests
        path = find_cached(conversation)
        if path:
            return path
        return await download_mp3(audio_url, cached_path(conversation))
