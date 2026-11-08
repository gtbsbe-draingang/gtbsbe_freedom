import { setLocalizedText } from "../i18n/dom.js";
// The transcript pane: the dialogue as bubbles (client left, operator and bot right, system lines
// as centred notes), built once per conversation.
//
//   renderTranscript(store, api, {id}?) -> { el, ready, highlight, focusMessage, destroy }
//     `ready` settles once the dialogue or its error is on screen (the shell's board -> dialogue
//     motion waits for it briefly).
//
// The scorecard drives it:
//   highlight(criterionId | null, evidence[], checkedRange, label?)
//       marks messages by toggling classes only, so the scroll position survives:
//       evidence `supports` -> .is-evidence + a label (`label`, else the criterion id),
//       evidence `expected_here` -> .is-expected (dashed) + «здесь ожидалось»,
//       checkedRange {from, to} (inclusive) -> .is-checked shading.
//       A null criterion id clears everything.
//   focusMessage(index) -> boolean
//       scrolls the message to the middle of the pane's own scroller (the page does not move)
//       and flashes it with .is-flash for 1.2 s. False when there is no such message.
//
// Calls made before the dialogue has loaded are kept and applied once it is on screen. The handle
// is also published as store state `transcript` (null after destroy), so the scorecard, which is a
// sibling pane, reaches it without a reference to this module's internals; with test hooks it is
// on window.__cqaTest.transcript as {focusMessage, highlight}.
//
// An import (store `importRefresh`, bumped by the loader) may have updated this dialogue: it is
// fetched again and redrawn only when what the pane shows changed, keeping the scroll position and
// the marks, so the evidence the scorecard reloads points at the lines on screen.
//
// A call gets the player (player.js) on top. With a recording, each line's time is its start in the
// recording and a button that seeks there; focusMessage (an evidence link) seeks too; the line being
// played carries .is-playing and is kept in view while it plays.
import { canonicalJson } from "../domain/fingerprint.js";
import { formatOffset, offsets } from "../domain/time.js";
import { t } from "../i18n/ru.js";
import { watch } from "../state/store.js";
import { clear, h } from "./dom.js";
import { openImport } from "./loader.js";
import { renderPlayer, startTimes } from "./player.js";
import { errorText, toastError } from "./toast.js";

export const FLASH_MS = 1200;

const KNOWN = new Set(["client", "operator", "bot", "system"]);

// client | operator | bot | system, anything else is "other" (labelled «Другое»).
export function speakerKind(speaker) {
  const name = typeof speaker === "string" ? speaker.trim().toLowerCase() : "";
  return KNOWN.has(name) ? name : "other";
}

const validIndex = (value, count) => Number.isInteger(value) && value >= 0 && value < count;

/**
 * Which of `count` messages are marked, as one {supports, expected, checked} per message.
 * Indexes outside the dialogue and entries of an unknown role are ignored; an inverted range is
 * read the other way round.
 * @param {number} count
 * @param {{message_index?: number, role?: string}[] | null | undefined} evidence
 * @param {{from?: number, to?: number} | null | undefined} range
 */
export function highlightPlan(count, evidence, range) {
  const marks = Array.from({ length: count }, () => ({ supports: false, expected: false, checked: false }));
  for (const item of Array.isArray(evidence) ? evidence : []) {
    if (!item || !validIndex(item.message_index, count)) continue;
    if (item.role === "supports") marks[item.message_index].supports = true;
    else if (item.role === "expected_here") marks[item.message_index].expected = true;
  }
  if (range && Number.isInteger(range.from) && Number.isInteger(range.to)) {
    const from = Math.max(0, Math.min(range.from, range.to));
    const to = Math.min(count - 1, Math.max(range.from, range.to));
    for (let i = from; i <= to; i += 1) marks[i].checked = true;
  }
  return marks;
}

/** What the pane draws of a conversation, as one string: equal strings draw the same pane. */
export function shownKey(conversation) {
  const transcript = Array.isArray(conversation?.transcript) ? conversation.transcript : [];
  return canonicalJson({
    conversation_id: conversation?.conversation_id ?? null,
    channel: conversation?.channel ?? null,
    language: conversation?.language ?? null,
    transcript,
    audio: conversation?.audio ?? null, // an import can make the recording playable
    audio_unavailable_reason: conversation?.audio_unavailable_reason ?? null,
    audio_offsets: Array.isArray(conversation?.audio_offsets) ? conversation.audio_offsets : [],
  });
}

