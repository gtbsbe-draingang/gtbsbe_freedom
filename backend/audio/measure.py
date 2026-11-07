"""Voice measurements for the operator's lines (issue #29).

Per operator line, from its span in the recording: pitch range (semitones), speaking rate (words
per minute of speech), pauses inside the line, overlap with the client, and pitch level and
loudness relative to the operator's own median in this call. These are facts handed to the
evaluator; they never score anything by themselves. Mono phone audio means the speaker of a
stretch is known only from the transcript, so every number is approximate.
"""

from __future__ import annotations

import re

import numpy as np

from audio.vad import HOP

MIN_SECONDS = 0.8
PAUSE_GAP = 0.3  # seconds of silence that count as a pause inside a line
WORD = re.compile(r"\w+", re.UNICODE)


def _f0(x: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    """Frame times and F0 in Hz (0 when unvoiced), with Praat's autocorrelation pitch."""
    import parselmouth

    snd = parselmouth.Sound(x.astype(np.float64), sampling_frequency=sr)
    pitch = snd.to_pitch(time_step=0.01, pitch_floor=75.0, pitch_ceiling=500.0)
    return pitch.xs(), pitch.selected_array["frequency"]


def _semitones(hz: np.ndarray, ref: float) -> np.ndarray:
    return 12.0 * np.log2(hz / ref)


def _frames(speech: np.ndarray, a: float, b: float) -> np.ndarray:
    return speech[max(0, int(a / HOP)):max(0, int(b / HOP))]


def _pause_seconds(seg: np.ndarray) -> float:
    on = np.where(seg > 0)[0]
    if len(on) < 2:
        return 0.0
    inner = seg[on[0]:on[-1] + 1]
    total, run = 0, 0
    for v in inner:
        if v > 0:
            if run * HOP >= PAUSE_GAP:
                total += run
            run = 0
        else:
            run += 1
    return total * HOP


def measure_operator(x: np.ndarray, sr: int, speech: np.ndarray, spans: list[dict]) -> list[dict]:
    """voice_measurements for every operator line long enough to measure."""
    times, f0 = _f0(x, sr)
    hop_n = int(sr * HOP)
    frames = x[: len(x) // hop_n * hop_n].reshape(-1, hop_n)
    db = 10 * np.log10(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-10)
    clients = [(s["start"], s["end"]) for s in spans if s["speaker"] == "client"]

    rows = []
    for s in spans:
        if s["speaker"] != "operator" or s["end"] - s["start"] < MIN_SECONDS:
            continue
        a, b = s["start"], s["end"]
        seg = _frames(speech, a, b)
        speech_s = float(seg.sum() * HOP)
        voiced = f0[(times >= a) & (times < b) & (f0 > 0)]
        loud = db[max(0, int(a / HOP)):int(b / HOP)][seg > 0] if len(seg) else np.array([])
        overlap = 0.0
        for ca, cb in clients:
            lo, hi = max(a, ca), min(b, cb)
            if hi > lo:
                overlap += float(_frames(speech, lo, hi).sum() * HOP)
        words = len(WORD.findall(s["text"]))
        rows.append({
            "message_index": s["message_index"],
            "from_seconds": round(a, 1),
            "to_seconds": round(b, 1),
            "_voiced": voiced,
            "_loud": float(np.median(loud)) if len(loud) else None,
            "rate_wpm": round(words / speech_s * 60.0, 0) if speech_s >= 0.5 and words else None,
            "pauses": round(_pause_seconds(seg), 1),
            "overlap": round(overlap, 1),
        })

    all_voiced = np.concatenate([r["_voiced"] for r in rows if len(r["_voiced"])] or [np.array([])])
    ref = float(np.median(all_voiced)) if len(all_voiced) else None
    louds = [r["_loud"] for r in rows if r["_loud"] is not None]
    ref_db = float(np.median(louds)) if louds else None
    for r in rows:
        v = r.pop("_voiced")
        loud = r.pop("_loud")
        if ref and len(v) >= 10:
            st = _semitones(v, ref)
            r["pitch_range"] = round(float(np.percentile(st, 90) - np.percentile(st, 10)), 1)
            r["pitch_median_rel"] = round(float(np.median(st)), 1)
        else:
            r["pitch_range"] = None
            r["pitch_median_rel"] = None
        r["loudness_rel_db"] = round(loud - ref_db, 1) if loud is not None and ref_db is not None else None
    return rows
