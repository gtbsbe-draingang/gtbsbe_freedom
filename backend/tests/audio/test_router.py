import httpx
import pytest
from fastapi import FastAPI

import audio.recording as recording
import audio.router as audio_router
from app.errors import install_error_handlers

MP3 = b"ID3" + bytes(range(256)) * 40


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("AUDIO_CACHE_DIR", str(tmp_path))
    app = FastAPI()
    install_error_handlers(app)
    app.include_router(audio_router.router, prefix="/api")
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


async def test_serves_cached_recording_with_ranges(client, tmp_path, monkeypatch):
    (tmp_path / "DEV__p4-ru-001.mp3").write_bytes(MP3)
    monkeypatch.setattr(recording, "audio_url_for", lambda c: pytest.fail("must not resolve a cached call"))
    async with client:
        full = await client.get("/api/conversations/DEV:p4-ru-001/audio")
        part = await client.get("/api/conversations/DEV:p4-ru-001/audio", headers={"Range": "bytes=100-199"})
    assert full.status_code == 200 and full.content == MP3
    assert full.headers["content-type"] == "audio/mpeg"
    assert part.status_code == 206 and part.content == MP3[100:200]
    assert part.headers["content-range"] == f"bytes 100-199/{len(MP3)}"


async def test_downloads_once_then_serves(client, tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(recording, "audio_url_for", lambda c: "https://player.example.test/p?sig=S")

    async def fake_download(url, dest, client=None):
        calls.append(url)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(MP3)
        return dest

    monkeypatch.setattr(recording, "download_mp3", fake_download)
    async with client:
        a = await client.get("/api/conversations/DEV:p4-ru-002/audio")
        b = await client.get("/api/conversations/DEV:p4-ru-002/audio", headers={"Range": "bytes=0-9"})
    assert a.status_code == 200 and b.status_code == 206
    assert len(calls) == 1


async def test_no_recording_is_404_in_the_error_shape(client, monkeypatch):
    monkeypatch.setattr(recording, "audio_url_for", lambda c: None)
    async with client:
        r = await client.get("/api/conversations/DEV:p1-ru-001/audio")
    assert r.status_code == 404
    assert r.json() == {"error": "audio_unavailable",
                        "message": "This conversation has no recording. Import its group to get one."}


async def test_fetch_failure_is_502_without_the_link(client, monkeypatch):
    from audio.source import AudioSourceError

    monkeypatch.setattr(recording, "audio_url_for", lambda c: "https://player.example.test/p?sig=SECRET")

    async def failing(url, dest, client=None):
        raise AudioSourceError("player page on player.example.test answered 403")

    monkeypatch.setattr(recording, "download_mp3", failing)
    async with client:
        r = await client.get("/api/conversations/DEV:p4-ru-003/audio")
    assert r.status_code == 502 and "SECRET" not in r.text and "sig" not in r.text
