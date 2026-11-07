import numpy as np

from audio.measure import measure_operator
from audio.vad import HOP

SR = 16000


def tone(f_start, f_end, seconds):
    """A harmonic-rich glide from f_start to f_end Hz: something Praat can track as a voice."""
    t = np.arange(int(SR * seconds)) / SR
    f = np.geomspace(f_start, f_end, len(t))
    phase = 2 * np.pi * np.cumsum(f) / SR
    return (0.3 * np.sin(phase) + 0.15 * np.sin(2 * phase) + 0.08 * np.sin(3 * phase)).astype(np.float32)


def test_measurements_on_a_synthetic_call():
    silence = lambda s: np.zeros(int(SR * s), np.float32)  # noqa: E731
    # operator: 0 to 3 s, a glide 150 to 300 Hz (one octave, 12 semitones), then 1 s pause, then 2 s steady
    # client: 5 to 7 s, overlapping the operator's second part by 1 s
    op1 = tone(150, 300, 3.0)
    x = np.concatenate([op1, silence(1.0), tone(200, 200, 3.0), silence(3.0)])
    speech = np.zeros(int(len(x) / SR / HOP), np.float32)
    speech[: int(3.0 / HOP)] = 1
    speech[int(4.0 / HOP): int(7.0 / HOP)] = 1
    spans = [
        {"message_index": 3, "speaker": "operator", "text": "раз два три четыре пять шесть", "start": 0.0, "end": 7.0},
        {"message_index": 4, "speaker": "client", "text": "да", "start": 6.0, "end": 7.0},
    ]
    rows = measure_operator(x, SR, speech, spans)
    assert len(rows) == 1
    r = rows[0]
    assert r["message_index"] == 3 and r["from_seconds"] == 0.0 and r["to_seconds"] == 7.0
    assert 6.0 <= r["pitch_range"] <= 12.5  # 10th to 90th percentile of a 12 semitone glide plus a steady part
    assert r["pauses"] == 1.0
    assert r["overlap"] == 1.0
    assert r["rate_wpm"] == 60.0  # 6 words in 6 s of speech


def test_short_or_client_lines_are_skipped():
    x = np.zeros(SR * 2, np.float32)
    speech = np.zeros(int(2 / HOP), np.float32)
    spans = [{"message_index": 0, "speaker": "operator", "text": "да", "start": 0.0, "end": 0.5},
             {"message_index": 1, "speaker": "client", "text": "алло", "start": 0.5, "end": 2.0}]
    assert measure_operator(x, SR, speech, spans) == []
