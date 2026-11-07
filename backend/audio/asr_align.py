"""Snap transcript line starts to the words a speech recogniser hears (issue #28).

The transcript gives each line's END accurately once the recording clock and the per-call shift
are applied (`audio.offsets`). Its START has to be guessed from the line's length, and that guess
is what misses on long lines. Here the recording is run through faster-whisper with word
timestamps, and each line's first words are looked up among the recognised words heard shortly
before its end. A found match gives the start; no match keeps the length-based guess.

faster-whisper is optional (`uv sync --extra asr`). Without it, or if recognition fails, the
spans come back unchanged. The recogniser never scores anything and its text is not stored.

Measured on the five DEV calls against a separate whole-call alignment of the same recogniser's
words: 90% of 190 lines within 2 s (74% for the length guess alone). Both numbers lean on the
same recogniser, so they are not an independent acceptance check; see `tests/manual/
alignment_check.py` for the listening check.
"""

from __future__ import annotations

import logging
import re
from difflib import SequenceMatcher

import numpy as np

logger = logging.getLogger(__name__)

MODEL = "small"
LOOK_BACK = 40.0  # seconds before a line's end in which its first words are searched
LOOK_AHEAD = 2.0
FIRST_WORDS = 4
MIN_SIMILARITY = 0.6


def available() -> bool:
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        return False
    return True


def norm(word: str) -> str:
    return re.sub(r"[^\w]", "", word.lower().replace("ё", "е"))


def _sim(a: str, b: str) -> float:
    if a == b:
        return 1.0
    if min(len(a), len(b)) < 3:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def recognise(samples: np.ndarray, language: str = "ru") -> list[dict]:
    """[{"n": normalised word, "s": start seconds}] for 16 kHz mono float32 samples."""
    from faster_whisper import WhisperModel

    model = WhisperModel(MODEL, device="cpu", compute_type="int8")
    segments, _ = model.transcribe(samples.astype(np.float32), language=language, word_timestamps=True,
                                   vad_filter=True, beam_size=1)
    return [{"n": norm(w.word), "s": float(w.start)} for seg in segments for w in (seg.words or []) if norm(w.word)]


def match_start(text: str, words: list[dict], lo: float, hi: float) -> float | None:
    """Start time of the best run of recognised words that matches the line's first words."""
    wanted = [w for w in (norm(t) for t in text.split() if not t.startswith("[")) if w][:FIRST_WORDS]
    if len(wanted) < 2:
        return None
    best_score, best_j = 0.0, None
    for j, word in enumerate(words):
        if not lo <= word["s"] <= hi:
            continue
        if _sim(wanted[0], word["n"]) < MIN_SIMILARITY and _sim(wanted[1], word["n"]) < MIN_SIMILARITY:
            continue  # a run must begin on the line's first or second word
        score = 0.0
        for q, target in enumerate(wanted):
            near = [words[j + q + d]["n"] for d in (-1, 0, 1) if 0 <= j + q + d < len(words)]
            s = max((_sim(target, n) for n in near), default=0.0)
            score += s if s >= MIN_SIMILARITY else 0.0
        if score > best_score:
            best_score, best_j = score, j
    if best_j is None or best_score < min(2.0, 0.5 * len(wanted) + 0.5):
        return None
    return words[best_j]["s"]


def snap_spans(spans: list[dict], words: list[dict]) -> tuple[list[dict], int]:
    """Spans with spoken lines' starts moved to their matched words, and how many moved."""
    out, moved = [], 0
    for span in spans:
        span = dict(span)
        if span["speaker"] in ("client", "operator", "bot"):
            start = match_start(span["text"], words, span["end"] - LOOK_BACK, span["end"] + LOOK_AHEAD)
            if start is not None and start <= span["end"]:
                span["start"], moved = start, moved + 1
        out.append(span)
    return out, moved


def refine(spans: list[dict], samples: np.ndarray, language: str = "ru") -> tuple[list[dict], dict]:
    """Snap spans if faster-whisper is installed; otherwise return them unchanged."""
    if not available():
        return spans, {"asr": "not installed"}
    try:
        words = recognise(samples, language)
    except Exception:
        logger.warning("Speech recognition for alignment failed; keeping length-based starts")
        return spans, {"asr": "failed"}
    snapped, moved = snap_spans(spans, words)
    return snapped, {"asr": MODEL, "lines_snapped": moved}
