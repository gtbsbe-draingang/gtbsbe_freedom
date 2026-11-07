"""Bounded in-memory URL cache; refresh an expired recording once."""
from collections import OrderedDict
from hashlib import sha256
from time import monotonic

import httpx

from audio.source import AudioSourceError, resolve_mp3_url

TTL = 3000.0
MAX_ENTRIES = 128
_cache = OrderedDict()


async def resolve(player: str, client: httpx.AsyncClient, *, refresh=False) -> str:
    key = sha256(player.encode()).hexdigest()
    now = monotonic()
    for expired in [k for k, (deadline, _) in _cache.items() if deadline <= now]:
        _cache.pop(expired, None)
    entry = _cache.get(key)
    if entry and not refresh:
        _cache.move_to_end(key)
        return entry[1]
    _cache.pop(key, None)
    url = await resolve_mp3_url(player, client)
    _cache[key] = (now + TTL, url)
    while len(_cache) > MAX_ENTRIES:
        _cache.popitem(last=False)
    return url


async def open_audio(player: str, client: httpx.AsyncClient, range_header=None):
    headers = {"Accept-Encoding": "identity"}
    if range_header:
        headers["Range"] = range_header
    for attempt in range(2):
        url = await resolve(player, client, refresh=bool(attempt))
        response = await client.send(client.build_request("GET", url, headers=headers), stream=True)
        if response.status_code in (200, 206, 416):
            content_type = response.headers.get("content-type", "").split(";")[0].lower()
            if response.status_code != 416 and content_type not in ("audio/mpeg", "audio/mp3", "application/octet-stream"):
                await response.aclose()
                raise AudioSourceError("Recording response was not audio")
            return response
        retry = response.status_code in (403, 404, 410) and attempt == 0
        await response.aclose()
        if not retry:
            raise AudioSourceError("Recording request failed")
    raise AudioSourceError("Recording request failed")
