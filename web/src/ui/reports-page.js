// Server-owned report populations and final totals; no inferred accuracy or client-side scoring.
import { watch } from "../state/store.js";
import { clear, h } from "./dom.js";
import { href } from "./router.js";
import { errorText } from "./toast.js";

const numeric = (value) => typeof value === "number" && Number.isFinite(value);
export const percentText = (value) => numeric(value) ? `${(value * 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} %` : "—";
export const averageText = (value) => numeric(value) ? value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
export function reportAnswer(value) {
  if (value === "yes") return "Да";
  if (value === "no") return "Нет";
  if (value === "na") return "N/A";
  if (numeric(value?.step)) return `шаг ${value.step}`;
  return typeof value === "string" ? value : "—";
}
const channelText = (value) => ({ "agent chat": "Чат", "voice call": "Звонок" })[value] ?? value;
const cell = (text) => h("td", { text });
const link = (id, label) => h("a", { class: "cqa-link", attrs: { href: href("workspace", { id }) }, text: label ?? id });
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
      h("tbody", {}, rows.map((cells) => h("tr", { data: { test } }, cells))))) : h("p", { class: "cqa-report-muted", text: "Нет данных" }));
}
export function createReportsPage(store, api, route = store.get().route) {
  const accuracy = route.name === "accuracy";
  const body = h("div", { attrs: { "aria-live": "polite" } });
  const refresh = h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: "Обновить", data: { test: "reports-refresh" }, on: { click: () => load() } });
  const el = h("div", { class: "cqa-reports", data: { test: accuracy ? "accuracy-page" : "analytics-page" } },
    h("div", { class: "cqa-report-head" }, h("h1", { text: accuracy ? "Точность оценки" : "Отчёты: аналитика" }), refresh),
    h("p", { class: "cqa-report-muted", text: accuracy ? "Согласие с эталонными ответами. Источник эталона указан ниже." : "Итоговые оценки с учётом решений по апелляциям; набор данных и версия чек-листа определяются сервером." }), body);
  let destroyed = false;
  let run = 0;
  function accuracyReport(data) {
    body.append(
      h("p", { class: "cqa-report-reference", text: data.reference_note || "Источник эталонных ответов не указан", data: { test: "accuracy-reference" } }),
      h("p", { text: `Модель: ${data.model ?? "—"}` }),
      h("div", { class: "cqa-report-brand", data: { test: "accuracy-overall" }, text: `${percentText(data.overall?.agreement)} · n = ${data.overall?.n ?? 0}` }),
      h("p", { data: { test: "accuracy-counts" }, text: `нет оценки: ${data.missing ?? 0} · спорные исключены: ${data.disputed_excluded ?? 0}` }));
    if (!data.overall?.n) body.append(h("p", { text: "Нет сопоставимых оценок", data: { test: "reports-empty" } }));
    for (const [key, label, field] of [["by_criterion", "По критериям", "title"], ["by_language", "По языкам", "language"], ["by_channel", "По каналам", "channel"]]) {
      body.append(table(label, ["Группа", "Совпадение", "n"], (data[key] ?? []).map((r) => [cell(field === "channel" ? channelText(r[field]) : r[field]), bar(r.agreement), cell(r.n)]), `accuracy-${key.slice(3)}`));
    }
    body.append(table("Расхождения", ["Диалог", "Критерий", "Эталон", "Оценка модели"], (data.disagreements ?? []).map((r) => [h("td", {}, link(r.conversation, r.conversation_id)), cell(r.criterion_id), cell(reportAnswer(r.reference)), cell(reportAnswer(r.evaluated))]), "disagreement"));
  }
  function analyticsReport(data) {
    const criteria = data.by_criterion ?? [];
    if (!criteria.length) body.append(h("p", { text: "Нет оценённых диалогов. Запустите оценку в рабочей области.", data: { test: "reports-empty" } }));
    body.append(table("По критериям", ["Критерий", "Ошибки", "N/A", "n"], criteria.map((r) => [cell(r.title || r.criterion_id), bar(r.fail_rate), bar(r.na_rate), cell(r.n)]), "analytics-criterion"));
    for (const [key, label, field] of [["by_language", "Средний итог по языкам", "language"], ["by_channel", "Средний итог по каналам", "channel"]]) {
      body.append(table(label, ["Группа", "Средний итог", "n"], (data[key] ?? []).map((r) => [cell(field === "channel" ? channelText(r[field]) : r[field]), cell(averageText(r.avg_total)), cell(r.n)]), `analytics-${field}`));
    }
    const gross = data.gross_errors ?? {};
    body.append(h("h2", { text: `Грубые ошибки: ${gross.count ?? 0}`, data: { test: "analytics-gross" } }),
      table("Виды грубых ошибок", ["Вид", "Количество"], (gross.by_kind ?? []).map((r) => [cell(r.kind), cell(r.count)])),
      h("ul", { class: "cqa-report-links" }, (gross.conversations ?? []).map((id) => h("li", {}, link(id)))));
  }
  async function load() {
    const mine = ++run;
    refresh.disabled = true;
    body.removeAttribute("data-test");
    clear(body).append(h("p", { text: "Загрузка отчёта…", data: { test: "reports-loading" } }));
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
        h("p", { text: `Не удалось загрузить отчёт. ${errorText(error)}` }),
        h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: "Повторить", data: { test: "reports-retry" }, on: { click: () => load() } })));
    } finally {
      if (!destroyed && mine === run) refresh.disabled = false;
    }
  }
  const stop = watch(store, (s) => s.queueRefresh, () => load());
  load();
  return { el, destroy() { destroyed = true; run++; stop(); } };
}
