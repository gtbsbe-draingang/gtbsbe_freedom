// A compact RMS envelope from real decoded samples. Every channel contributes, including
// opposite-phase stereo channels; averaging the signal first would incorrectly cancel them.
export function waveformPeaks(channels, bins = 220) {
  const length = channels[0]?.length ?? 0;
  if (!length || !Number.isInteger(bins) || bins < 1) return [];
  const peaks = Array.from({ length: bins }, (_, i) => {
    const from = Math.floor(i * length / bins);
    const to = Math.min(length, Math.max(from + 1, Math.floor((i + 1) * length / bins)));
    let sum = 0;
    for (const channel of channels) {
      for (let j = from; j < to; j++) sum += (channel[j] ?? 0) ** 2;
    }
    return Math.sqrt(sum / ((to - from) * channels.length));
  });
  const maximum = Math.max(...peaks);
  return maximum ? peaks.map((value) => Math.sqrt(value / maximum)) : peaks;
}

// Intervals are attributed by transcript turns, not isolated audio channels. System/bot turns
// delimit intervals too; lines without a recording offset must not claim recording time.
export function speakerWindows(transcript, starts, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const turns = starts.flatMap((time, index) => Number.isFinite(time) && time >= 0 && time < duration ? [{ time, index }] : [])
    .sort((a, b) => a.time - b.time || a.index - b.index);
  return turns.flatMap(({ time, index }, i) => {
    const role = transcript[index]?.speaker?.trim().toLowerCase();
    const end = turns[i + 1]?.time ?? duration;
    return (role === "client" || role === "operator") && end > time ? [{ role, from: time, to: end }] : [];
  });
}

export function splitWaveform(peaks, windows, duration, role) {
  return peaks.map((peak, i) => {
    const from = i / peaks.length * duration;
    const to = (i + 1) / peaks.length * duration;
    return windows.some((window) => window.role === role && window.from < to && window.to > from) ? peak : 0;
  });
}
