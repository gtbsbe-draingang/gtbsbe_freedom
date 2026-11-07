"""Where recordings are cached on disk. `data/audio/` holds real customer calls and is never committed."""

from __future__ import annotations

import os
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def cache_dir() -> Path:
    return Path(os.environ.get("AUDIO_CACHE_DIR") or REPO_ROOT / "data" / "audio")


def cached_path(conversation: str) -> Path:
    """`<group>:<conversation_id>` to a file name that is safe on every OS."""
    safe = re.sub(r"[^A-Za-z0-9._-]+", "__", conversation).strip("._")
    if not safe:
        raise ValueError("empty conversation id")
    return cache_dir() / f"{safe}.mp3"


def find_cached(conversation: str) -> Path | None:
    """The cached file, also accepting the bare `<conversation_id>.mp3` that `fetch_dev` writes."""
    for p in (cached_path(conversation), cache_dir() / f"{conversation.split(':')[-1]}.mp3"):
        if p.is_file() and p.stat().st_size > 0:
            return p
    return None
