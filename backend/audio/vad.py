"""Speech activity on mono phone audio, from loudness and voicing. No model, no GPU.

Energy alone marks line noise and hold music as speech (74% of a DEV call on average, against
about 55% heard speech). A frame counts as speech when it is voiced (Praat finds a pitch) and at
least 6 dB above the call's noise floor; the mask is then widened over consonants and smoothed.
On the five DEV calls this lifts F1 against recognised words from 0.76 to 0.80, and from 0.54 to
0.72 on the call that is mostly hold (#93).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

HOP = 0.02  # seconds per frame
ABOVE_FLOOR_DB = 6.0
FLOOR_PERCENTILE = 15
PITCH_RANGE = (75.0, 450.0)  # Hz
WIDEN = 7  # frames: voicing is widened by 3 frames each side to cover unvoiced consonants
CLOSE = 0.3  # seconds: gaps shorter than this inside speech are closed
OPEN = 0.1  # seconds: speech shorter than this is dropped


def load_mono(path: Path | str, sr: int = 16000) -> np.ndarray:
    import soundfile as sf

    x, rate = sf.read(str(path), dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    if rate != sr:
        from scipy.signal import resample_poly

        x = resample_poly(x, sr, rate).astype(np.float32)
    return x


def _dilate(mask: np.ndarray, k: int) -> np.ndarray:
    return np.convolve(mask.astype(np.int32), np.ones(k, np.int32), "same") > 0 if k > 1 else mask


def _erode(mask: np.ndarray, k: int) -> np.ndarray:
    return np.convolve(mask.astype(np.int32), np.ones(k, np.int32), "same") >= k if k > 1 else mask


def _voiced(x: np.ndarray, sr: int, n_frames: int) -> np.ndarray:
    import parselmouth

    try:
        pitch = parselmouth.Sound(x, sr).to_pitch(time_step=HOP, pitch_floor=PITCH_RANGE[0], pitch_ceiling=PITCH_RANGE[1])
    except parselmouth.PraatError:  # too short for the pitch floor
        return np.zeros(n_frames, bool)
    centres = np.arange(n_frames) * HOP + HOP / 2
    f0 = np.interp(centres, pitch.xs(), pitch.selected_array["frequency"], left=0, right=0)
    return f0 >= 70


def speech_frames(x: np.ndarray, sr: int = 16000) -> np.ndarray:
    """1.0 for frames with speech, 0.0 otherwise; one frame per HOP seconds."""
    n = int(sr * HOP)
    if len(x) < n:
        return np.zeros(0, np.float32)
    frames = x[: len(x) // n * n].reshape(-1, n)
    db = 10 * np.log10(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-10)
    loud = db > np.percentile(db, FLOOR_PERCENTILE) + ABOVE_FLOOR_DB
    sp = _dilate(_voiced(x, sr, len(db)) & loud, WIDEN)
    close, open_ = int(CLOSE / HOP), int(OPEN / HOP)
    sp = _erode(_dilate(sp, close), close)
    sp = _dilate(_erode(sp, open_), open_)
    return sp.astype(np.float32)


def onsets(speech: np.ndarray) -> np.ndarray:
    """Times in seconds where speech begins."""
    if not len(speech):
        return np.zeros(0)
    d = np.diff(np.concatenate([[0.0], speech]))
    return np.where(d > 0)[0] * HOP
