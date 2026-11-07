import assert from "node:assert/strict";
import { catalogs } from "../../../src/i18n/ru.js";
export const name = "reports";
export const path = "/#/analytics";
export const viewports = [[1400, 900], [600, 800]];
const s = (name) => `[data-test="${name}"]`;
export async function run(page) {
  await page.waitFor(s("reports-ready"));
  assert.equal(await page.count(s("analytics-criterion")), 0, "empty data has no fabricated rates");
  await page.waitFor(s("reports-empty"));
  await page.eval(`(async () => {
    const {api} = window.__cqaTest;
    await api.importDataset('DEV');
    const config = await api.getConfig();
    const rows = await api.listConversations({group_id:'DEV'});
    const job = await api.startEvaluations({conversations:rows.slice(0,5).map(r=>r.id), ...config.default_checklist});
    for (let n=0;n<100;n++) {
      const state=await api.getJob(job.id);
      if (state.status==='done') break;
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    window.__cqaTest.store.set({queueRefresh:1});
  })()`);
  await page.waitFor(s("analytics-criterion"));
  assert.equal(await page.count(s("analytics-criterion")), 7, "seven weighted criteria; gross errors have a separate section");
  assert.equal(await page.eval(`document.documentElement.scrollWidth <= innerWidth`), true, "no page overflow");
  assert.equal(await page.eval(firstHeading("analytics-language")), "Язык", "language rows are headed by language, not group");
  await page.eval(`location.hash='#/accuracy'`);
  await page.waitFor(s("accuracy-reference"));
  assert.equal(await page.text(s("accuracy-reference")), catalogs.ru["reports.referenceDemo"]);
  assert.match(await page.text(s("accuracy-overall")), /Общее совпадение[\s\S]*%[\s\S]*сравнено ответов: \d+/);
  assert.match(await page.text(s("accuracy-checklist")), /v\d+/, "the mock names the checklist version it measured");
  assert.ok(await page.count(s("accuracy-criterion")) > 0);
  assert.ok(await page.count(s("disagreement")) > 0);
  const target = await page.eval(`document.querySelector('${s("disagreement")} a').getAttribute('href')`);
  assert.match(target, /^#\/c\//);
  await page.eval(`window.__cqaTest.api.getAccuracy=async()=>{throw new Error('report unavailable')};window.__cqaTest.store.set({queueRefresh:2})`);
  await page.waitFor(s("reports-error"));
  await page.eval(`window.__cqaTest.api.getAccuracy=async()=>({reference_note:'No labels',model:'test',overall:{agreement:null,n:0},by_criterion:[],by_language:[],by_channel:[],missing:4,disputed_excluded:2,disagreements:[]})`);
  await page.click(s("reports-retry"));
  await page.waitFor(s("reports-ready"));
  assert.equal(await page.text(s("reports-empty")), catalogs.ru["reports.noComparableRun"]);
  assert.match(await page.text(s("accuracy-counts")), /без ответа модели: 4.*спорные исключены: 2/);
  assert.doesNotMatch(await page.text(s("accuracy-page")), /null|undefined/, "absent parts leave no stray text");

  // The shapes the backend's /api/reports/accuracy sends (backend/quality/accuracy.py).
  const checklist = { checklist_id: "official-chat", version: 2, name: "Чек-лист качества чатов" };
  const full = {
    reference_note: catalogs.ru["reports.referenceDraft"], model: "claude-haiku-5-5", checklist,
    overall: { agreement: 0.8066, n: 517 },
    by_criterion: [{ criterion_id: "c01", title: "Установление контакта", agreement: 0.9385, n: 65 }, { criterion_id: "c02", title: "Выявление потребности", agreement: 0.7031, n: 64 }],
    by_language: [{ language: "RU", agreement: 0.7957, n: 279 }],
    by_channel: [{ channel: "agent chat", agreement: 0.8218, n: 477 }, { channel: "voice call", agreement: 0.625, n: 40 }],
    missing: 0, disputed_excluded: 3,
    disagreements: [
      { conversation: "DEV:p1-en-002", conversation_id: "p1-en-002", criterion_id: "c02", reference: "na", evaluated: "no" },
      { conversation: "DEV:p1-en-007", conversation_id: "p1-en-007", criterion_id: "c01", reference: "yes", evaluated: "no" },
      { conversation: "DEV:p1-en-008", conversation_id: "p1-en-008", criterion_id: "c02", reference: "na", evaluated: "no" },
    ],
  };
  await serve(page, full);
  assert.match(await page.text(s("accuracy-overall")), /Общее совпадение[\s\S]*80,66 %[\s\S]*сравнено ответов: 517/);
  assert.equal(await page.text(s("accuracy-model")), "Модель: claude-haiku-5-5");
  assert.match(await page.text(s("accuracy-checklist")), /«Чек-лист качества чатов» v2/);
  assert.equal(await page.eval(firstHeading("accuracy-criterion")), "Критерий");
  assert.equal(await page.eval(firstHeading("accuracy-language")), "Язык");
  assert.equal(await page.eval(firstHeading("accuracy-channel")), "Канал");
  const numerals = await page.eval(`(() => { const row = document.querySelector('${s("accuracy-criterion")}'); const style = (el) => getComputedStyle(el).fontVariantNumeric; return [style(row.cells[0]), style(row.cells[2]), style(document.querySelector('${s("accuracy-overall")}'))]; })()`);
  assert.deepEqual(numerals, ["normal", "tabular-nums", "normal"], "tabular figures only on number cells (CoFo's tnum also widens spaces)");
  assert.equal(await page.eval(`document.querySelector('${s("disagreement")}').cells[1].textContent`), "Выявление потребности", "criteria by title, not id");
  await page.eval(`(() => { const select = document.querySelector('${s("disagreement-filter")}'); select.value = 'c01'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.equal(await page.eval(visibleDisagreements), 1);
  await page.eval(`(() => { const select = document.querySelector('${s("disagreement-filter")}'); select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.equal(await page.eval(visibleDisagreements), 3);
  await choose(page, "en");
  assert.equal(await page.text(s("accuracy-reference")), catalogs.en["reports.referenceDraft"], "the backend's fixed note follows the interface language");
  assert.match(await page.text(s("accuracy-overall")), /Overall agreement/);
  await choose(page, "ru");

  // No v2 evaluations yet: the backend sends n = 0 and every reference answer as missing.
  const empty = {
    ...full, model: "", overall: { agreement: null, n: 0 }, missing: 517, disagreements: [],
    by_criterion: full.by_criterion.map((r) => ({ ...r, agreement: null, n: 0 })),
    by_language: full.by_language.map((r) => ({ ...r, agreement: null, n: 0 })),
    by_channel: full.by_channel.map((r) => ({ ...r, agreement: null, n: 0 })),
  };
  await serve(page, empty);
  assert.match(await page.text(s("reports-empty")), /«Чек-лист качества чатов» v2[\s\S]*DEV/);
  assert.equal(await page.text(s("accuracy-model")), "Модель: —");
  assert.match(await page.text(s("accuracy-counts")), /без ответа модели: 517.*спорные исключены: 3/);
  assert.equal(await page.count(s("accuracy-overall")), 0, "no headline without compared answers");
  assert.equal(await page.count(s("accuracy-criterion")), 0, "no tables of dashes");
  assert.doesNotMatch(await page.text(s("accuracy-page")), /null|undefined/, "absent parts leave no stray text");

  // References not installed on the server: say so; retrying cannot help.
  await page.eval(`window.__cqaTest.api.getAccuracy=async()=>{throw Object.assign(new Error('Reference answers are not installed.'),{code:'reference_missing',status:404,retryable:false})}`);
  await page.click(s("reports-refresh"));
  await page.waitFor(s("accuracy-no-reference"));
  assert.equal(await page.text(s("accuracy-no-reference")), catalogs.ru["error.reference_missing"]);
  assert.equal(await page.count(s("reports-retry")), 0);
}

const firstHeading = (rowTest) => `document.querySelector('[data-test="${rowTest}"]').closest('table').querySelector('th').textContent`;
const visibleDisagreements = `[...document.querySelectorAll('[data-test="disagreement"]')].filter((row) => !row.hidden).length`;
async function choose(page, lang) {
  await page.eval(`(() => { const select = document.querySelector('[data-test="ui-language"]'); select.value = '${lang}'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
}
async function serve(page, report) {
  await page.eval(`window.__cqaTest.api.getAccuracy=async()=>(${JSON.stringify(report)})`);
  await page.click(s("reports-refresh"));
  await page.waitFor(s("reports-ready"));
}