// The id of the open conversation: the pane's argument, else the workspace route, else the
// conversation the host named.
function openId(store, args) {
  if (typeof args?.id === "string" && args.id !== "") return args.id;
  const { route, conversationId } = store.get();
  return route?.name === "workspace" && route.params?.id ? route.params.id : (conversationId ?? null);
}

function stateBox(test, title, note, extra) {
  return h("div", { class: "cqa-empty", attrs: { role: "status" }, data: { test } }, h("b", { class: "cqa-empty-title", text: title }), note ? h("p", { class: "cqa-empty-note", text: note }) : null, extra);
}

// `seek`: a call with a recording, where the time is the line's start in the recording and seeks.
function buildMessage(message, index, offset, seek) {
  const kind = speakerKind(message?.speaker);
  const raw = typeof message?.timestamp === "string" ? message.timestamp.trim() : "";
  const clock = formatOffset(offset) || raw;
  const timeAttrs = raw === "" ? {} : { title: raw };
  const time =
    clock === ""
      ? null
      : seek
        ? h("button", { class: ["cqa-msg-time", "cqa-msg-seek"], attrs: { type: "button", title: t("player.seek", { time: clock }) }, text: clock, data: { test: "msg-time" }, on: { click: () => seek(index) } })
        : h("span", { class: "cqa-msg-time", text: clock, attrs: timeAttrs, data: { test: "msg-time" } });

  const flag = h("b", { class: "cqa-msg-flag", data: { test: "msg-flag" } });
  const who = h(
    "div",
    { class: "cqa-msg-who" },
    flag,
    kind === "system" ? null : h("span", { class: "cqa-msg-speaker", text: t(`transcript.speaker.${kind}`), attrs: kind === "other" && message?.speaker ? { title: String(message.speaker) } : {}, data: { test: "msg-speaker" } }),
    time,
    message?.duplicate ? h("span", { class: "cqa-msg-dup", text: t("transcript.duplicate"), attrs: { title: t("transcript.duplicateTitle") } }) : null,
  );
  const text = h("p", { class: "cqa-msg-text", verbatim: true, text: typeof message?.text === "string" ? message.text : "" });
  const el = h("li", { class: ["cqa-msg", `cqa-msg--${kind}`, message?.duplicate && "is-duplicate"], data: { test: "msg", index, speaker: kind } }, who, text);
  return { el, flag };
}

/**
 * @param {{get: Function, set: Function}} store
 * @param {object} api
 * @param {{id?: string}} [args]
 * @returns {{el: HTMLElement, highlight: Function, focusMessage: Function, destroy: () => void}}
 */
