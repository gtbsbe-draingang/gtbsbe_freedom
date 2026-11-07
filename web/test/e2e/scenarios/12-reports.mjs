import assert from "node:assert/strict";
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
  await page.eval(`location.hash='#/accuracy'`);
  await page.waitFor(s("accuracy-reference"));
  assert.match(await page.text(s("accuracy-reference")), /Демо: эталон не загружен/);
  assert.match(await page.text(s("accuracy-overall")), /%.*n = \d+/);
  assert.ok(await page.count(s("accuracy-criterion")) > 0);
  assert.ok(await page.count(s("disagreement")) > 0);
  const target = await page.eval(`document.querySelector('${s("disagreement")} a').getAttribute('href')`);
  assert.match(target, /^#\/c\//);
  await page.eval(`window.__cqaTest.api.getAccuracy=async()=>{throw new Error('report unavailable')};window.__cqaTest.store.set({queueRefresh:2})`);
  await page.waitFor(s("reports-error"));
  await page.eval(`window.__cqaTest.api.getAccuracy=async()=>({reference_note:'No labels',model:'test',overall:{agreement:null,n:0},by_criterion:[],by_language:[],by_channel:[],missing:4,disputed_excluded:2,disagreements:[]})`);
  await page.click(s("reports-retry"));
  await page.waitFor(s("reports-ready"));
  assert.match(await page.text(s("accuracy-overall")), /—/);
  assert.match(await page.text(s("accuracy-counts")), /нет оценки: 4.*спорные исключены: 2/);
}
