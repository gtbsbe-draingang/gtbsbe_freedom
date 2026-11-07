"""Shared-model audio integration; recordings exist only in memory during processing."""
import asyncio
import io
import logging
import os

import numpy as np

from app.models import AudioOffset, Message, VoiceMeasurement
from audio import asr_align
from audio.measure import measure_operator
from audio.offsets import compute_spans
from audio.vad import speech_frames

logger = logging.getLogger(__name__)
MAX_BYTES = 128 * 1024 * 1024
LANGUAGES = {"RU": "ru", "KZ": "kk", "EN": "en"}  # conversation.language to recogniser code


def alignment_enabled() -> bool:
    """Whether offsets and voice measurements are published (#28).

    CQA_AUDIO_ALIGNMENT=on or =off decides when set. Otherwise they are on exactly when
    faster-whisper is installed (`uv sync --extra asr`): the listening check passed for the
    length guess plus recogniser snapping (29 of 30 samples within about 2 s), not for the
    length guess alone."""
    value = os.environ.get("CQA_AUDIO_ALIGNMENT", "").strip().lower()
    if value in ("on", "off"):
        return value == "on"
    return asr_align.available()


def analyse(transcript: list[Message], samples: np.ndarray, sr: int, language: str = "RU", refine: bool = True):
    if sr <= 0 or samples.ndim != 1 or not np.isfinite(samples).all():
        raise ValueError("Expected finite mono samples and a positive sample rate")
    if not len(samples):
        return [], []
    speech = speech_frames(samples, sr)
    spans, _ = compute_spans([m.model_dump() for m in transcript], speech, len(samples) / sr)
    if refine and sr == 16000:
        spans, _ = asr_align.refine(spans, samples, LANGUAGES.get(language, "ru"))
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

    When alignment is enabled (see `alignment_enabled`) the recording is fetched into memory,
    aligned (length guess, then recogniser snapping) and the results are stored; otherwise
    stored results are cleared. Failures never escape into the import job.
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
        offsets, measurements = await asyncio.to_thread(analyse, conv.transcript, samples, sr, conv.language)
        store.save_audio_results(conversation, offsets, measurements)
    except Exception:
        logger.warning("Call audio processing failed; import can continue")
