"""Save the recordings of a dataset file for development.

    uv run python -m audio.fetch_dev ../data/dev.json ../data/audio

Writes `<conversation_id>.mp3` for every record with an `audio_url`. `data/audio/` holds real
customer calls and is never committed. Prints conversation ids and sizes only, never links.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx

from audio.source import TIMEOUT, AudioSourceError, download_mp3


async def main(dataset: Path, out_dir: Path, force: bool = False) -> int:
    records = json.loads(dataset.read_text(encoding="utf-8"))["data"]["records"]
    calls = [r for r in records if r.get("audio_url")]
    failed = 0
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
        for r in calls:
            dest = out_dir / f"{r['conversation_id']}.mp3"
            if dest.exists() and not force:
                print(f"{r['conversation_id']}: kept ({dest.stat().st_size} bytes)")
                continue
            try:
                await download_mp3(r["audio_url"], dest, client)
                print(f"{r['conversation_id']}: saved ({dest.stat().st_size} bytes)")
            except AudioSourceError as e:
                failed += 1
                print(f"{r['conversation_id']}: FAILED, {e}")
    return 1 if failed else 0


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--force"]
    sys.exit(asyncio.run(main(Path(args[0]), Path(args[1]), "--force" in sys.argv)))
