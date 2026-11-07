import sys
from types import SimpleNamespace

import numpy as np

from app.models import AudioOffset, Message, VoiceMeasurement
from audio import pipeline as pipeline_mod
from audio.pipeline import analyse, process_call
from audio.offsets import compute_offsets, parse_lines, recording_clock


def test_empty_short_duplicate_and_open_pause():
    assert analyse([], np.zeros(0), 16000) == ([], [])
    offsets, _ = compute_offsets([], np.zeros(10), .2)
    assert offsets == []
    messages = [dict(timestamp=f'2026-01-01T00:00:0{i}+00:00', speaker=s, text=t, duplicate=d)
                for i, (s, t, d) in enumerate([
                    ('system', 'Recording started', False), ('operator', 'Hello', True),
                    ('system', 'Recording paused', False), ('operator', 'hidden', False)])]
    lines = parse_lines(messages)
    assert [l.index for l in lines] == [0, 2, 3]
    clock, _, _ = recording_clock(lines)
    assert clock(3) is None


def test_shared_models_and_unknown_overlap(monkeypatch):
    import audio.pipeline as pipeline
    monkeypatch.setattr(pipeline_mod, 'compute_spans', lambda *a: ([dict(message_index=0, start=0., end=1.)], {}))
    monkeypatch.setattr(pipeline_mod, 'measure_operator', lambda *a: [dict(message_index=0, from_seconds=0.,
        to_seconds=1., pitch_range=4., rate_wpm=120., pauses=0., overlap=3.)])
    offsets, measurements = analyse([Message(timestamp='2026-01-01T00:00:00Z', speaker='operator', text='Hi')],
                                    np.zeros(16000), 16000)
    assert isinstance(offsets[0], AudioOffset)
    assert isinstance(measurements[0], VoiceMeasurement) and measurements[0].overlap is None


async def test_processing_storage_failure_does_not_escape_or_leak(monkeypatch, caplog):
    import app
    def fail(_):
        raise RuntimeError('https://private.example/?token=SECRET')
    fake = SimpleNamespace(get_conversation=fail)
    monkeypatch.setitem(sys.modules, 'app.store', fake)
    monkeypatch.setattr(app, 'store', fake)
    await process_call('DEV:call')
    assert 'processing failed' in caplog.text and 'SECRET' not in caplog.text


async def test_production_gate_clears_previous_results_without_fetching(client, monkeypatch):
    from app import store
    from app.models import Conversation
    conv = Conversation(id='DEV:call', conversation_id='call', group_id='DEV',
                        channel='voice call', language='RU', transcript=[],
                        audio_offsets=[AudioOffset(message_index=0, seconds=20)])
    store.upsert_conversation(conv, None)
    def forbidden(*args, **kwargs):
        raise AssertionError('Unvalidated processing must not fetch audio')
    monkeypatch.setattr(store, 'get_audio_url', forbidden)
    await process_call(conv.id)
    data = client.get('/api/conversations/DEV:call').json()
    assert data['audio_offsets'] == [] and data['voice_measurements'] == []


def test_upgrade_removes_legacy_audio_evidence_before_serving(client):
    from app import store
    from app.db import connect, migrate
    from app.models import Conversation
    conv = Conversation(id='DEV:legacy', conversation_id='legacy', group_id='DEV',
                        channel='voice call', language='RU', transcript=[],
                        audio_offsets=[AudioOffset(message_index=0, seconds=20)],
                        voice_measurements=[VoiceMeasurement(message_index=0, from_seconds=20,
                            to_seconds=30, pitch_range=4, rate_wpm=120, pauses=1, overlap=None)])
    store.upsert_conversation(conv, None)
    conn = connect()
    try:
        conn.execute("DELETE FROM schema_migrations WHERE name = 'd_001_withhold_unvalidated_audio'")
        conn.commit()
    finally:
        conn.close()
    migrate()
    migrate()  # repeat startup is safe
    data = client.get('/api/conversations/DEV:legacy').json()
    assert data['audio_offsets'] == [] and data['voice_measurements'] == []
    assert store.get_conversation(conv.id).voice_measurements == []


def test_alignment_is_off_unless_switched_on(monkeypatch):
    monkeypatch.delenv("CQA_AUDIO_ALIGNMENT", raising=False)
    assert not pipeline_mod.alignment_enabled()
    monkeypatch.setenv("CQA_AUDIO_ALIGNMENT", " ON ")
    assert pipeline_mod.alignment_enabled()


async def test_switched_on_the_import_stores_offsets(client, monkeypatch):
    from app import store
    from app.models import AudioOffset, Conversation

    monkeypatch.setenv("CQA_AUDIO_ALIGNMENT", "on")
    conv = Conversation(id="DEV:call", conversation_id="call", group_id="DEV", channel="voice call",
                        language="RU", transcript=[])
    store.upsert_conversation(conv, "https://fixture.invalid/player/call")

    async def download(player):
        assert player == "https://fixture.invalid/player/call"
        return b"mp3"

    monkeypatch.setattr(pipeline_mod, "_download", download)
    monkeypatch.setattr(pipeline_mod, "decode", lambda data: (np.zeros(16000, np.float32), 16000))
    monkeypatch.setattr(pipeline_mod, "analyse", lambda *a: ([AudioOffset(message_index=0, seconds=1.5)], []))
    await pipeline_mod.process_call(conv.id)
    assert client.get("/api/conversations/DEV:call").json()["audio_offsets"] == [{"message_index": 0, "seconds": 1.5}]
