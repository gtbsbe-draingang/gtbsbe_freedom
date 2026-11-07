// The apply dialog's guards (same review points as the batch bar in #64): one click on «Запустить»
// starts one job even while the start request is pending, a failed progress poll resumes the same
// job instead of starting another, and the dialog closed and opened again while its job runs shows
// that job and cannot start another. The mock API is wrapped in the page; no dialogue text.
import assert from "node:assert/strict";

export const name = "apply";
export const path = "/#/checklists";
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

async function openOnSelection(page) {
  await page.click(sel("open-apply"));
  await page.waitFor(sel("apply-dialog"));
  await page.waitFor(sel("apply-target-selected"));
  await page.click(sel("apply-target-selected"));
  await until(page, `/из кэша$/.test(document.querySelector(${quote(sel("apply-estimate"))})?.textContent ?? "") && !document.querySelector(${quote(sel("apply-run"))}).disabled`, "the estimate and an enabled run button");
}

async function closeDialog(page) {
  await page.click(sel("apply-close"));
  await until(page, `document.querySelector(${quote(sel("apply-dialog"))}) === null`, "the dialog to close");
}

export async function run(page) {
  await page.waitFor(sel("checklist-row"), 10000);
  const setup = await page.eval(`(async () => {
    const api = window.__cqaTest.api;
    await api.importDataset("DEV");
    const { checklist_id, version } = (await api.getConfig()).default_checklist;
    const copy = await api.createChecklist({ based_on: { checklist_id, version }, name: "Копия для применения" });
    const ids = (await api.listConversations({ group_id: "DEV" })).filter((c) => c.channel === "agent chat").slice(0, 2).map((c) => c.id);
    window.__cqaTest.store.set({ selection: new Set(ids) });
    window.__realStart = api.startEvaluations;
    window.__realGet = api.getJob;
    return { id: copy.checklist_id, version: copy.version };
  })()`);
  await page.eval(`location.hash = ${quote(`#/checklists/${encodeURIComponent(setup.id)}/${setup.version}/edit`)}`);
  await page.waitFor(sel("open-apply"), 5000);

  // ---- one click, one job while the start request is pending ----
  await openOnSelection(page);
  await page.eval(`(() => {
    const api = window.__cqaTest.api;
    window.__starts = 0;
    api.startEvaluations = (args) => (args && args.dry_run ? window.__realStart(args) : (window.__starts += 1, new Promise((r) => setTimeout(r, 600)).then(() => window.__realStart(args))));
    window.__runButton = document.querySelector(${quote(sel("apply-run"))});
  })()`);
  await page.click(sel("apply-run"));
  assert.equal(await page.eval(`document.querySelector(${quote(sel("apply-run"))}).disabled`), true, "«Запустить» is disabled at once");
  assert.equal(await page.eval(`document.querySelector(${quote(sel("apply-target-dev"))}).disabled`), true, "and the targets cannot change");
  await page.eval(`(() => { const b = window.__runButton; b.disabled = false; b.click(); })()`); // a stale enabled button: the handler must refuse too
  await page.waitFor(sel("apply-compare"), 15000);
  assert.equal(await page.eval(`window.__starts`), 1, "exactly one evaluation was started");
  await closeDialog(page);

  // ---- a failed poll resumes the same job ----
  await openOnSelection(page);
  await page.eval(`(() => {
    const api = window.__cqaTest.api;
    window.__starts = 0; window.__polls = []; window.__jobId = null;
    let failed = false;
    api.startEvaluations = (args) => (args && args.dry_run ? window.__realStart(args) : (window.__starts += 1, window.__realStart(args).then((job) => (window.__jobId = job.id, job))));
    api.getJob = (id) => {
      window.__polls.push(id);
      if (!failed) { failed = true; return Promise.reject(Object.assign(new Error("offline"), { code: "network", retryable: true })); }
      return window.__realGet(id);
    };
  })()`);
  await page.click(sel("apply-run"));
  await page.waitFor(`${sel("toast")}[data-kind="error"] ${sel("toast-retry")}`, 5000);
  assert.equal(await page.eval(`document.querySelector(${quote(sel("apply-run"))}).disabled`), true, "no second submission while the job's progress is unknown");
  assert.equal(await page.count(sel("apply-resume")), 1, "the dialog offers to resume watching the job");
  await page.click(`${sel("toast")}[data-kind="error"] ${sel("toast-retry")}`);
  await page.waitFor(sel("apply-compare"), 15000);
  assert.equal(await page.eval(`window.__starts`), 1, "recovery did not start another evaluation");
  assert.equal(await page.eval(`window.__polls.every((id) => id === window.__jobId)`), true, "recovery polled the original job");
  await closeDialog(page);

  // ---- closed and opened again while the job runs: the same job, no second start ----
  // A synthetic job that stays at 1 of 2 until the test releases it.
  await openOnSelection(page);
  await page.eval(`(() => {
    const api = window.__cqaTest.api;
    window.__starts = 0; window.__release = false;
    const held = { id: "job-held", status: "running", mode: "reuse", total: 2, done: 1, failed: 0, items: [] };
    api.startEvaluations = (args) => (args && args.dry_run ? window.__realStart(args) : (window.__starts += 1, Promise.resolve(held)));
    api.getJob = (id) => Promise.resolve(window.__release ? { ...held, id, status: "done", done: 2 } : { ...held, id });
  })()`);
  await page.click(sel("apply-run"));
  await until(page, `/1 из 2/.test(document.querySelector(${quote(sel("apply-progress"))})?.textContent ?? "")`, "the held job at 1 of 2");
  await closeDialog(page);
  await page.click(sel("open-apply"));
  await page.waitFor(sel("apply-target-selected"));
  await until(page, `/1 из 2/.test(document.querySelector(${quote(sel("apply-progress"))})?.textContent ?? "")`, "the reopened dialog to show the same job");
  assert.equal(await page.eval(`document.querySelector(${quote(sel("apply-run"))}).disabled`), true, "the reopened dialog cannot start another job");
  assert.equal(await page.eval(`document.querySelector(${quote(sel("apply-target-selected"))}).checked`), true, "it shows the job's target");
  assert.equal(await page.eval(`document.querySelector(${quote(sel("apply-target-dev"))}).disabled`), true, "and the targets cannot change");
  await page.eval(`(() => { const b = document.querySelector(${quote(sel("apply-run"))}); b.disabled = false; b.click(); })()`); // forced: the handler must refuse too
  await page.eval(`window.__release = true`);
  await page.waitFor(sel("apply-compare"), 15000);
  assert.equal(await page.eval(`window.__starts`), 1, "exactly one evaluation was started");
}
