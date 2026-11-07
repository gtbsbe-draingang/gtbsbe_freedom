// The transcript pane: the dialogue as bubbles (client left, operator and bot right, system lines
// as centred notes), built once per conversation.
//
//   renderTranscript(store, api, {id}?) -> { el, highlight, focusMessage, destroy }
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
import { canonicalJson } from "../domain/fingerprint.js";
import { formatOffset, offsets } from "../domain/time.js";
import { t } from "../i18n/ru.js";
import { watch } from "../state/store.js";
import { clear, h } from "./dom.js";
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
  return canonicalJson({ conversation_id: conversation?.conversation_id ?? null, channel: conversation?.channel ?? null, language: conversation?.language ?? null, transcript });
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

function buildMessage(message, index, offset) {
  const kind = speakerKind(message?.speaker);
  const raw = typeof message?.timestamp === "string" ? message.timestamp.trim() : "";
  const clock = formatOffset(offset) || raw;

  const flag = h("b", { class: "cqa-msg-flag", data: { test: "msg-flag" } });
  const who = h(
    "div",
    { class: "cqa-msg-who" },
    flag,
    kind === "system" ? null : h("span", { class: "cqa-msg-speaker", text: t(`transcript.speaker.${kind}`), attrs: kind === "other" && message?.speaker ? { title: String(message.speaker) } : {}, data: { test: "msg-speaker" } }),
    clock === "" ? null : h("span", { class: "cqa-msg-time", text: clock, attrs: raw === "" ? {} : { title: raw }, data: { test: "msg-time" } }),
    message?.duplicate ? h("span", { class: "cqa-msg-dup", text: t("transcript.duplicate"), attrs: { title: t("transcript.duplicateTitle") } }) : null,
  );
  const text = h("p", { class: "cqa-msg-text", text: typeof message?.text === "string" ? message.text : "" });
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
  const el = h("div", { class: "cqa-tr", data: { test: "transcript" } }, head, scroller);

  let destroyed = false;
  let rows = []; // [{el, flag}] per message, empty until loaded
  let loaded = false; // the dialogue is on screen (it may have no lines)
  let marked = []; // indexes with a highlight class, so clearing touches only those
  let pending = { highlight: null, focus: null };
  let lastHighlight = null; // the arguments of the marks on screen, applied again after a redraw
  let shown = null; // shownKey() of the dialogue on screen
  const flashTimers = new Map(); // index -> timer id

  // ---- highlight and focus --------------------------------------------------------------------

  function clearMarks() {
    for (const i of marked) {
      const row = rows[i];
      row.el.classList.remove("is-evidence", "is-expected", "is-checked");
      row.el.removeAttribute("data-criterion");
      row.flag.textContent = "";
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
      flag.textContent = [mark.supports ? name : "", mark.expected ? t("transcript.expectedHere") : ""].filter(Boolean).join(" · ");
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

  function focusMessage(index) {
    if (destroyed) return false;
    if (!loaded) {
      pending.focus = index;
      return Number.isInteger(index) && index >= 0;
    }
    if (!validIndex(index, rows.length)) return false;
    const row = rows[index].el;
    // Scroll the pane's own scroller to put the message in the middle. scrollIntoView would also
    // move the page, and with it the scorecard next to the transcript.
    const top = row.offsetTop - (scroller.clientHeight - row.offsetHeight) / 2;
    scroller.scrollTo({ top: Math.max(0, top), behavior: "auto" });
    flash(index);
    return true;
  }

  const handle = { el, highlight, focusMessage, destroy };

  // ---- loading --------------------------------------------------------------------------------

  function show(conversation) {
    const transcript = Array.isArray(conversation?.transcript) ? conversation.transcript : [];
    const channel = conversation?.channel === "voice call" ? t("queue.channel.call") : conversation?.channel === "agent chat" ? t("queue.channel.chat") : "";
    clear(head).append(
      h("b", { class: "cqa-tr-title", text: conversation?.conversation_id ?? id ?? "", data: { test: "transcript-title" } }),
      h("span", { class: "cqa-tr-meta", text: [channel, conversation?.language, t("transcript.lines", { n: transcript.length })].filter(Boolean).join(" · "), data: { test: "transcript-meta" } }),
    );
    clear(scroller);
    rows = [];
    marked = [];
    loaded = true;
    shown = shownKey(conversation);
    if (transcript.length === 0) {
      scroller.append(stateBox("transcript-empty", t("transcript.empty"), t("transcript.emptyNote")));
    } else {
      const at = offsets(transcript);
      rows = transcript.map((message, i) => buildMessage(message, i, at[i]));
      scroller.append(h("ol", { class: "cqa-tr-msgs", data: { test: "transcript-msgs" } }, rows.map((row) => row.el)));
    }
    const { highlight: waiting, focus } = pending;
    pending = { highlight: null, focus: null };
    if (waiting) applyHighlight(...waiting);
    if (focus !== null) focusMessage(focus);
  }

  function showError(error) {
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
    stopRefresh();
    flashTimers.forEach((timer) => clearTimeout(timer));
    flashTimers.clear();
    if (store.get().transcript === handle) store.set({ transcript: null });
    const hook = window.__cqaTest;
    if (hook?.store === store && hook.transcript?.focusMessage === focusMessage) hook.transcript = null;
  }

  const stopRefresh = watch(store, (state) => state.importRefresh, () => refresh());
  store.set({ transcript: handle });
  const hook = window.__cqaTest;
  if (hook?.store === store) hook.transcript = { focusMessage, highlight };

  if (id === null) scroller.append(stateBox("transcript-empty", t("workspace.pick")));
  else load();
  return handle;
}
