"""Shared-model audio integration; recordings exist only in memory during processing."""
import io
import logging

import numpy as np

from app.models import AudioOffset, Message, VoiceMeasurement
from audio.measure import measure_operator
from audio.offsets import compute_spans
from audio.vad import speech_frames

logger = logging.getLogger(__name__)


def analyse(transcript: list[Message], samples: np.ndarray, sr: int):
    if sr <= 0 or samples.ndim != 1 or not np.isfinite(samples).all():
        raise ValueError("Expected finite mono samples and a positive sample rate")
    if not len(samples):
        return [], []
    speech = speech_frames(samples, sr)
    spans, _ = compute_spans([m.model_dump() for m in transcript], speech, len(samples) / sr)
    offsets = [AudioOffset(message_index=s["message_index"], seconds=round(s["start"], 1)) for s in spans]
    measurements = []
    if len(samples) / sr >= .1:
        for row in measure_operator(samples, sr, speech, spans):
            row["overlap"] = None  # Mono timing estimates cannot establish two-speaker overlap.
            measurements.append(VoiceMeasurement(**{k: row[k] for k in VoiceMeasurement.model_fields}))
    return offsets, measurements


def decode(data: bytes):
    import soundfile as sf
    from scipy.signal import resample_poly
    x, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    if sr != 16000:
        x = resample_poly(x, 16000, sr).astype(np.float32)
    return x, 16000


async def process_call(conversation: str) -> None:
    """Withhold unvalidated alignment/measurements; keep manual playback available.

    Re-enable production analysis only after the acceptance protocol in README.md.
    Storage failures never escape into the import job.
    """
    try:
        from app import store
        conv = store.get_conversation(conversation)
        if conv is None or conv.channel != "voice call":
            return
        # Timing and speaker assignment have not passed independent acceptance.
        # Keep candidate analysis offline; never publish it as evaluator evidence.
        # Clear older results even when the current recording URL is missing.
        store.save_audio_results(conversation, [], [])
    except Exception:
        logger.warning("Call audio processing failed; import can continue")
