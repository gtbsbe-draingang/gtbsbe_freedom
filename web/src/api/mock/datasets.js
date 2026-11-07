// Records -> stored conversations for the mock: the organisers' record through normalizeRecord,
// plus the fields a Conversation needs that a record may lack (created_at, info, audio offsets).
import { normalizeRecord } from "../../domain/normalize.js";
import { recordingStarts } from "../../domain/time.js";

// Each line's place in the recording, for calls only: the mock has no calibration, so the
// timestamps on the recording's clock stand in for it.
function callOffsets(transcript) {
  return recordingStarts(transcript).flatMap((seconds, index) =>
    seconds === null ? [] : [{ message_index: index, seconds: Math.max(0, Math.round(seconds * 10) / 10) }],
  );
}

/**
 * @param {object} record an organisers' record
 * @param {string} groupId
 * @param {{audioBase?: string | null, createdAt: string}} options
 *   `audioBase` ("data/audio/") applies to calls of the DEV group only.
 */
export function toConversation(record, groupId, { audioBase, createdAt }) {
  const base = audioBase ? (audioBase.endsWith("/") ? audioBase : `${audioBase}/`) : null;
  const conversation = normalizeRecord(record, groupId, {
    audioPathFor: (conversationId) => (groupId === "DEV" && base ? `${base}${conversationId}.mp3` : null),
  });
  const isCall = conversation.channel === "voice call";
  return {
    ...conversation,
    created_at: createdAt,
    info: conversation.info ?? null,
    audio_offsets: Array.isArray(conversation.audio_offsets)
      ? conversation.audio_offsets
      : isCall
        ? callOffsets(conversation.transcript)
        : [],
    voice_measurements: Array.isArray(conversation.voice_measurements) ? conversation.voice_measurements : [],
  };
}

const pad = (n) => String(n).padStart(2, "0");

/** "20261107143015": a UTC time to the second, for the group name `upload-<timestamp>`. */
export function compactTimestamp(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}
