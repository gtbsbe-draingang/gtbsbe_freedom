"""Find and fetch a call recording.

A record's `audio_url` returns an HTML player page, not audio. The page's `<source src>` is a
signed MP3 link on the Dynamics host that expires in about an hour, so it is resolved fresh
every time and never stored or logged. Error messages name the host at most.
"""

from __future__ import annotations

import html
import logging
import re
from pathlib import Path
from urllib.parse import urlsplit

import httpx

_SOURCE = re.compile(r"<source\b[^>]*\bsrc\s*=\s*([\"'])(.*?)\1", re.IGNORECASE | re.DOTALL)
TIMEOUT = httpx.Timeout(60.0, connect=15.0)


class _RedactRequestURLs(logging.Filter):
    def filter(self, record):
        def redact(match):
            url = match.group()
            return "<redacted>" if re.search(r"[?&](?:sig|signature|token)=", url, re.I) else url
        record.msg = re.sub(r"https?://[^\s\"']+", redact, record.getMessage())
        record.args = ()
        return True


# httpx logs request URLs at INFO, including signed queries. Sanitize before handlers.
for _logger in ("httpx", "httpcore", "httpcore.connection", "httpcore.http11", "httpcore.http2", "httpcore.proxy", "httpcore.socks"):
    logging.getLogger(_logger).addFilter(_RedactRequestURLs())


class AudioSourceError(Exception):
    """The recording could not be found or fetched. The message never holds a URL."""


def host_of(url: str) -> str:
    return urlsplit(url).hostname or "?"


def parse_player_page(page: str) -> str:
    """The MP3 link inside the organisers' player page."""
    m = _SOURCE.search(page)
    if not m:
        raise AudioSourceError("player page has no <source src>")
    url = html.unescape(m.group(2)).strip()
    if not url.lower().startswith("https://"):
        raise AudioSourceError("player page source is not an https link")
    return url


def _decode(resp: httpx.Response) -> str:
    # The page is served without a reliable charset; the link itself is ASCII either way.
    return resp.content.decode(resp.encoding or "utf-8", errors="replace")


async def resolve_mp3_url(audio_url: str, client: httpx.AsyncClient | None = None) -> str:
    """Player page to the signed MP3 link (expires in about an hour). Never store the result."""
    own = client is None
    client = client or httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True)
    try:
        resp = await client.get(audio_url)
    except httpx.HTTPError as e:
        raise AudioSourceError(f"player page request to {host_of(audio_url)} failed: {type(e).__name__}") from None
    finally:
        if own:
            await client.aclose()
    if resp.status_code != 200:
        raise AudioSourceError(f"player page on {host_of(audio_url)} answered {resp.status_code}")
    ctype = resp.headers.get("content-type", "")
    if ctype.startswith("audio/"):
        return audio_url  # already audio: nothing to resolve
    return parse_player_page(_decode(resp))


async def download_mp3(audio_url: str, dest: Path, client: httpx.AsyncClient | None = None) -> Path:
    """Resolve the link and save the recording to `dest`, atomically."""
    own = client is None
    client = client or httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        mp3_url = await resolve_mp3_url(audio_url, client)
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            async with client.stream("GET", mp3_url) as resp:
                if resp.status_code != 200:
                    raise AudioSourceError(f"recording on {host_of(mp3_url)} answered {resp.status_code}")
                with tmp.open("wb") as f:
                    async for chunk in resp.aiter_bytes(1 << 16):
                        f.write(chunk)
        except httpx.HTTPError as e:
            raise AudioSourceError(f"recording download from {host_of(mp3_url)} failed: {type(e).__name__}") from None
        with tmp.open("rb") as stream:
            head = stream.read(3)
        if not (head == b"ID3" or head[:1] == b"\xff"):
            raise AudioSourceError("downloaded file is not an MP3")
        tmp.replace(dest)
        return dest
    finally:
        tmp.unlink(missing_ok=True)
        if own:
            await client.aclose()
