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
  assert.equal(await page.count(s("analytics-language")), 0, "language and channel tables are gone: the group chart carries them");
  assert.ok(await page.count(s("analytics-hero")) === 1 && await page.count(s("analytics-gross")) === 1, "hero strip and gross-error card");
  assert.match(await page.text(s("analytics-gross")), /Нет данных/, "no gross errors says so instead of an empty card");
  await page.eval(`window.__cqaTest.api.getAnalytics=async()=>({by_criterion:[{criterion_id:"c01",title:"Контакт",fail_rate:0.2,na_rate:0,n:5}],by_language:[{language:"RU",avg_total:80,n:5}],by_channel:[{channel:"agent chat",avg_total:80,n:5}],gross_errors:{count:2,by_kind:[{kind:"rudeness",count:2}],conversations:["DEV:p1-ru-001","DEV:p1-ru-002"]}})`);
  await page.click(s("reports-refresh"));
  await page.waitFor(s("reports-ready"));
  assert.match(await page.text(s("analytics-gross")), /rudeness[\s\S]*Диалоги с грубыми ошибками \(2\)/);
  assert.equal(await page.count(`${s("analytics-gross")} details a`), 2, "conversation links sit in the drop-down");
  assert.match(await page.text(s("analytics-page")), /n=5/, "group rows show n");
  await page.eval(`window.__cqaTest.api.getAnalytics=async()=>{throw new Error('report unavailable')};window.__cqaTest.store.set({queueRefresh:2})`);
  await page.waitFor(s("reports-error"));
  await page.eval(`location.hash='#/accuracy'`);
  await page.waitFor('[data-test="notfound"]').catch(() => {});
  assert.doesNotMatch(await page.eval(`document.body.textContent`), /Точность оценки/, "there is no accuracy page any more");
}
