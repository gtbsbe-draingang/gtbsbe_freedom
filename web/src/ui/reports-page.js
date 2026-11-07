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
const channelText = (value) => ({ "agent chat": t("reports.channel.chat"), "voice call": t("reports.channel.call") })[value] ?? value;
const cell = (text,verbatim=false) => h("td", { text,verbatim });
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
    body.append(
      h("p", { class: "cqa-report-reference", verbatim:Boolean(data.reference_note) && data.reference_note !== catalogs.ru["reports.referenceDemo"], text: data.reference_note || t("reports.referenceMissing"), data: { test: "accuracy-reference" } }),
      h("p", { text: t("reports.model", {model:data.model ?? "—"}) }),
      h("div", { class: "cqa-report-brand", data: { test: "accuracy-overall" }, text: t("reports.overall", {agreement:percentText(data.overall?.agreement),n:data.overall?.n ?? 0}) }),
      h("p", { data: { test: "accuracy-counts" }, text: t("reports.counts", {missing:data.missing ?? 0,disputed:data.disputed_excluded ?? 0}) }));
    if (!data.overall?.n) body.append(h("p", { text: t("reports.noComparable"), data: { test: "reports-empty" } }));
    for (const [key, label, field] of [["by_criterion", t("reports.byCriterion"), "title"], ["by_language", t("reports.byLanguage"), "language"], ["by_channel", t("reports.byChannel"), "channel"]]) {
      body.append(table(label, [t("reports.group"), t("reports.agreement"), "n"], (data[key] ?? []).map((r) => [cell(field === "channel" ? channelText(r[field]) : r[field],field !== "channel"), bar(r.agreement), cell(r.n)]), `accuracy-${key.slice(3)}`));
    }
    body.append(table(t("reports.disagreements"), [t("reports.conversation"), t("reports.criterion"), t("reports.reference"), t("reports.evaluated")], (data.disagreements ?? []).map((r) => [h("td", {}, link(r.conversation, r.conversation_id)), cell(r.criterion_id), cell(reportAnswer(r.reference)), cell(reportAnswer(r.evaluated))]), "disagreement"));
  }
  function analyticsReport(data) {
    const criteria = data.by_criterion ?? [];
    if (!criteria.length) body.append(h("p", { text: t("reports.noEvaluations"), data: { test: "reports-empty" } }));
    body.append(table(t("reports.byCriterion"), [t("reports.criterion"), t("reports.failures"), "N/A", "n"], criteria.map((r) => [cell(r.title || r.criterion_id,true), bar(r.fail_rate), bar(r.na_rate), cell(r.n)]), "analytics-criterion"));
    for (const [key, label, field] of [["by_language", t("reports.avgLanguage"), "language"], ["by_channel", t("reports.avgChannel"), "channel"]]) {
      body.append(table(label, [t("reports.group"), t("reports.average"), "n"], (data[key] ?? []).map((r) => [cell(field === "channel" ? channelText(r[field]) : r[field],field !== "channel"), cell(averageText(r.avg_total)), cell(r.n)]), `analytics-${field}`));
    }
    const gross = data.gross_errors ?? {};
    body.append(h("h2", { text: t("reports.gross", {n:gross.count ?? 0}), data: { test: "analytics-gross" } }),
      table(t("reports.grossKinds"), [t("reports.kind"), t("reports.count")], (gross.by_kind ?? []).map((r) => [cell(r.kind), cell(r.count)])),
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
