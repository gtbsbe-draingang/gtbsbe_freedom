// Organisers' records -> our Conversation (contract section 7): id, audio fields, duplicate marks
// and computed facts. Pure functions; nothing here touches the network or the DOM.
import { offsets } from "./time.js";

// ---- facts: patterns are the DEV system-event texts -------------------------------------------

const HANDOVER =
  /^(Эскалация на оператора|Чат операторға жіберілді|Chat transferred to an agent|Агент присоединился к разговору)/;
const IDENTITY = /^(Личность клиента подтверждена|Клиенттің жеке басы расталды|Customer identity verified)/;
const ENDINGS = [
  ["operator_closed", /^(Оператор закрыл чат|Оператор чатты жапты|Agent closed the chat)/],
  ["client_left", /^(Клиент покинул чат|Customer left the chat)/],
  ["connection_lost", /^(Соединение с клиентом прервано|Клиентпен байланыс үзілді|Connection to customer lost)/],
  ["client_ended_call", /^Клиент завершил разговор/],
];

const textOf = (m) => (m && typeof m.text === "string" ? m.text : "");
const speakerOf = (m) => (m ? m.speaker : undefined);
const diff = (off, from, to) => {
  const a = off[from];
  const b = off[to];
  return a == null || b == null || b < a ? null : b - a;
};

/**
 * Facts the scorecard shows next to the dialogue. Missing pieces are null; the ending is
 * "normal" when no system line says otherwise.
 * @param {{timestamp?: string, speaker?: string, text?: string}[]} transcript
 */
export function computeFacts(transcript) {
  const lines = Array.isArray(transcript) ? transcript : [];
  const off = offsets(lines);

  let handover = -1;
  let identity = -1;
  let ending = "normal";
  lines.forEach((m, i) => {
    if (speakerOf(m) !== "system") return;
    const text = textOf(m);
    if (handover < 0 && HANDOVER.test(text)) handover = i;
    if (identity < 0 && IDENTITY.test(text)) identity = i;
    for (const [kind, pattern] of ENDINGS) if (pattern.test(text)) ending = kind; // last one wins
  });

  // The first operator line after the handover, or the first one at all without a handover.
  let joined = -1;
  for (let i = handover + 1; i < lines.length; i += 1) {
    if (speakerOf(lines[i]) === "operator") {
      joined = i;
      break;
    }
  }

  // Waits count only from the moment the operator is in the chat: the bot phase and the queue
  // wait (that is first_reaction_seconds) are left out.
  let longestWait = null;
  if (joined >= 0) {
    let pending = -1;
    for (let i = joined; i < lines.length; i += 1) {
      const speaker = speakerOf(lines[i]);
      if (speaker === "client" && pending < 0) {
        pending = i;
      } else if (speaker === "operator" && pending >= 0) {
        const wait = diff(off, pending, i);
        if (wait !== null && (longestWait === null || wait > longestWait)) longestWait = wait;
        pending = -1;
      }
    }
  }

  return {
    operator_joined_index: joined >= 0 ? joined : null,
    first_reaction_seconds: handover >= 0 && joined >= 0 ? diff(off, handover, joined) : null,
    longest_wait_seconds: longestWait,
    identity_verified_index: identity >= 0 ? identity : null,
    ending,
  };
}

// ---- normalisation ----------------------------------------------------------------------------

const asText = (value) => (typeof value === "string" ? value : value == null ? "" : String(value));

function cleanLine(raw) {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    return { ...raw, timestamp: asText(raw.timestamp), speaker: asText(raw.speaker), text: asText(raw.text) };
  }
  return { timestamp: "", speaker: "", text: asText(raw) };
}

/** Marks a line equal in timestamp, speaker and text to the line before it. */
function markDuplicates(lines) {
  return lines.map((m, i) => {
    const prev = lines[i - 1];
    const same = i > 0 && m.timestamp === prev.timestamp && m.speaker === prev.speaker && m.text === prev.text;
    return same || m.duplicate === true ? { ...m, duplicate: true } : m;
  });
}

/**
 * The organisers' record -> a Conversation. The record is not modified. `audio_url` is dropped
 * (the signed link never leaves the backend); audio is the relative path from `audioPathFor`.
 *
 * `audioPathFor(conversationId, id)` is asked only for voice calls. It gets the organisers'
 * `conversation_id` first and the full `id` ("GROUP:conversation_id") second, and returns a
 * relative audio path or null.
 *
 * @param {object} record
 * @param {string} groupId
 * @param {{audioPathFor?: (conversationId: string, id: string) => string | null}} [options]
 */
export function normalizeRecord(record, groupId, options = {}) {
  const { audio_url: _signedLink, transcript: rawTranscript, ...rest } = record;
  const id = `${groupId}:${record.conversation_id}`;
  const transcript = markDuplicates((Array.isArray(rawTranscript) ? rawTranscript : []).map(cleanLine));

  const isCall = record.channel === "voice call";
  const path = isCall && options.audioPathFor ? options.audioPathFor(record.conversation_id, id) : null;
  const audio = path || null;

  return {
    ...rest,
    id,
    group_id: groupId,
    status: "new",
    transcript,
    facts: computeFacts(transcript),
    audio,
    audio_unavailable_reason: audio ? null : isCall ? "needs_import" : "none",
  };
}

// ---- upload parsing ---------------------------------------------------------------------------

/** Thrown by parseUpload. `code` is "not_json", "no_records" or "bad_record:<index>". */
export class UploadError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = "UploadError";
    this.code = code;
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const RECORD_KEYS = ["conversation_id", "channel", "language", "transcript"];

function locate(data) {
  if (Array.isArray(data)) return { list: data, groupHint: null };
  if (!isObject(data)) return { list: [], groupHint: null };
  const hint = (holder) => (nonEmptyString(holder.dataset_group_id) ? holder.dataset_group_id : null);
  if (Array.isArray(data.records)) return { list: data.records, groupHint: hint(data) };
  if (isObject(data.data) && Array.isArray(data.data.records)) {
    return { list: data.data.records, groupHint: hint(data.data) ?? hint(data) };
  }
  if (RECORD_KEYS.some((key) => key in data)) return { list: [data], groupHint: null };
  return { list: [], groupHint: null };
}

/**
 * Reads an uploaded file's text: one record, an array of records, `{records}`, or a whole
 * organisers' response (`{data: {dataset_group_id, records}}`). A record needs a conversation_id,
 * a channel, a language and a transcript array (which may be empty).
 * @param {string} text
 * @returns {{records: object[], groupHint: string | null}}
 * @throws {UploadError}
 */
export function parseUpload(text) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ""));
  } catch {
    throw new UploadError("not_json");
  }
  const { list, groupHint } = locate(data);
  if (list.length === 0) throw new UploadError("no_records");
  list.forEach((record, index) => {
    const ok =
      isObject(record) &&
      nonEmptyString(record.conversation_id) &&
      nonEmptyString(record.channel) &&
      nonEmptyString(record.language) &&
      Array.isArray(record.transcript);
    if (!ok) throw new UploadError(`bad_record:${index}`);
  });
  return { records: list, groupHint };
}
