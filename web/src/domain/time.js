// Timestamps of a transcript line. Chats use "MM:SS" or "H:MM:SS"; calls use ISO 8601 with an
// offset and up to 7 fractional digits. Anything else is "unknown" and never throws.

const CLOCK_MS = /^(\d{1,3}):([0-5]\d)$/;
const CLOCK_HMS = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/;
const ISO =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

const UNKNOWN = Object.freeze({ kind: "unknown" });

/**
 * @param {unknown} ts
 * @returns {{kind: "clock", seconds: number} | {kind: "iso", epochMs: number} | {kind: "unknown"}}
 */
export function parseTimestamp(ts) {
  if (typeof ts !== "string") return { ...UNKNOWN };
  const text = ts.trim();

  let m = CLOCK_MS.exec(text);
  if (m) return { kind: "clock", seconds: Number(m[1]) * 60 + Number(m[2]) };
  m = CLOCK_HMS.exec(text);
  if (m) return { kind: "clock", seconds: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) };

  m = ISO.exec(text);
  if (!m) return { ...UNKNOWN };
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (year < 1000 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return { ...UNKNOWN };
  }
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return { ...UNKNOWN };

  // No offset means UTC: only differences between lines matter, and they stay correct.
  let offsetMinutes = 0;
  const zone = m[8];
  if (zone && zone.toUpperCase() !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    const zh = Number(digits.slice(0, 2));
    const zm = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    if (zh > 23 || zm > 59) return { ...UNKNOWN };
    offsetMinutes = (zone[0] === "-" ? -1 : 1) * (zh * 60 + zm);
  }
  // Fractions beyond milliseconds are kept (Date.parse would drop them).
  const fractionMs = m[7] ? Number("0." + m[7]) * 1000 : 0;
  const epochMs =
    Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60000 + fractionMs;
  return { kind: "iso", epochMs };
}

/**
 * Seconds from the first parsable line, one entry per line; null where a line cannot be placed
 * (unparsable, or of another kind than the first parsable line).
 * @param {{timestamp?: unknown}[]} transcript
 * @returns {(number | null)[]}
 */
export function offsets(transcript) {
  const lines = Array.isArray(transcript) ? transcript : [];
  const parsed = lines.map((m) => parseTimestamp(m == null ? undefined : m.timestamp));
  const base = parsed.find((p) => p.kind !== "unknown");
  if (!base) return parsed.map(() => null);
  return parsed.map((p) => {
    if (p.kind !== base.kind) return null;
    return p.kind === "clock" ? p.seconds - base.seconds : (p.epochMs - base.epochMs) / 1000;
  });
}

/**
 * "m:ss", or "h:mm:ss" from one hour. Whole seconds, rounded down; "" for null or NaN.
 * @param {number | null | undefined} sec
 */
export function formatOffset(sec) {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return "";
  const negative = sec < 0;
  // The epsilon absorbs float noise from ISO differences (64.9999999 shows as 1:05).
  const whole = Math.floor(Math.abs(sec) + 1e-6);
  const h = Math.floor(whole / 3600);
  const mm = Math.floor((whole % 3600) / 60);
  const ss = whole % 60;
  const pad = (n) => String(n).padStart(2, "0");
  const body = h > 0 ? `${h}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
  return negative ? `-${body}` : body;
}

// System events that start, pause and resume a call's recording (RU, KZ, EN), as in
// backend/audio/offsets.py.
const REC_START = ["запущены", "басталды", "recording started", "transcription started"];
const REC_PAUSE = ["приостановлены", "тоқтатылды", "paused"];
const REC_RESUME = ["возобновлены", "жалғастырылды", "қайта басталды", "resumed"];
const SPOKEN = ["client", "operator", "bot"];
const CHARS_PER_SECOND = 13; // fitted on the five DEV calls (#28)
const says = (message, words) => {
  const text = typeof message?.text === "string" ? message.text.toLowerCase() : "";
  return message?.speaker === "system" && words.some((w) => text.includes(w));
};

/**
 * Where each line starts in the call recording, in seconds, from the transcript alone. The
 * recording begins at the "recording started" event and skips each paused-to-resumed stretch.
 * A call timestamp marks the END of a line, so a spoken line starts its estimated length earlier
 * (text length at CHARS_PER_SECOND, 0.6 to 20 s), but not before the previous spoken line ended
 * (minus 0.3 s); a system event has no length. Null for a duplicate line, a line said before the
 * recording, while it was paused or after an unresumed pause, and a line `offsets` cannot place.
 * Still an estimate: each call keeps a few seconds of constant shift that only the audio
 * alignment finds (#28). Mirrors compute_spans in backend/audio/offsets.py, without the audio.
 * @param {{timestamp?: unknown, speaker?: string, text?: string, duplicate?: boolean}[]} transcript
 * @returns {(number | null)[]}
 */
export function recordingStarts(transcript) {
  const lines = Array.isArray(transcript) ? transcript : [];
  const at = offsets(lines);
  const startIndex = lines.findIndex((m, i) => at[i] !== null && says(m, REC_START));
  const start = startIndex === -1 ? 0 : at[startIndex];
  const pauses = [];
  let opened = null;
  lines.forEach((m, i) => {
    if (at[i] === null) return;
    if (opened === null && says(m, REC_PAUSE)) opened = at[i];
    else if (opened !== null && says(m, REC_RESUME)) {
      pauses.push([opened, at[i]]);
      opened = null;
    }
  });
  const ends = at.map((t) => {
    if (t === null || t < start || (opened !== null && t >= opened)) return null;
    let y = t - start;
    for (const [a, b] of pauses) {
      if (t >= b) y -= b - a;
      else if (t > a) return null; // said while the recording was paused
    }
    return Math.max(0, y);
  });
  let previousEnd = 0;
  return lines.map((m, i) => {
    const end = ends[i];
    if (end === null || m?.duplicate === true) return null;
    if (!SPOKEN.includes(m?.speaker)) return end;
    const length = Math.min(Math.max((typeof m.text === "string" ? m.text.length : 0) / CHARS_PER_SECOND, 0.6), 20);
    const lineStart = Math.max(0, end - length, previousEnd - 0.3);
    previousEnd = Math.max(previousEnd, end);
    return lineStart;
  });
}

