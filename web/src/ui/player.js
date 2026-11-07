// The call player (extra 7, R6): the recording on top of a call's transcript, linked to its lines.
//
//   renderPlayer(conversation, api, transcript) -> { el, seek(index), destroy } | null
//     null for a chat. `transcript` is what the pane lends the player:
//       markPlaying(index | null, {follow})  marks the line being played (.is-playing); `follow`
//                                            while it plays, so the pane can keep it in view
//       openImport()                         opens the loader on this call's group
//     With a recording (api.audioUrl): an <audio controls preload="metadata">. `timeupdate` and
//     `seeked` mark the line whose start ≤ currentTime < the next start; seek(index) moves the
//     recording to the start of that line (a line's time and an evidence link call it) and is false
//     when the line has no start. Without one: `audio_unavailable_reason` "needs_import" says
//     «Загрузите группу, чтобы включить запись» with a button that opens the loader.
//     destroy() pauses the recording: a detached <audio> keeps playing otherwise.
//
//   startTimes(conversation) -> (number | null)[]   each line's start in the recording, in seconds:
//     `audio_offsets` (the calibrated starts), or the transcript's own times when there are none
//   playingIndex(starts, seconds) -> number | null   the line being played at that time
import { offsets } from "../domain/time.js";
import { t } from "../i18n/ru.js";
import { h } from "./dom.js";

const isTime = (value) => typeof value === "number" && Number.isFinite(value);

export function startTimes(conversation) {
  const transcript = Array.isArray(conversation?.transcript) ? conversation.transcript : [];
  const given = Array.isArray(conversation?.audio_offsets) ? conversation.audio_offsets : [];
  if (given.length === 0) return offsets(transcript).map((value) => (isTime(value) ? value : null));
  const starts = transcript.map(() => null);
  for (const entry of given) {
    const index = entry?.message_index;
    if (Number.isInteger(index) && index >= 0 && index < starts.length && isTime(entry.seconds)) starts[index] = entry.seconds;
  }
  return starts;
}

export function playingIndex(starts, seconds) {
  if (!isTime(seconds)) return null;
  let best = null;
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    if (!isTime(start) || start > seconds) continue;
    if (best === null || start >= starts[best]) best = i; // equal starts: the later line wins
  }
  return best;
}

export function renderPlayer(conversation, api, transcript) {
  if (conversation?.channel !== "voice call") return null;
  const src = api.audioUrl(conversation);

  if (!src) {
    const needsImport = conversation.audio_unavailable_reason === "needs_import";
    const el = h(
      "div",
      { class: ["cqa-player", "cqa-player--none"], data: { test: "player" } },
      h("p", { class: "cqa-player-note", text: t(needsImport ? "player.needsImport" : "player.none") }),
      needsImport
        ? h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("player.import"), data: { test: "player-import" }, on: { click: () => transcript.openImport?.() } })
        : null,
    );
    return { el, seek: () => false, destroy() {} };
  }

  const starts = startTimes(conversation);
  const status = h("p", { class: "cqa-player-note", attrs: { role: "status" } });
  status.hidden = true;
  const audio = h("audio", { class: "cqa-player-audio", attrs: { controls: true, preload: "metadata", src, "aria-label": t("player.label") } });
  const el = h("div", { class: "cqa-player", data: { test: "player" } }, audio, status);
  let current = null;
  let destroyed = false;

  function mark() {
    const index = playingIndex(starts, audio.currentTime);
    if (index === current) return;
    current = index;
    transcript.markPlaying(index, { follow: !audio.paused });
  }

  audio.addEventListener("timeupdate", mark);
  audio.addEventListener("seeked", mark);
  audio.addEventListener("loadedmetadata", () => {
    status.hidden = true;
  });
  audio.addEventListener("error", () => {
    if (destroyed) return;
    status.replaceChildren(
      t("player.failed"),
      " ",
      h("button", { class: ["cqa-link", "cqa-player-retry"], attrs: { type: "button" }, text: t("player.retry"), data: { test: "player-retry" }, on: { click: () => audio.load() } }),
    );
    status.hidden = false;
  });

  return {
    el,
    seek(index) {
      const start = starts[index];
      if (destroyed || !isTime(start)) return false;
      audio.currentTime = start;
      mark();
      return true;
    },
    destroy() {
      destroyed = true;
      audio.pause();
    },
  };
}
