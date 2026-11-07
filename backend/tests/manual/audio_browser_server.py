"""Opt-in browser acceptance server using private DEV MP3s and a replayed upstream.

Run from backend/ with the locked environment:
  python tests/manual/audio_browser_server.py --audio-dir /private/data/audio
Then run web/test/e2e/audio.mjs. This harness never contacts the organizer.
"""
import argparse
import os
import tempfile
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import uvicorn
from fastapi.responses import HTMLResponse


class Chunks(httpx.AsyncByteStream):
    def __init__(self, data):
        self.data = data

    async def __aiter__(self):
        for i in range(0, len(self.data), 65536):
            yield self.data[i:i + 65536]


def build_app(audio_dir: Path):
    from app import store
    from app.main import create_app, lifespan
    from app.models import Conversation
    from audio import resolve
    import audio.router as audio_router

    calls = {f'p4-ru-{i:03}': (audio_dir / f'p4-ru-{i:03}.mp3').read_bytes()
             for i in range(1, 6)}
    stats = defaultdict(lambda: dict(resolutions=0, expired=0, ranges=0))
    resolve._cache.clear()

    async def upstream(request):
        parts = request.url.path.strip('/').split('/')
        kind, call = parts[:2]
        if call not in calls:
            return httpx.Response(404)
        row = stats[call]
        if kind == 'player':
            row['resolutions'] += 1
            generation = row['resolutions']
            return httpx.Response(200, text=(
                f'<audio><source src="https://fixture.invalid/mp3/{call}/{generation}"></audio>'
            ), headers={'content-type': 'text/html'})
        if parts[-1] == '1':
            row['expired'] += 1
            return httpx.Response(403)
        data = calls[call]
        total = len(data)
        headers = {'content-type': 'audio/mpeg', 'accept-ranges': 'bytes'}
        status = 200
        if value := request.headers.get('range'):
            row['ranges'] += 1
            start, end = value.removeprefix('bytes=').split('-')
            if start:
                start, end = int(start), min(int(end), total - 1) if end else total - 1
            else:
                start, end = max(0, total - int(end)), total - 1
            if start >= total or start > end:
                return httpx.Response(416, headers={'content-range': f'bytes */{total}'})
            data = data[start:end + 1]
            headers['content-range'] = f'bytes {start}-{end}/{total}'
            status = 206
        headers['content-length'] = str(len(data))
        return httpx.Response(status, headers=headers, stream=Chunks(data))

    audio_router.make_client = lambda: httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    app = create_app()

    @asynccontextmanager
    async def seeded_lifespan(app):
        async with lifespan(app):
            for call in calls:
                store.upsert_conversation(Conversation(
                    id=f'DEV:{call}', group_id='DEV', conversation_id=call,
                    language='RU', channel='voice call', transcript=[],
                    audio=f'api/conversations/DEV:{call}/audio',
                ), f'https://fixture.invalid/player/{call}')
            yield

    app.router.lifespan_context = seeded_lifespan

    @app.get('/_audio_check', response_class=HTMLResponse)
    def page():
        return '<!doctype html><html><title>Audio transport check</title><body></body></html>'

    @app.get('/_audio_check/stats')
    def counters():
        return dict(stats)

    return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audio-dir', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8766)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='cqa-audio-browser-') as tmp:
        os.environ['DB_PATH'] = str(Path(tmp) / 'check.db')
        # Do not read developer .env settings for a standalone local test server.
        from app.settings import Settings, get_settings
        Settings.model_config['env_file'] = None
        get_settings.cache_clear()
        uvicorn.run(build_app(args.audio_dir), host='127.0.0.1', port=args.port,
                    access_log=False, log_level='warning')
