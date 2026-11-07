import { t, formatNumber, catalogs, grossKindsText } from "../i18n/ru.js";
// Server-owned report populations and final totals; no inferred accuracy or client-side scoring.
import { watch } from "../state/store.js";
import { clear, h } from "./dom.js";
import { href } from "./router.js";
import { errorText } from "./toast.js";
import { chartCard, countUp, donut, hbars, legend, matrix, radar, ring, stack, tooltips } from "./charts.js";

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

// --- charts: drawn from the same server numbers as the tables below them, nothing recomputed ---
const sum = (rows, key) => rows.reduce((total, r) => total + (numeric(r[key]) ? r[key] : 0), 0);
const grid = (...cards) => h("div", { class: "cqa-chart-grid" }, cards.filter(Boolean));
/** Mean of the per-group averages weighted by their n; null when no group has an average. */
export function weightedAverage(rows) {
  const known = rows.filter((r) => numeric(r.avg_total) && r.n > 0);
  const n = sum(known, "n");
  return n ? known.reduce((total, r) => total + r.avg_total * r.n, 0) / n : null;
}
const groupRows = (rows, field) => rows.filter((r) => numeric(r.avg_total)).map((r) => {
  const label = field === "channel" ? channelText(r[field]) : r[field];
  return { label, verbatim: field !== "channel", value: r.avg_total / 100, text: averageText(r.avg_total), tip: t("reports.chart.tipValue", { title: label, value: averageText(r.avg_total), n: r.n }) };
});
function statTile(label, to, format) {
  const value = h("span", { class: "cqa-hero-value", text: format(to) });
  countUp(value, to, format);
  return h("div", { class: "cqa-hero-stat" }, h("span", { class: "cqa-report-brand-label", text: label }), value);
}
function analyticsHero(data) {
  const avg = weightedAverage(data.by_channel ?? []);
  const total = sum(data.by_channel ?? [], "n");
  return h("div", { class: "cqa-report-brand cqa-hero", data: { test: "analytics-hero" } },
    avg === null ? null : h("div", { class: "cqa-hero-main" }, statTile(t("reports.average"), avg, averageText)),
    statTile(t("reports.hero.evals"), total, (v) => String(Math.round(v))),
    statTile(t("reports.hero.gross"), data.gross_errors?.count ?? 0, (v) => String(Math.round(v))));
}
function analyticsCharts(data) {
  const criteria = data.by_criterion ?? [];
  const rank = [...criteria].sort((a, b) => b.fail_rate - a.fail_rate).map((r, i) => ({
    label: r.title || r.criterion_id, verbatim: true, value: r.fail_rate, hot: i === 0 && r.fail_rate > 0, text: percentText(r.fail_rate),
    tip: t("reports.chart.tipFail", { title: r.title || r.criterion_id, fail: percentText(r.fail_rate), na: percentText(r.na_rate), n: r.n }) }));
  const shape = criteria.map((r) => ({ label: r.criterion_id.toUpperCase(), value: 1 - r.fail_rate,
    tip: t("reports.chart.tipValue", { title: r.title || r.criterion_id, value: percentText(1 - r.fail_rate), n: r.n }) }));
  const groups = [...groupRows(data.by_language ?? [], "language"), ...groupRows(data.by_channel ?? [], "channel")];
  const kinds = [...(data.gross_errors?.by_kind ?? [])].sort((a, b) => b.count - a.count);
  const shown = kinds.slice(0, 4), rest = sum(kinds.slice(4), "count");
  const slices = [...shown.map((k) => ({ value: k.count, label: k.kind, verbatim: true })), ...(rest ? [{ value: rest, label: t("reports.chart.other") }] : [])]
    .map((s, tone) => ({ ...s, tone, tip: `${s.label}: ${s.value}` }));
  return [analyticsHero(data), grid(
    shape.length >= 3 ? chartCard(t("reports.chart.shape"), t("reports.chart.shapeNote"), radar(shape)) : null,
    chartCard(t("reports.chart.failRank"), t("reports.failures"), hbars(rank)),
    groups.length ? chartCard(t("reports.chart.scores"), null, hbars(groups)) : null,
    slices.length ? chartCard(t("reports.grossKinds"), null, donut(slices, String(data.gross_errors?.count ?? 0), t("reports.hero.gross")), legend(slices)) : null)];
}
const ANSWERS = ["yes", "no", "na", "step"];
const answerKey = (value) => (typeof value === "string" ? value : "step");
const answerLabel = (key) => (key === "step" ? t("reports.chart.step") : reportAnswer(key));
function accuracyCharts(data) {
  const ref = data.overall.agreement;
  const rows = (list, field) => list.filter((r) => numeric(r.agreement)).map((r) => {
    const label = field === "title" ? r.title : field === "channel" ? channelText(r.channel) : r[field];
    return { label, verbatim: field !== "channel", value: r.agreement, text: percentText(r.agreement), tip: t("reports.chart.tipValue", { title: label, value: percentText(r.agreement), n: r.n }) };
  });
  const parts = [{ value: data.overall.n, tone: 1, text: t("reports.chart.compared") }, { value: data.missing ?? 0, tone: 3, text: t("reports.chart.missing") },
    { value: data.disputed_excluded ?? 0, tone: 2, text: t("reports.chart.disputed") }].map((p) => ({ ...p, tip: `${p.text}: ${p.value}` }));
  const counts = new Map();
  for (const r of data.disagreements ?? []) {
    const key = `${answerKey(r.reference)}|${answerKey(r.evaluated)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const used = (side) => ANSWERS.filter((k) => [...counts.keys()].some((c) => c.split("|")[side] === k)).map((key) => ({ key, label: answerLabel(key) }));
  const groups = [...rows(data.by_language ?? [], "language"), ...rows(data.by_channel ?? [], "channel")];
  return grid(
    chartCard(t("reports.byCriterion"), t("reports.chart.refLine"), hbars(rows(data.by_criterion ?? [], "title"), { ref })),
    groups.length ? chartCard(`${t("reports.byLanguage")} · ${t("reports.byChannel")}`, t("reports.chart.refLine"), hbars(groups, { ref })) : null,
    chartCard(t("reports.chart.coverage"), null, stack(parts), legend(parts.map((p) => ({ tone: p.tone, text: `${p.text}: ${p.value}` })))),
    counts.size ? chartCard(t("reports.chart.matrix"), t("reports.chart.matrixNote"),
      matrix(used(0), used(1), counts, (r, c, n) => t("reports.chart.tipCell", { from: r.label, to: c.label, n }))) : null);
}
export function createReportsPage(store, api, route = store.get().route) {
  const accuracy = route.name === "accuracy";
  const body = h("div", { class: "cqa-report-body", attrs: { "aria-live": "polite" } });
  const refresh = h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("reports.refresh"), data: { test: "reports-refresh" }, on: { click: () => load() } });
  const el = h("div", { class: "cqa-reports", data: { test: accuracy ? "accuracy-page" : "analytics-page" } },
    h("div", { class: "cqa-report-head" }, h("h1", { text: accuracy ? t("reports.accuracyTitle") : t("reports.analyticsTitle") }), refresh),
    h("p", { class: "cqa-report-muted", text: accuracy ? t("reports.accuracyNote") : t("reports.analyticsNote") }), body);
  tooltips(el);
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
        h("span", { class: "cqa-report-brand-n", text: t("reports.overallN", { n: data.overall.n }) }),
        numeric(data.overall.agreement) ? ring(data.overall.agreement, percentText(data.overall.agreement)) : null) : null,
      h("p", { data: { test: "accuracy-counts" }, text: t("reports.counts", {missing:data.missing ?? 0,disputed:data.disputed_excluded ?? 0}) }),
    ].filter(Boolean));
    // Without compared answers every breakdown row is a dash: say what to run instead.
    if (!compared) {
      body.append(h("p", { class: "cqa-report-empty", text: accuracyEmptyText(data), data: { test: "reports-empty" } }));
      return;
    }
    body.append(accuracyCharts(data));
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
    else body.append(...analyticsCharts(data));
    body.append(table(t("reports.byCriterion"), [t("reports.criterion"), t("reports.failures"), "N/A", "n"], criteria.map((r) => [cell(r.title || r.criterion_id,true), bar(r.fail_rate), bar(r.na_rate), num(r.n)]), "analytics-criterion"));
    for (const [key, label, heading, field] of [["by_language", t("reports.avgLanguage"), t("reports.languageColumn"), "language"], ["by_channel", t("reports.avgChannel"), t("reports.channelColumn"), "channel"]]) {
      body.append(table(label, [heading, t("reports.average"), "n"], (data[key] ?? []).map((r) => [cell(field === "channel" ? channelText(r[field]) : r[field],field !== "channel"), num(averageText(r.avg_total)), num(r.n)]), `analytics-${field}`));
    }
    const gross = data.gross_errors ?? {};
    body.append(h("h2", { text: t("reports.gross", {n:gross.count ?? 0}), data: { test: "analytics-gross" } }),
      table(t("reports.grossKinds"), [t("reports.kind"), t("reports.count")], (gross.by_kind ?? []).map((r) => [cell(grossKindsText([r.kind])), num(r.count)])),
      h("ul", { class: "cqa-report-links" }, (gross.conversations ?? []).map((id) => h("li", {}, link(id)))));
  }
  async function load() {
    const mine = ++run;
    refresh.disabled = true;
    body.removeAttribute("data-test");
    body.classList.remove("is-in");
    clear(body).append(h("p", { text: t("reports.loading"), data: { test: "reports-loading" } }));
    try {
      const data = await (accuracy ? api.getAccuracy() : api.getAnalytics());
      if (destroyed || mine !== run) return;
      clear(body);
      body.setAttribute("data-test", "reports-ready");
      if (accuracy) accuracyReport(data); else analyticsReport(data);
      // Two frames: the charts are painted empty first, then the `.is-in` transitions draw them.
      requestAnimationFrame(() => requestAnimationFrame(() => { if (!destroyed && mine === run) body.classList.add("is-in"); }));
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