export function renderTranscript(store, api, args = {}) {
  const id = openId(store, args);
  const scroller = h("div", { class: "cqa-tr-scroll", attrs: { tabindex: "0", role: "region", "aria-label": t("transcript.label") }, data: { test: "transcript-list" } });
  const head = h("div", { class: "cqa-tr-head" });
  const playerHost = h("div", { class: "cqa-tr-player" });
  const el = h("div", { class: "cqa-tr", data: { test: "transcript" } }, head, playerHost, scroller);

  let destroyed = false;
  let rows = []; // [{el, flag}] per message, empty until loaded
  let loaded = false; // the dialogue is on screen (it may have no lines)
  let marked = []; // indexes with a highlight class, so clearing touches only those
  let pending = { highlight: null, focus: null };
  let lastHighlight = null; // the arguments of the marks on screen, applied again after a redraw
  let shown = null; // shownKey() of the dialogue on screen
  let translationRun = 0;
  let translationOn = false;
  let translationCache = null;
  let player = null; // the call player, for a call
  let playingAt = null; // the index of the line marked .is-playing
  const flashTimers = new Map(); // index -> timer id

  // ---- highlight and focus --------------------------------------------------------------------

  function clearMarks() {
    for (const i of marked) {
      const row = rows[i];
      row.el.classList.remove("is-evidence", "is-expected", "is-checked");
      row.el.removeAttribute("data-criterion");
      setLocalizedText(row.flag, "");
    }
    marked = [];
  }

  function applyHighlight(criterionId, evidence, range, label) {
    clearMarks();
    lastHighlight = criterionId === null || criterionId === undefined ? null : [criterionId, evidence, range, label];
    if (lastHighlight === null) return;
    const name = typeof label === "string" && label.trim() !== "" ? label : String(criterionId);
    const plan = highlightPlan(rows.length, evidence, range);
    plan.forEach((mark, i) => {
      if (!mark.supports && !mark.expected && !mark.checked) return;
      const { el: row, flag } = rows[i];
      row.classList.toggle("is-evidence", mark.supports);
      row.classList.toggle("is-expected", mark.expected);
      row.classList.toggle("is-checked", mark.checked);
      row.setAttribute("data-criterion", String(criterionId));
      setLocalizedText(flag, [mark.supports ? name : "", mark.expected ? t("transcript.expectedHere") : ""].filter(Boolean).join(" · "));
      marked.push(i);
    });
  }

  function highlight(criterionId, evidence, checkedRange, label) {
    if (destroyed) return;
    if (!loaded) pending.highlight = [criterionId, evidence, checkedRange, label];
    else applyHighlight(criterionId, evidence, checkedRange, label);
  }

  function flash(index) {
    const { el: row } = rows[index];
    clearTimeout(flashTimers.get(index));
    row.classList.remove("is-flash");
    void row.offsetWidth; // a second call restarts the flash
    row.classList.add("is-flash");
    flashTimers.set(
      index,
      setTimeout(() => {
        row.classList.remove("is-flash");
        flashTimers.delete(index);
      }, FLASH_MS),
    );
  }

  // Scroll the pane's own scroller to put the message in the middle. scrollIntoView would also
  // move the page, and with it the scorecard next to the transcript.
  function centre(index) {
    const row = rows[index].el;
    const top = row.offsetTop - (scroller.clientHeight - row.offsetHeight) / 2;
    scroller.scrollTo({ top: Math.max(0, top), behavior: "auto" });
  }

  function focusMessage(index) {
    if (destroyed) return false;
    if (!loaded) {
      pending.focus = index;
      return Number.isInteger(index) && index >= 0;
    }
    if (!validIndex(index, rows.length)) return false;
    centre(index);
    flash(index);
    player?.seek(index); // a call: the recording follows the jump
    return true;
  }

  // The line being played (from the player). While it plays, a line that left the view is centred.
  function markPlaying(index, { follow = false } = {}) {
    if (destroyed || !loaded) return;
    if (playingAt !== null) rows[playingAt]?.el.classList.remove("is-playing");
    playingAt = validIndex(index, rows.length) ? index : null;
    if (playingAt === null) return;
    const row = rows[playingAt].el;
    row.classList.add("is-playing");
    const above = row.offsetTop < scroller.scrollTop;
    const below = row.offsetTop + row.offsetHeight > scroller.scrollTop + scroller.clientHeight;
    if (follow && (above || below)) centre(playingAt);
  }

  function seekSeconds(seconds) {
    return player?.seekSeconds?.(seconds) ?? false;
  }
  let markReady;
  const ready = new Promise((resolve) => (markReady = resolve));
  const handle = { el, ready, highlight, focusMessage, seekSeconds, destroy };

  // ---- loading --------------------------------------------------------------------------------

  function show(conversation) {
    markReady();
    const transcript = Array.isArray(conversation?.transcript) ? conversation.transcript : [];
    const channel = conversation?.channel === "voice call" ? t("queue.channel.call") : conversation?.channel === "agent chat" ? t("queue.channel.chat") : "";
    const translationEpoch = ++translationRun;
    translationOn = false;
    translationCache = null;
    const translate = h("button", {
      class: "cqa-sc-btn", text: t("translate.show"),
      attrs: { type: "button", "aria-pressed": "false" }, data: { test: "translate-toggle" },
      on: { click: async () => {
        if (destroyed || translationEpoch !== translationRun) return;
        translationOn = !translationOn;
        translate.setAttribute("aria-pressed", String(translationOn));
        setLocalizedText(translate, translationOn ? t("translate.hide") : t("translate.show"));
        if (!translationOn) {
          rows.forEach(({ el }) => el.querySelector(".msg-translation")?.remove());
          return;
        }
        translate.disabled = true;
        setLocalizedText(translate, t("translate.loading"));
        try {
          const data = translationCache ?? await api.getTranslation(id, "ru");
          if (destroyed || translationEpoch !== translationRun) return;
          translationCache = data;
          for (const message of data.messages ?? []) {
            const row = rows[message.message_index];
            if (!row || typeof message.text !== "string") continue;
            row.el.append(h("p", { class: "msg-translation", attrs: { lang: "ru" }, verbatim: true, text: message.text }));
          }
          setLocalizedText(translate, t("translate.hide"));
        } catch (error) {
          if (destroyed || translationEpoch !== translationRun) return;
          translationOn = false;
          translate.setAttribute("aria-pressed", "false");
          setLocalizedText(translate, t("translate.retry"));
          toastError(store, error);
        } finally {
          if (!destroyed && translationEpoch === translationRun) translate.disabled = false;
        }
      } },
    });
    clear(head).append(
      h("b", { class: "cqa-tr-title", verbatim: true, text: conversation?.conversation_id ?? id ?? "", data: { test: "transcript-title" } }),
      h("span", { class: "cqa-tr-meta", text: [channel, conversation?.language, t("transcript.lines", { n: transcript.length })].filter(Boolean).join(" · "), data: { test: "transcript-meta" } }),
    );
    if (["KZ", "EN"].includes(conversation?.language?.toUpperCase())) head.append(translate);
    clear(scroller);
    rows = [];
    marked = [];
    playingAt = null;
    loaded = true;
    shown = shownKey(conversation);
    player?.destroy();
    player = renderPlayer(conversation, api, {
      markPlaying,
      openImport: () => openImport(store, api, el.closest(".cqa") ?? el, { group: conversation?.group_id }),
    });
    clear(playerHost);
    if (player) playerHost.append(player.el);
    if (transcript.length === 0) {
      scroller.append(stateBox("transcript-empty", t("transcript.empty"), t("transcript.emptyNote")));
    } else {
      // With a recording, a line's time is where it starts in the recording, and it seeks there.
      const audible = Boolean(api.audioUrl?.(conversation)) && conversation?.channel === "voice call";
      // A line with no start in the recording (before it began) keeps the dialogue's own clock.
      const clock = offsets(transcript);
      const starts = audible ? startTimes(conversation) : null;
      const at = audible ? starts.map((start, i) => start ?? clock[i]) : clock;
      const seek = (index) => player?.seek(index);
      rows = transcript.map((message, i) => buildMessage(message, i, at[i], audible && starts[i] !== null ? seek : null));
      scroller.append(h("ol", { class: "cqa-tr-msgs", data: { test: "transcript-msgs" } }, rows.map((row) => row.el)));
    }
    const { highlight: waiting, focus } = pending;
    pending = { highlight: null, focus: null };
    if (waiting) applyHighlight(...waiting);
    if (focus !== null) focusMessage(focus);
  }

  function showError(error) {
    markReady();
    player?.destroy();
    player = null;
    clear(playerHost);
    clear(head);
    clear(scroller).append(
      stateBox(
        "transcript-error",
        t("transcript.loadFailed", { id }),
        errorText(error),
        h("button", { class: "cqa-tr-retry", attrs: { type: "button" }, text: t("transcript.retry"), data: { test: "transcript-retry" }, on: { click: load } }),
      ),
    );
  }

  let run = 0;
  async function load() {
    const mine = ++run;
    loaded = false;
    rows = [];
    marked = [];
    clear(scroller).append(stateBox("transcript-loading", t("transcript.loading", { id })));
    try {
      const conversation = await api.getConversation(id);
      if (destroyed || mine !== run) return;
      show(conversation);
    } catch (error) {
      if (destroyed || mine !== run) return;
      showError(error);
    }
  }

  // After an import: fetch the dialogue again and redraw it only if it changed. A pane that is not
  // showing the dialogue (still loading, or failed) loads it again instead.
  async function refresh() {
    if (destroyed || id === null) return;
    if (!loaded) {
      load();
      return;
    }
    const mine = ++run;
    try {
      const conversation = await api.getConversation(id);
      if (destroyed || mine !== run || shownKey(conversation) === shown) return;
      const top = scroller.scrollTop;
      if (pending.highlight === null && lastHighlight !== null) pending.highlight = lastHighlight;
      show(conversation);
      scroller.scrollTop = top;
    } catch (error) {
      if (destroyed || mine !== run) return;
      toastError(store, error, { retry: refresh }); // the lines on screen stay
    }
  }

  // ---- publishing the handle ------------------------------------------------------------------

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    markReady();
    stopRefresh();
    player?.destroy();
    flashTimers.forEach((timer) => clearTimeout(timer));
    flashTimers.clear();
    if (store.get().transcript === handle) store.set({ transcript: null });
    const hook = window.__cqaTest;
    if (hook?.store === store && hook.transcript?.focusMessage === focusMessage) hook.transcript = null;
  }

  const stopRefresh = watch(store, (state) => state.importRefresh, () => refresh());
  store.set({ transcript: handle });
  const hook = window.__cqaTest;
  if (hook?.store === store) hook.transcript = { focusMessage, highlight, seekSeconds };

  if (id === null) {
    scroller.append(stateBox("transcript-empty", t("workspace.pick")));
    markReady();
  } else load();
  return handle;
}
