import { t } from "../i18n/ru.js";
// Measured audio features are supplied by the backend; the UI never infers them from text.
import { formatOffset } from "../domain/time.js";
import { h } from "./dom.js";

export function measurementsFor(conversation, result) {
  if (conversation?.channel !== "voice call") return [];
  const evidence = new Set((result?.evidence ?? []).map((e) => e.message_index));
  return (conversation.voice_measurements ?? []).filter((m) =>
    Number.isInteger(m.message_index) && m.message_index >= 0 && m.message_index < conversation.transcript.length &&
    (evidence.has(m.message_index) || (Number.isInteger(result?.checked_range?.from) &&
      m.message_index >= result.checked_range.from && m.message_index <= result.checked_range.to)));
}

const value = (n) => typeof n === "number" && Number.isFinite(n) ? String(n) : "—";
export function renderVoiceMeasurements(conversation, result, seek) {
  const rows = measurementsFor(conversation, result);
  if (!rows.length) return null;
  const body = rows.map((m) => h("tr", {},
    h("td", {}, h("button", { class: "cqa-link", attrs: { type: "button" }, data: { test: "voice-seek" },
      text: `${formatOffset(m.from_seconds)}–${formatOffset(m.to_seconds)}`, on: { click: () => seek(m) } })),
    [m.pitch_range, m.rate_wpm, m.pauses, m.overlap].map((n) => h("td", { class: "num", text: value(n) }))));
  const table = h("table", { class: "cqa-voice-table" },
    h("caption", { text: t("voice.caption") }),
    h("thead", {}, h("tr", {}, [t("voice.segment"), t("voice.pitch"), t("voice.rate"), t("voice.pauses"), t("voice.overlap")].map((text) => h("th", { attrs: { scope: "col" }, text })))),
    h("tbody", {}, body));
  return h("div", { class: "cqa-voice", data: { test: "voice-measurements" } },
    h("p", { text: t("voice.title") }),
    h("div", { class: "cqa-table-scroll" }, table));
}
