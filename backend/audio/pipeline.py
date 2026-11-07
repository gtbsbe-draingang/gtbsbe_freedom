"""Shared-model audio integration; recordings exist only in memory during processing."""
import asyncio
import io
import logging
import os

import numpy as np

from app.models import AudioOffset, Message, VoiceMeasurement
from audio.measure import measure_operator
from audio.offsets import compute_spans
from audio.vad import speech_frames

logger = logging.getLogger(__name__)
MAX_BYTES = 128 * 1024 * 1024


def alignment_enabled() -> bool:
    """Offsets and measurements are published only when CQA_AUDIO_ALIGNMENT=on (#28). Turn it on
    after the listening check in tests/manual/alignment_check.py has passed."""
    return os.environ.get("CQA_AUDIO_ALIGNMENT", "").strip().lower() == "on"


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
    x, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    if sr != 16000:  # the organisers' calls are 16 kHz already
        from scipy.signal import resample_poly
        x = resample_poly(x, 16000, sr).astype(np.float32)
    return x, 16000


async def _download(player: str) -> bytes:
    import httpx
    from audio.resolve import open_audio
    from audio.source import TIMEOUT

    async with asyncio.timeout(60):
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as client:
            response = await open_audio(player, client)
            data = bytearray()
            try:
                async for chunk in response.aiter_bytes():
                    if len(data) + len(chunk) > MAX_BYTES:
                        raise ValueError("Recording exceeds processing limit")
                    data.extend(chunk)
            finally:
                await response.aclose()
    return bytes(data)


async def process_call(conversation: str) -> None:
    """Store a call's line offsets and voice measurements, or clear them while alignment is off.

    By default nothing is published: the timing has not passed the independent listening check
    (#28), and stored results from older builds are cleared. With CQA_AUDIO_ALIGNMENT=on the
    recording is fetched into memory, aligned from its speech activity (`audio.offsets`) and the
    results are stored. Failures never escape into the
    import job.
    """
    try:
        from app import store
        conv = store.get_conversation(conversation)
        if conv is None or conv.channel != "voice call":
            return
        if not alignment_enabled():
            store.save_audio_results(conversation, [], [])
            return
        player = store.get_audio_url(conversation)
        if not player:
            return
        samples, sr = await asyncio.to_thread(decode, await _download(player))
        offsets, measurements = await asyncio.to_thread(analyse, conv.transcript, samples, sr)
        store.save_audio_results(conversation, offsets, measurements)
    except Exception:
        logger.warning("Call audio processing failed; import can continue")
