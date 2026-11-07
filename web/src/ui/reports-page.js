import { t, formatNumber, catalogs } from "../i18n/ru.js";
// Server-owned report populations and final totals; no inferred accuracy or client-side scoring.
import { watch } from "../state/store.js";
import { clear, h } from "./dom.js";
import { href } from "./router.js";
import { errorText } from "./toast.js";

const numeric = (value) => typeof value === "number" && Number.isFinite(value);
export const percentText = (value) => numeric(value) ? `${formatNumber(value * 100, {maximumFractionDigits:2})} %` : "—";
export const averageText = (value) => numeric(value) ? formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
export function reportAnswer(value) {
  if (value === "yes") return t("scorecard.answer.yes");
  if (value === "no") return t("scorecard.answer.no");
  if (value === "na") return "N/A";
  if (numeric(value?.step)) return t("scorecard.answer.step",{value:value.step});
  return typeof value === "string" ? value : "—";
}
// Reference notes the server sends in Russian that the catalogs translate (the backend's fixed note
// and the mock's demo note). Any other note is the server's own text and is shown as sent.
const KNOWN_NOTES = ["reports.referenceDraft", "reports.referenceDemo"];
export function referenceNote(note) {
  if (typeof note !== "string" || note.trim() === "") return { text: t("reports.referenceMissing"), verbatim: false };
  const key = KNOWN_NOTES.find((k) => catalogs.ru[k] === note);
  return key ? { text: t(key), verbatim: false } : { text: note, verbatim: true };
}
// The backend joins the models it saw with commas and sends "" when no answer was compared.
export function modelText(model) {
  const names = typeof model === "string" ? model.split(",").map((name) => name.trim()).filter(Boolean) : [];
  return names.length ? names.join(", ") : "—";
}
// The checklist version the report measured, when the server sends it ({checklist_id, version, name}).
const measured = (ref) => (ref?.checklist_id && numeric(ref.version) ? { name: ref.name || ref.checklist_id, version: ref.version } : null);
/** What an accuracy report with no compared answers says: what to run, when answers are missing. */
export function accuracyEmptyText(data) {
  if (!(data?.missing > 0)) return t("reports.noComparable");
  const ref = measured(data.checklist);
  return ref ? t("reports.noComparableVersion", ref) : t("reports.noComparableRun");
}
// Criterion titles in checklist order, from the report's own by-criterion rows.
const criterionTitles = (data) => new Map((data.by_criterion ?? []).map((r) => [r.criterion_id, r.title || r.criterion_id]));
/** Options of the disagreement filter: all, then each criterion that has one, in checklist order. */
export function disagreementFilters(data) {
  const rows = data.disagreements ?? [];
  const titles = criterionTitles(data);
  const counts = new Map();
  for (const r of rows) counts.set(r.criterion_id, (counts.get(r.criterion_id) ?? 0) + 1);
  const order = [...new Set([...titles.keys(), ...counts.keys()])].filter((id) => counts.has(id));
  return [{ value: "", label: t("reports.allCriteria", { n: rows.length }), verbatim: false },
    ...order.map((id) => ({ value: id, label: `${titles.get(id) ?? id} (${counts.get(id)})`, verbatim: true }))];
}
const channelText = (value) => ({ "agent chat": t("reports.channel.chat"), "voice call": t("reports.channel.call") })[value] ?? value;
const cell = (text,verbatim=false) => h("td", { text,verbatim });
// Tabular figures only in number cells: CoFo Sans's tnum also widens spaces in text.
const num = (value) => h("td", { class: "cqa-report-num", text: value });
const link = (id, label) => h("a", { class: "cqa-link", attrs: { href: href("workspace", { id }) }, verbatim:true, text: label ?? id });
function bar(value) {
  const el = h("div", { class: "cqa-report-bar" },
    h("span", { text: percentText(value) }),
    numeric(value) ? h("span", { class: "cqa-report-track", attrs: { "aria-hidden": "true" } },
      h("span", { class: "cqa-report-fill", style: { width: `${Math.min(1, Math.max(0, value)) * 100}%` } })) : null);
  return h("td", {}, el);
}
function table(title, headings, rows, test) {
  return h("section", { class: "cqa-report-section" },
    h("h2", { text: title }),
    rows.length ? h("div", { class: "cqa-table-scroll" }, h("table", { class: "cqa-report-table" },
      h("caption", { class: "cqa-report-caption", text: title }),
      h("thead", {}, h("tr", {}, headings.map((text) => h("th", { attrs: { scope: "col" }, text })))),
      h("tbody", {}, rows.map((cells) => h("tr", { data: { test } }, cells))))) : h("p", { class: "cqa-report-muted", text: t("reports.emptyCell") }));
}
export function createReportsPage(store, api, route = store.get().route) {
  const accuracy = route.name === "accuracy";
  const body = h("div", { attrs: { "aria-live": "polite" } });
  const refresh = h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("reports.refresh"), data: { test: "reports-refresh" }, on: { click: () => load() } });
  const el = h("div", { class: "cqa-reports", data: { test: accuracy ? "accuracy-page" : "analytics-page" } },
    h("div", { class: "cqa-report-head" }, h("h1", { text: accuracy ? t("reports.accuracyTitle") : t("reports.analyticsTitle") }), refresh),
    h("p", { class: "cqa-report-muted", text: accuracy ? t("reports.accuracyNote") : t("reports.analyticsNote") }), body);
  let destroyed = false;
  let run = 0;
  function accuracyReport(data) {
    const note = referenceNote(data.reference_note);
    const ref = measured(data.checklist);
    const compared = data.overall?.n > 0;
    // Native append writes null as the text "null", so absent parts are dropped first.
    body.append(...[
      h("p", { class: "cqa-report-reference", verbatim: note.verbatim, text: note.text, data: { test: "accuracy-reference" } }),
      h("p", { class: "cqa-report-meta", text: t("reports.model", { model: modelText(data.model) }), data: { test: "accuracy-model" } }),
      ref ? h("p", { class: "cqa-report-meta", text: t("reports.checklist", ref), data: { test: "accuracy-checklist" } }) : null,
      compared ? h("div", { class: "cqa-report-brand", data: { test: "accuracy-overall" } },
        h("span", { class: "cqa-report-brand-label", text: t("reports.overallLabel") }),
        h("span", { class: "cqa-report-brand-value", text: percentText(data.overall.agreement) }),
        h("span", { class: "cqa-report-brand-n", text: t("reports.overallN", { n: data.overall.n }) })) : null,
      h("p", { data: { test: "accuracy-counts" }, text: t("reports.counts", {missing:data.missing ?? 0,disputed:data.disputed_excluded ?? 0}) }),
    ].filter(Boolean));
    // Without compared answers every breakdown row is a dash: say what to run instead.
    if (!compared) {
      body.append(h("p", { class: "cqa-report-empty", text: accuracyEmptyText(data), data: { test: "reports-empty" } }));
      return;
    }
    for (const [key, label, heading, field] of [["by_criterion", t("reports.byCriterion"), t("reports.criterion"), "title"], ["by_language", t("reports.byLanguage"), t("reports.languageColumn"), "language"], ["by_channel", t("reports.byChannel"), t("reports.channelColumn"), "channel"]]) {
      body.append(table(label, [heading, t("reports.agreement"), "n"], (data[key] ?? []).map((r) => [cell(field === "channel" ? channelText(r[field]) : r[field],field !== "channel"), bar(r.agreement), num(r.n)]), `accuracy-${key.slice(3)}`));
    }
    body.append(disagreementsSection(data));
  }
  function disagreementsSection(data) {
    const rows = data.disagreements ?? [];
    const titles = criterionTitles(data);
    const section = table(t("reports.disagreements"), [t("reports.conversation"), t("reports.criterion"), t("reports.reference"), t("reports.evaluated")],
      rows.map((r) => [h("td", {}, link(r.conversation, r.conversation_id)), cell(titles.get(r.criterion_id) ?? r.criterion_id, true), cell(reportAnswer(r.reference)), cell(reportAnswer(r.evaluated))]), "disagreement");
    if (!rows.length) return section;
    const trs = [...section.querySelectorAll("tbody tr")];
    rows.forEach((r, i) => { trs[i].dataset.criterion = r.criterion_id; });
    const filter = h("select", { class: "cqa-report-select", attrs: { "aria-label": t("reports.criterion") }, data: { test: "disagreement-filter" },
      on: { change: () => { for (const tr of trs) tr.hidden = filter.value !== "" && tr.dataset.criterion !== filter.value; } } },
      disagreementFilters(data).map((o) => h("option", { attrs: { value: o.value }, text: o.label, verbatim: o.verbatim })));
    section.querySelector("h2").after(filter);
    return section;
  }
  function analyticsReport(data) {
    const criteria = data.by_criterion ?? [];
    if (!criteria.length) body.append(h("p", { text: t("reports.noEvaluations"), data: { test: "reports-empty" } }));
    body.append(table(t("reports.byCriterion"), [t("reports.criterion"), t("reports.failures"), "N/A", "n"], criteria.map((r) => [cell(r.title || r.criterion_id,true), bar(r.fail_rate), bar(r.na_rate), num(r.n)]), "analytics-criterion"));
    for (const [key, label, heading, field] of [["by_language", t("reports.avgLanguage"), t("reports.languageColumn"), "language"], ["by_channel", t("reports.avgChannel"), t("reports.channelColumn"), "channel"]]) {
      body.append(table(label, [heading, t("reports.average"), "n"], (data[key] ?? []).map((r) => [cell(field === "channel" ? channelText(r[field]) : r[field],field !== "channel"), num(averageText(r.avg_total)), num(r.n)]), `analytics-${field}`));
    }
    const gross = data.gross_errors ?? {};
    body.append(h("h2", { text: t("reports.gross", {n:gross.count ?? 0}), data: { test: "analytics-gross" } }),
      table(t("reports.grossKinds"), [t("reports.kind"), t("reports.count")], (gross.by_kind ?? []).map((r) => [cell(r.kind), num(r.count)])),
      h("ul", { class: "cqa-report-links" }, (gross.conversations ?? []).map((id) => h("li", {}, link(id)))));
  }
  async function load() {
    const mine = ++run;
    refresh.disabled = true;
    body.removeAttribute("data-test");
    clear(body).append(h("p", { text: t("reports.loading"), data: { test: "reports-loading" } }));
    try {
      const data = await (accuracy ? api.getAccuracy() : api.getAnalytics());
      if (destroyed || mine !== run) return;
      clear(body);
      body.setAttribute("data-test", "reports-ready");
      if (accuracy) accuracyReport(data); else analyticsReport(data);
    } catch (error) {
      if (destroyed || mine !== run) return;
      body.removeAttribute("data-test");
      // No reference answers on the server: a state to explain, not a failure to retry.
      if (accuracy && error?.code === "reference_missing") {
        clear(body).append(h("p", { class: "cqa-report-empty", attrs: { role: "status" }, text: errorText(error), data: { test: "accuracy-no-reference" } }));
        return;
      }
      clear(body).append(h("div", { attrs: { role: "alert" }, data: { test: "reports-error" } },
        h("p", { text: t("reports.failed", {error:errorText(error)}) }),
        h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("toast.retry"), data: { test: "reports-retry" }, on: { click: () => load() } })));
    } finally {
      if (!destroyed && mine === run) refresh.disabled = false;
    }
  }
  const stop = watch(store, (s) => s.queueRefresh, () => load());
  load();
  return { el, destroy() { destroyed = true; run++; stop(); } };
}
