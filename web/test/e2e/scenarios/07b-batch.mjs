// The batch bar's guards (review of #64): one click starts one job even while the start request
// is pending (also for «Повторить неудачные»); a failed progress poll resumes the same job instead
// of starting another; and the open scorecard follows the checklist picked in the batch bar.
// The mock API is wrapped in the page to delay, count or fail calls; no dialogue text is printed.
import assert from "node:assert/strict";

export const name = "batch";
export const path = "/#/";
export const viewports = [
  [1400, 900],
  [600, 800],
];

const sel = (test) => `[data-test="${test}"]`;
const quote = (value) => JSON.stringify(value);

async function until(page, expression, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!(await page.eval(expression))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await page.sleep(25);
  }
}

const visible = (page, selector) => page.eval(`(() => { const el = document.querySelector(${quote(selector)}); return Boolean(el) && el.getClientRects().length > 0; })()`);
async function showQueue(page) {
  if (!(await visible(page, sel("queue-pane")))) await page.click(sel("queue-toggle"));
  await until(page, `document.querySelector(${quote(sel("queue-pane"))}).getBoundingClientRect().width > 0`, "the queue");
}

const selectedText = (page, test) => page.eval(`document.querySelector(${quote(sel(test))})?.selectedOptions[0]?.textContent ?? ""`);
async function pick(page, test, needle) {
  await page.eval(`(() => {
    const s = document.querySelector(${quote(sel(test))});
    const i = [...s.options].findIndex((o) => o.textContent.includes(${quote(needle)}));
    if (i < 0) throw new Error("no option with " + ${quote(needle)});
    s.selectedIndex = i;
    s.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
}
const estimateReady = (page) => until(page, `/из кэша$/.test(document.querySelector(${quote(sel("batch-estimate"))})?.textContent ?? "") && !document.querySelector(${quote(sel("batch-run"))}).disabled`, "the estimate and an enabled run button");
const batchDone = (page) => until(page, `/^Готово/.test(document.querySelector(${quote(sel("batch-progress"))})?.textContent ?? "")`, "the batch to finish", 15000);

export async function run(page) {
  await page.waitFor(sel("queue-item"), 10000);
  const setup = await page.eval(`(async () => {
    const api = window.__cqaTest.api;
    const { checklist_id, version } = (await api.getConfig()).default_checklist;
    const copy = await api.createChecklist({ based_on: { checklist_id, version }, name: "Копия для проверки" });
    const ids = (await api.listConversations({ group_id: "DEV" })).filter((c) => c.channel === "agent chat").slice(0, 2).map((c) => c.id);
    return { ids, copy: copy.name };
  })()`);

  // ---- the open scorecard follows the batch bar's checklist (P2) ----
  await page.eval(`location.hash = "#/c/" + encodeURIComponent(${quote(setup.ids[0])})`);
  await until(page, `document.querySelector(${quote(sel("checklist-select"))})?.options.length > 1 && document.querySelector(${quote(sel("scorecard-loading"))}) === null`, "the scorecard with both checklists");
  const official = await selectedText(page, "checklist-select");
  assert.ok(!official.includes(setup.copy), "the scorecard starts on the official checklist");
  await page.eval(`window.__cqaTest.store.set({ selection: new Set(${quote(setup.ids)}) })`);
  await page.waitFor(sel("batch-bar"));
  await until(page, `document.querySelector(${quote(sel("batch-checklist"))})?.options.length > 1`, "the batch picker");
  await pick(page, "batch-checklist", setup.copy);
  await until(page, `(document.querySelector(${quote(sel("checklist-select"))})?.selectedOptions[0]?.textContent ?? "").includes(${quote(setup.copy)})`, "the scorecard picker to follow the batch picker");
  await until(page, `document.querySelector(${quote(sel("scorecard-empty"))}) !== null`, "the scorecard to load the copy (not evaluated yet)");
  await estimateReady(page);
  await page.eval(`document.querySelector(${quote(sel("batch-run"))}).click()`);
  await batchDone(page);
  await until(page, `document.querySelector(${quote(sel("total"))}) !== null && document.querySelector(${quote(sel("hero"))}).textContent.includes(${quote(setup.copy)})`, "the refreshed scorecard on the copy");
  await pick(page, "checklist-select", official.replace(/ · v\d+$/, ""));
  await until(page, `(document.querySelector(${quote(sel("batch-checklist"))})?.selectedOptions[0]?.textContent ?? "") === ${quote(official)}`, "the batch picker to follow the scorecard picker");

  // ---- one click, one job: the start request is pending (P1) ----
  await showQueue(page);
  await page.eval(`(() => {
    const api = window.__cqaTest.api;
    const real = window.__realStart ??= api.startEvaluations;
    window.__starts = 0;
    api.startEvaluations = (args) => (args && args.dry_run ? real(args) : (window.__starts += 1, new Promise((r) => setTimeout(r, 600)).then(() => real(args))));
  })()`);
  await estimateReady(page);
  await page.eval(`window.__runButton = document.querySelector(${quote(sel("batch-run"))})`);
  await page.click(sel("batch-run"));
  assert.equal(await page.eval(`document.querySelector(${quote(sel("batch-run"))}).disabled`), true, "the run button is disabled at once");
  assert.equal(await page.eval(`document.querySelector(${quote(sel("batch-checklist"))}).disabled`), true, "and so is the checklist picker");
  await page.eval(`(() => { const b = window.__runButton; b.disabled = false; b.click(); })()`); // a stale enabled button: the handler must refuse too
  await batchDone(page);
  assert.equal(await page.eval(`window.__starts`), 1, "exactly one evaluation was started");

  // ---- a failed poll resumes the same job (P1) ----
  await page.eval(`(() => {
    const api = window.__cqaTest.api;
    const realGet = window.__realGet ??= api.getJob;
    window.__starts = 0; window.__polls = []; window.__jobId = null;
    let failed = false;
    api.startEvaluations = (args) => (args && args.dry_run ? window.__realStart(args) : (window.__starts += 1, window.__realStart(args).then((job) => (window.__jobId = job.id, job))));
    api.getJob = (id) => {
      window.__polls.push(id);
      if (!failed) { failed = true; return Promise.reject(Object.assign(new Error("offline"), { code: "network", retryable: true })); }
      return realGet(id);
    };
  })()`);
  const refreshBefore = await page.eval(`window.__cqaTest.store.get().queueRefresh ?? 0`);
  await estimateReady(page);
  await page.click(sel("batch-run"));
  await page.waitFor(`${sel("toast")}[data-kind="error"] ${sel("toast-retry")}`, 5000);
  assert.equal(await page.eval(`document.querySelector(${quote(sel("batch-run"))}).disabled`), true, "no second submission while the job's progress is unknown");
  assert.equal(await page.count(sel("batch-resume")), 1, "the bar offers to resume watching the job");
  await page.click(`${sel("toast")}[data-kind="error"] ${sel("toast-retry")}`);
  await batchDone(page);
  assert.equal(await page.eval(`window.__starts`), 1, "recovery did not start another evaluation");
  assert.equal(await page.eval(`window.__polls.every((id) => id === window.__jobId)`), true, "recovery polled the original job");
  assert.ok((await page.eval(`window.__cqaTest.store.get().queueRefresh ?? 0`)) > refreshBefore, "completion refreshed the queue and scorecard");

  // ---- «Повторить неудачные»: one click, one retry (P1) ----
  await page.eval(`(() => {
    const api = window.__cqaTest.api;
    api.getJob = window.__realGet;
    window.__retries = 0;
    api.startEvaluations = (args) => (args && args.dry_run ? window.__realStart(args) : Promise.resolve({ id: "job-synthetic", status: "done", mode: "reuse", total: 2, done: 1, failed: 1, items: [] }));
    api.retryJob = (id) => (window.__retries += 1, new Promise((r) => setTimeout(r, 600)).then(() => ({ id, status: "done", mode: "reuse", total: 2, done: 2, failed: 0, items: [] })));
  })()`);
  await estimateReady(page);
  await page.click(sel("batch-run"));
  await page.waitFor(sel("batch-retry"), 5000);
  await page.eval(`window.__retryButton = document.querySelector(${quote(sel("batch-retry"))})`);
  await page.click(sel("batch-retry"));
  assert.equal(await page.eval(`document.querySelector(${quote(sel("batch-run"))}).disabled`), true, "nothing else starts while the retry request is pending");
  await page.eval(`window.__retryButton.click()`); // the old button, clicked again before the repaint
  await until(page, `/^Готово: оценено 2 из 2/.test(document.querySelector(${quote(sel("batch-progress"))})?.textContent ?? "")`, "the retry to finish");
  assert.equal(await page.eval(`window.__retries`), 1, "exactly one retry was requested");
}
