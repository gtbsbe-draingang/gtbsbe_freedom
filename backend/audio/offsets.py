"""Transcript line to position in the recording (issues #28, #93). No speech recogniser.

What the five DEV calls show (measured against a recogniser's word timings, used offline only):
- A call timestamp marks the END of an utterance, not its start.
- The recording skips the stretches between the "paused" and "resumed" system events, and starts
  at the "recording started" event.
- After removing those, a constant delay per call and SPEAKER TYPE remains: human lines (client,
  operator) end about +4 s after their timestamp (+3.5..+4.3 s; about 0 on p4-ru-002), the bot's
  lines about 1 s before theirs (-0.5..-1.4 s). Each is found by matching the transcript against
  speech activity, the bot's in a narrow window since it has few lines. With it, ends are within
  0.5 s (median).
- People speak about 15.4 characters a second.

Each spoken line's start is then the speech onset nearest to "end minus estimated length", not
before the same speaker's previous line ended. Another speaker's line may overlap: a client's
"угу" during a long operator answer must not push the answer's start past it. Lines that fall
outside the recording get no offset. On 168 lines: median 0.48 s, 86% within 2 s, max 9 s
(1.0 s / 76% / 20 s before).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import numpy as np

from audio.vad import HOP, onsets

CHARS_PER_SECOND = 15.4  # fitted on the five DEV calls (#93); 14 to 16.5 give 83-86% within 2 s
MIN_LINE_SECONDS, MAX_LINE_SECONDS = 0.6, 30.0
SEARCH = (-45.0, 45.0, 0.2)  # seconds: from, to, step; human lines
BOT_SEARCH = (-3.0, 1.0, 0.1)  # the bot's delay; a wide window lets its few lines lock on the wrong speech
WINDOW = 2.2  # speech onsets are searched back to this many line lengths (plus 1 s) before the end
OVERLAP = 0.3  # seconds a line may start before the same speaker's previous line ended

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
    if not transcript:
        return []
    times = [datetime.fromisoformat(m["timestamp"]).timestamp() for m in transcript]
    t0 = times[0]
    return [Line(i, m["speaker"], m["text"], times[i] - t0) for i, m in enumerate(transcript) if not m.get("duplicate")]


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
            if opened is None:
                opened = ln.t
        elif _has(ln.text, RESUME_WORDS) and opened is not None:
            pauses.append((opened, ln.t))
            opened = None

    def to_rec(t: float) -> float | None:
        if t < start or (opened is not None and t >= opened):
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
    return float(np.clip(len(text) / CHARS_PER_SECOND, MIN_LINE_SECONDS, MAX_LINE_SECONDS))


def _track(ends: list[tuple[float, float]], n: int) -> np.ndarray:
    tr = np.zeros(n, np.float32)
    for end, dur in ends:
        a, b = int((end - dur) / HOP), int(end / HOP)
        tr[max(0, a):max(0, min(n, b))] = 1.0
    return tr


def best_shift(ends: list[tuple[float, float]], speech: np.ndarray, search=SEARCH) -> tuple[float, float]:
    """The constant shift that best lines up transcript speech with audio speech, and its score."""
    base = _track(ends, len(speech))
    best = (-1.0, 0.0)
    lo, hi, step = search
    for c in np.arange(lo, hi + step / 2, step):
        k = int(round(c / HOP))
        if abs(k) >= len(base):
            continue
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
    human = [(r, _duration(ln.text)) for ln, r in spoken if ln.speaker != "bot"]
    bot = [(r, _duration(ln.text)) for ln, r in spoken if ln.speaker == "bot"]
    shift, score = best_shift(human, speech) if human else (0.0, 0.0)
    bot_shift = best_shift(bot, speech, BOT_SEARCH)[0] if bot else 0.0
    starts_on = onsets(speech)

    spans, said_until = [], {}  # speaker -> end of their latest line
    for ln in lines:
        r = to_rec(ln.t)
        if r is None:
            continue
        if ln.speaker in SPOKEN:
            end = r + (bot_shift if ln.speaker == "bot" else shift)
            length = _duration(ln.text)
            start = max(end - length, said_until.get(ln.speaker, 0.0) - OVERLAP)
            near = starts_on[(starts_on >= end - WINDOW * length - 1.0) & (starts_on <= end - OVERLAP)]
            if len(near):
                start = float(near[np.argmin(np.abs(near - start))])
            start = min(start, end - OVERLAP)
            said_until[ln.speaker] = max(said_until.get(ln.speaker, 0.0), end)
        else:
            end = r + shift
            start = end  # an event has no duration
        if -1.0 <= start <= duration + 1.0:
            start = min(max(start, 0.0), duration)
            spans.append({"message_index": ln.index, "speaker": ln.speaker, "text": ln.text,
                          "start": start, "end": min(max(end, start), duration)})
    info = {"shift_seconds": round(shift, 1), "bot_shift_seconds": round(bot_shift, 1), "match_score": round(score, 3),
            "recording_start": round(rec_start, 1), "pauses": [[round(a, 1), round(b - a, 1)] for a, b in pauses],
            "lines_mapped": len(spans)}
    return spans, info


def compute_offsets(transcript: list[dict], speech: np.ndarray, duration: float) -> tuple[list[dict], dict]:
    """[{message_index, seconds}] for every line inside the recording, plus diagnostics."""
    spans, info = compute_spans(transcript, speech, duration)
    return [{"message_index": s["message_index"], "seconds": round(s["start"], 1)} for s in spans], info
