import { t, formatNumber, catalogs, grossKindsText } from "../i18n/ru.js";
// Server-owned report populations and final totals; no client-side scoring.
import { watch } from "../state/store.js";
import { clear, h } from "./dom.js";
import { href } from "./router.js";
import { errorText } from "./toast.js";
import { chartCard, countUp, donut, hbars, legend, radar, tooltips } from "./charts.js";

const numeric = (value) => typeof value === "number" && Number.isFinite(value);
export const percentText = (value) => numeric(value) ? `${formatNumber(value * 100, {maximumFractionDigits:2})} %` : "—";
export const averageText = (value) => numeric(value) ? formatNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
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
  return { label, verbatim: field !== "channel", value: r.avg_total / 100, text: `${averageText(r.avg_total)} · n=${r.n}`, tip: t("reports.chart.tipValue", { title: label, value: averageText(r.avg_total), n: r.n }) };
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
  const gross = data.gross_errors ?? {};
  const kinds = [...(gross.by_kind ?? [])].sort((a, b) => b.count - a.count);
  const shown = kinds.slice(0, 4), rest = sum(kinds.slice(4), "count");
  // Gross errors without a kind still count: one unnamed slice, so the ring never contradicts the total.
  const unnamed = Math.max(0, (gross.count ?? 0) - sum(kinds, "count"));
  const slices = [...shown.map((k) => ({ value: k.count, label: k.kind, verbatim: true })), ...(rest + unnamed ? [{ value: rest + unnamed, label: t("reports.chart.other") }] : [])]
    .map((s, tone) => ({ ...s, tone, tip: `${s.label}: ${s.value}` }));
  const ids = gross.conversations ?? [];
  const grossCard = chartCard(t("reports.grossKinds"), null, donut(slices, String(gross.count ?? 0), t("reports.hero.gross")),
    slices.length ? legend(slices.map((x) => ({ tone: x.tone, text: `${x.label}: ${x.value}`, verbatim: x.verbatim }))) : h("p", { class: "cqa-report-muted", text: t("reports.emptyCell") }),
    ids.length ? h("details", { class: "cqa-gross-links" }, h("summary", { text: t("reports.chart.grossLinks", { n: ids.length }) }),
      h("ul", { class: "cqa-report-links" }, ids.map((id) => h("li", {}, link(id))))) : null);
  grossCard.dataset.test = "analytics-gross";
  return [analyticsHero(data), grid(
    shape.length >= 3 ? chartCard(t("reports.chart.shape"), t("reports.chart.shapeNote"), radar(shape)) : null,
    chartCard(t("reports.chart.failRank"), t("reports.failures"), hbars(rank)),
    h("div", { class: "cqa-chart-col" }, groups.length ? chartCard(t("reports.chart.scores"), null, hbars(groups)) : null, grossCard))];
}
export function createReportsPage(store, api, route = store.get().route) {
  const body = h("div", { class: "cqa-report-body", attrs: { "aria-live": "polite" } });
  const refresh = h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("reports.refresh"), data: { test: "reports-refresh" }, on: { click: () => load() } });
  const el = h("div", { class: "cqa-reports", data: { test: "analytics-page" } },
    h("div", { class: "cqa-report-head" }, h("h1", { text: t("reports.analyticsTitle") }), refresh),
    h("p", { class: "cqa-report-muted", text: t("reports.analyticsNote") }), body);
  tooltips(el);
  let destroyed = false;
  let run = 0;
  function analyticsReport(data) {
    const criteria = data.by_criterion ?? [];
    if (!criteria.length) body.append(h("p", { text: t("reports.noEvaluations"), data: { test: "reports-empty" } }));
    else body.append(...analyticsCharts(data));
    body.append(table(t("reports.byCriterion"), [t("reports.criterion"), t("reports.failures"), "N/A", "n"], criteria.map((r) => [cell(r.title || r.criterion_id,true), bar(r.fail_rate), bar(r.na_rate), num(r.n)]), "analytics-criterion"));
  }
  async function load() {
    const mine = ++run;
    refresh.disabled = true;
    body.removeAttribute("data-test");
    body.classList.remove("is-in");
    clear(body).append(h("p", { text: t("reports.loading"), data: { test: "reports-loading" } }));
    try {
      const data = await api.getAnalytics();
      if (destroyed || mine !== run) return;
      clear(body);
      body.setAttribute("data-test", "reports-ready");
      analyticsReport(data);
      // Two frames: the charts are painted empty first, then the `.is-in` transitions draw them.
      requestAnimationFrame(() => requestAnimationFrame(() => { if (!destroyed && mine === run) body.classList.add("is-in"); }));
    } catch (error) {
      if (destroyed || mine !== run) return;
      body.removeAttribute("data-test");
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
