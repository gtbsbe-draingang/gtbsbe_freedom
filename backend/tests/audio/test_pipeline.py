import sys
from types import SimpleNamespace

import numpy as np

from app.models import AudioOffset, Message, VoiceMeasurement
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
    monkeypatch.setattr(pipeline, 'compute_spans', lambda *a: ([dict(message_index=0, start=0., end=1.)], {}))
    monkeypatch.setattr(pipeline, 'measure_operator', lambda *a: [dict(message_index=0, from_seconds=0.,
        to_seconds=1., pitch_range=4., rate_wpm=120., pauses=0., overlap=3.)])
    offsets, measurements = analyse([Message(timestamp='2026-01-01T00:00:00Z', speaker='operator', text='Hi')],
                                    np.zeros(16000), 16000)
    assert isinstance(offsets[0], AudioOffset)
    assert isinstance(measurements[0], VoiceMeasurement) and measurements[0].overlap is None


async def test_processing_storage_failure_does_not_escape_or_leak(monkeypatch, caplog):
    def fail(_):
        raise RuntimeError('https://private.example/?token=SECRET')
    monkeypatch.setitem(sys.modules, 'app.store', SimpleNamespace(get_conversation=fail))
    await process_call('DEV:call')
    assert 'processing failed' in caplog.text and 'SECRET' not in caplog.text
