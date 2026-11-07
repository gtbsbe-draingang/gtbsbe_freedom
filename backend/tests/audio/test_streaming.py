import logging
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from app.errors import install_error_handlers
import audio.router as route
import audio.resolve as resolver

PLAYER = "https://player.example.test/p?token=PLAYERSECRET"
MEDIA = "https://media.example.test/a.mp3?token=MEDIASECRET"
MP3 = b"ID3" + bytes(range(256)) * 10


@pytest.fixture
def setup(monkeypatch):
    resolver._cache.clear()
    store = SimpleNamespace(get_conversation=lambda _: SimpleNamespace(channel="voice call"),
                            get_audio_url=lambda _: PLAYER)
    monkeypatch.setattr(route, "get_store", lambda: store)
    app = FastAPI()
    install_error_handlers(app)
    app.include_router(route.router, prefix="/api")
    return app, store


async def test_stream_range_cache_and_safe_headers(setup, monkeypatch, caplog, tmp_path):
    app, _ = setup
    calls, clients = [], []
    def upstream(request):
        calls.append(request)
        if request.url.host == 'player.example.test':
            return httpx.Response(200, text=f'<source src="{MEDIA}">')
        part = request.headers.get('range')
        headers = {'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Location': MEDIA,
                   'Set-Cookie': 'secret=x', 'X-Upstream-URL': MEDIA}
        if part:
            assert part == 'bytes=100-199'
            headers['Content-Range'] = f'bytes 100-199/{len(MP3)}'
        body = MP3[100:200] if part else MP3
        headers['Content-Length'] = str(len(body))
        return httpx.Response(206 if part else 200, headers=headers, stream=httpx.ByteStream(body))
    def factory():
        client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        clients.append(client)
        return client
    monkeypatch.setattr(route, 'make_client', factory)
    caplog.set_level(logging.INFO, logger='httpx')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        full = await client.get('/api/conversations/DEV:call/audio')
        part = await client.get('/api/conversations/DEV:call/audio', headers={'Range': 'bytes=100-199'})
    assert full.content == MP3 and full.status_code == 200
    assert part.content == MP3[100:200] and part.status_code == 206
    assert part.headers['content-range'] == f'bytes 100-199/{len(MP3)}'
    assert len([r for r in calls if r.url.host == 'player.example.test']) == 1
    assert all(c.is_closed for c in clients)
    assert not list(tmp_path.glob('*.mp3'))
    for key in ('location', 'set-cookie', 'x-upstream-url'):
        assert key not in full.headers
    assert 'SECRET' not in caplog.text
    assert 'SECRET' not in str(full.headers)


@pytest.mark.parametrize('expired_status', [403, 404, 410])
async def test_expired_url_refreshed_once(setup, monkeypatch, expired_status):
    app, _ = setup
    count = {'page': 0, 'audio': 0}
    def upstream(request):
        if request.url.host == 'player.example.test':
            count['page'] += 1
            return httpx.Response(200, text=f'<source src="{MEDIA}">')
        count['audio'] += 1
        return httpx.Response(expired_status)
    monkeypatch.setattr(route, 'make_client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(upstream)))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        result = await client.get('/api/conversations/DEV:call/audio')
    assert result.status_code == 502 and count == {'page': 2, 'audio': 2}
    assert 'SECRET' not in result.text


async def test_unknown_chat_missing_audio_and_range_error(setup, monkeypatch):
    app, store = setup
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        store.get_conversation = lambda _: None
        assert (await client.get('/api/conversations/unknown/audio')).json()['error'] == 'not_found'
        store.get_conversation = lambda _: SimpleNamespace(channel='agent chat')
        assert (await client.get('/api/conversations/chat/audio')).status_code == 404
        store.get_conversation = lambda _: SimpleNamespace(channel='voice call')
        store.get_audio_url = lambda _: None
        assert (await client.get('/api/conversations/call/audio')).status_code == 404
        store.get_audio_url = lambda _: PLAYER
        def upstream(request):
            if request.url.host == 'player.example.test':
                return httpx.Response(200, text=f'<source src="{MEDIA}">')
            return httpx.Response(416, headers={'Content-Range': f'bytes */{len(MP3)}'})
        monkeypatch.setattr(route, 'make_client', lambda: httpx.AsyncClient(transport=httpx.MockTransport(upstream)))
        result = await client.get('/api/conversations/call/audio', headers={'Range': 'bytes=999999-'})
        assert result.status_code == 416 and not result.content
        assert result.headers['content-range'] == f'bytes */{len(MP3)}'


async def test_ttl_expiration(monkeypatch):
    resolver._cache.clear()
    calls = []
    async def resolve(url, client):
        calls.append(url)
        return MEDIA
    monkeypatch.setattr(resolver, 'resolve_mp3_url', resolve)
    monkeypatch.setattr(resolver, 'monotonic', lambda: 0)
    await resolver.resolve(PLAYER, None)
    monkeypatch.setattr(resolver, 'monotonic', lambda: resolver.TTL - 1)
    await resolver.resolve(PLAYER, None)
    assert len(calls) == 1
    monkeypatch.setattr(resolver, 'monotonic', lambda: resolver.TTL)
    await resolver.resolve(PLAYER, None)
    assert len(calls) == 2
