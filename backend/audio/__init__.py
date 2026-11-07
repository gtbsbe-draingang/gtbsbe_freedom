"""Call analysis with shared models and local CPU processing."""
from audio.source import AudioSourceError, resolve_mp3_url


def analyse(*args, **kwargs):
    from audio.pipeline import analyse as run
    return run(*args, **kwargs)


async def process_call(conversation: str) -> None:
    from audio.pipeline import process_call as run
    await run(conversation)


def analyse_recording(path, transcript):
    """Offline diagnostic utility. Runtime processing uses the in-memory pipeline."""
    from audio.measure import measure_operator
    from audio.offsets import compute_spans
    from audio.vad import load_mono, speech_frames
    x = load_mono(path, 16000)
    speech = speech_frames(x, 16000)
    spans, info = compute_spans(transcript, speech, len(x) / 16000)
    offsets = [{"message_index": s["message_index"], "seconds": round(s["start"], 1)} for s in spans]
    measurements = measure_operator(x, 16000, speech, spans)
    for row in measurements:
        row["overlap"] = None
    return offsets, measurements, info


__all__ = ["analyse", "analyse_recording", "process_call", "resolve_mp3_url", "AudioSourceError"]
