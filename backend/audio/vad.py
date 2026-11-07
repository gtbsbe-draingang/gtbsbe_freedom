"""Speech activity on mono phone audio, from frame energy. Light on purpose: no model, no GPU."""

from __future__ import annotations

from pathlib import Path

import numpy as np

HOP = 0.02  # seconds per frame
ABOVE_FLOOR_DB = 12.0
BRIDGE = 0.2  # seconds: gaps this short inside speech are bridged


def load_mono(path: Path | str, sr: int = 16000) -> np.ndarray:
    import soundfile as sf

    x, rate = sf.read(str(path), dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    if rate != sr:
        from scipy.signal import resample_poly

        x = resample_poly(x, sr, rate).astype(np.float32)
    return x


def speech_frames(x: np.ndarray, sr: int = 16000) -> np.ndarray:
    """1.0 for frames with speech, 0.0 otherwise; one frame per HOP seconds."""
    n = int(sr * HOP)
    if len(x) < n:
        return np.zeros(0, np.float32)
    frames = x[: len(x) // n * n].reshape(-1, n)
    db = 10 * np.log10(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-10)
    sp = db > np.percentile(db, 15) + ABOVE_FLOOR_DB
    k = int(BRIDGE / HOP)
    if k:
        # bridge short gaps: a frame is speech if speech is within k frames on both sides
        pad = np.concatenate([np.zeros(k, bool), sp, np.zeros(k, bool)])
        left = np.array([pad[i:i + k].any() for i in range(len(sp))])
        right = np.array([pad[i + k + 1:i + 2 * k + 1].any() for i in range(len(sp))])
        sp = sp | (left & right)
    return sp.astype(np.float32)


def onsets(speech: np.ndarray) -> np.ndarray:
    """Times in seconds where speech begins."""
    if not len(speech):
        return np.zeros(0)
    d = np.diff(np.concatenate([[0.0], speech]))
    return np.where(d > 0)[0] * HOP
