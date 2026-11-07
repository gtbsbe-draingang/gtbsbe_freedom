"""Transcript line to position in the recording (issue #28).

What the DEV calls show:
- A call timestamp marks the END of an utterance, not its start.
- The recording skips the stretches between the "paused" and "resumed" system events, and starts
  at the "recording started" event.
- After removing those, one constant shift per call remains (about +4.4 s on four DEV calls,
  +0.4 s on the fifth). It is found by matching the transcript against speech activity.

Each line's start is then estimated from its end and its length, and snapped to the nearest
speech onset in the audio. Lines that fall outside the recording get no offset.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import numpy as np

from audio.vad import HOP, onsets

CHARS_PER_SECOND = 14.0
SEARCH = (-45.0, 45.0, 0.2)  # seconds: from, to, step
SNAP = 1.5  # seconds around the estimated start in which a speech onset is accepted

START_WORDS = ("запущены", "басталды", "recording started", "transcription started")
PAUSE_WORDS = ("приостановлены", "тоқтатылды", "уақытша тоқтатылды", "paused")
RESUME_WORDS = ("возобновлены", "жалғастырылды", "қайта басталды", "resumed")
SPOKEN = ("client", "operator", "bot")


@dataclass
class Line:
    index: int
    speaker: str
    text: str
    t: float  # seconds from the first line, transcript clock


def _has(text: str, words) -> bool:
    low = text.lower()
    return any(w in low for w in words)


def parse_lines(transcript: list[dict]) -> list[Line]:
    times = [datetime.fromisoformat(m["timestamp"]).timestamp() for m in transcript]
    t0 = times[0]
    return [Line(i, m["speaker"], m["text"], times[i] - t0) for i, m in enumerate(transcript)]


def recording_clock(lines: list[Line]):
    """Function from transcript time to recording time (None when not recorded)."""
    start = 0.0
    for ln in lines:
        if ln.speaker == "system" and _has(ln.text, START_WORDS):
            start = ln.t
            break
    pauses, opened = [], None
    for ln in lines:
        if ln.speaker != "system":
            continue
        if _has(ln.text, PAUSE_WORDS):
            opened = ln.t
        elif _has(ln.text, RESUME_WORDS) and opened is not None:
            pauses.append((opened, ln.t))
            opened = None

    def to_rec(t: float) -> float | None:
        if t < start - 0.5:
            return None
        y = t - start
        for a, b in pauses:
            if t >= b:
                y -= b - a
            elif t > a:
                return None  # said while recording was paused
        return max(0.0, y)

    return to_rec, start, pauses


def _duration(text: str) -> float:
    return float(np.clip(len(text) / CHARS_PER_SECOND, 0.6, 12.0))


def _track(ends: list[tuple[float, float]], n: int) -> np.ndarray:
    tr = np.zeros(n, np.float32)
    for end, dur in ends:
        a, b = int((end - dur) / HOP), int(end / HOP)
        tr[max(0, a):max(0, min(n, b))] = 1.0
    return tr


def best_shift(ends: list[tuple[float, float]], speech: np.ndarray) -> tuple[float, float]:
    """The constant shift that best lines up transcript speech with audio speech, and its score."""
    base = _track(ends, len(speech))
    best = (-1.0, 0.0)
    lo, hi, step = SEARCH
    for c in np.arange(lo, hi + step / 2, step):
        k = int(round(c / HOP))
        tr = np.zeros_like(base)
        if k >= 0:
            tr[k:] = base[: len(base) - k]
        else:
            tr[:k] = base[-k:]
        on = tr.sum()
        if on == 0:
            continue
        inside = float((tr * speech).sum() / on)
        outside = float(((1 - tr) * speech).sum() / max(1.0, (1 - tr).sum()))
        score = inside - outside
        if score > best[0]:
            best = (score, float(c))
    return best[1], best[0]


def compute_spans(transcript: list[dict], speech: np.ndarray, duration: float) -> tuple[list[dict], dict]:
    """[{message_index, speaker, text, start, end}] in recording seconds for every line inside it."""
    lines = parse_lines(transcript)
    to_rec, rec_start, pauses = recording_clock(lines)
    spoken = [(ln, to_rec(ln.t)) for ln in lines if ln.speaker in SPOKEN]
    spoken = [(ln, r) for ln, r in spoken if r is not None]
    shift, score = best_shift([(r, _duration(ln.text)) for ln, r in spoken], speech)
    starts_on = onsets(speech)

    spans, prev_end = [], 0.0
    for ln in lines:
        r = to_rec(ln.t)
        if r is None:
            continue
        end = r + shift
        if ln.speaker in SPOKEN:
            start = max(end - _duration(ln.text), prev_end - 0.3)
            near = starts_on[np.abs(starts_on - start) <= SNAP] if len(starts_on) else starts_on
            if len(near):
                start = float(near[np.argmin(np.abs(near - start))])
            prev_end = max(prev_end, end)
        else:
            start = end  # an event has no duration
        if -1.0 <= start <= duration + 1.0:
            start = min(max(start, 0.0), duration)
            spans.append({"message_index": ln.index, "speaker": ln.speaker, "text": ln.text,
                          "start": start, "end": min(max(end, start), duration)})
    info = {"shift_seconds": round(shift, 1), "match_score": round(score, 3), "recording_start": round(rec_start, 1),
            "pauses": [[round(a, 1), round(b - a, 1)] for a, b in pauses], "lines_mapped": len(spans)}
    return spans, info


def compute_offsets(transcript: list[dict], speech: np.ndarray, duration: float) -> tuple[list[dict], dict]:
    """[{message_index, seconds}] for every line inside the recording, plus diagnostics."""
    spans, info = compute_spans(transcript, speech, duration)
    return [{"message_index": s["message_index"], "seconds": round(s["start"], 1)} for s in spans], info
