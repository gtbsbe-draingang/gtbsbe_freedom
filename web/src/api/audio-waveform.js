import { waveformPeaks } from "../domain/waveform.js";

// Decode once at a low sample rate and retain only small envelopes, never full PCM recordings.
// Audio data follows the same backend/proxy URL as playback; no organizer URL is requested here.
const cache = new Map();
export async function getAudioWaveform(url, { signal } = {}) {
  if (cache.has(url)) return cache.get(url);
  const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AudioContext) throw new Error("Audio decoding unavailable");
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("Audio waveform unavailable");
  const buffer = await response.arrayBuffer();
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const context = new AudioContext({ sampleRate: 8000 });
  try {
    const decoded = await context.decodeAudioData(buffer);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
    const result = { duration: decoded.duration, peaks: waveformPeaks(channels) };
    cache.set(url, result);
    if (cache.size > 6) cache.delete(cache.keys().next().value);
    return result;
  } finally {
    await context.close();
  }
}
