"""Stream D: call recordings, line to audio offsets and voice measurements.

B's import calls `process_call` in the background for every voice call with an `audio_url`;
failures are logged and never block the import.
"""

from __future__ import annotations

import asyncio
import logging

from audio.source import AudioSourceError, resolve_mp3_url

__all__ = ["analyse_recording", "process_call", "resolve_mp3_url", "AudioSourceError"]
logger = logging.getLogger(__name__)
SR = 16000


def analyse_recording(path, transcript: list[dict]) -> tuple[list[dict], list[dict], dict]:
    """(audio_offsets, voice_measurements, diagnostics) for one recording. CPU only, a few seconds."""
    from audio.measure import measure_operator
    from audio.offsets import compute_spans
    from audio.vad import load_mono, speech_frames

    x = load_mono(path, SR)
    speech = speech_frames(x, SR)
    spans, info = compute_spans(transcript, speech, len(x) / SR)
    offsets = [{"message_index": s["message_index"], "seconds": round(s["start"], 1)} for s in spans]
    return offsets, measure_operator(x, SR, speech, spans), info


async def process_call(conversation: str) -> None:
    """Download the recording, compute offsets and measurements, store them through app.store."""
    from app import store  # owned by stream B
    from app.models import AudioOffset, VoiceMeasurement
    from audio.recording import ensure_recording

    conv = store.get_conversation(conversation)
    if conv is None or conv.channel != "voice call":
        return
    try:
        path = await ensure_recording(conversation)
        if path is None:
            return
        transcript = [m.model_dump() for m in conv.transcript]
        offsets, measurements, info = await asyncio.to_thread(analyse_recording, path, transcript)
    except (AudioSourceError, OSError, ValueError, RuntimeError) as e:
        logger.warning("audio processing for %s failed: %s", conversation, e)
        return
    fields = VoiceMeasurement.model_fields
    store.save_audio_results(
        conversation,
        [AudioOffset(**o) for o in offsets],
        [VoiceMeasurement(**{k: v for k, v in m.items() if k in fields}) for m in measurements],
    )
    logger.info("audio for %s: %d offsets, %d measurements, %s", conversation, len(offsets), len(measurements), info)
