// The scorecard while an evaluation runs: the brand panel turns into a loading card (one moving
// bar per scored section, an elapsed clock), a re-run hides the old total and dims the cards, and
// a failed run brings the previous card back. The run is held open by wrapping the API's
// startEvaluations, so nothing depends on the mock's timing.
import assert from "node:assert/strict";

export const name = "eval-loading";
export const path = "/#/c/DEV%3Ap1-ru-001";
export const motion = true; // checks that the loading card moves
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

async function showScorecard(page) {
  await page.eval(`(() => { const tab = document.querySelector('[data-test="tab-scorecard"]'); if (tab && tab.offsetParent !== null) tab.click(); })()`);
}

const running = sel("hero-running");
const stale = `document.querySelector(".cqa-sc-body").classList.contains("is-stale")`;

export async function run(page) {
  await page.waitFor(sel("scorecard"), 10000);
  await until(page, `document.querySelector(${quote(sel("run-eval"))}) !== null && !document.querySelector(${quote(sel("run-eval"))}).disabled`, "the run button");
  await showScorecard(page);
  const sections = await page.eval(`window.__cqaTest.api.getConfig().then(async (c) => {
    const v = await window.__cqaTest.api.getChecklistVersion(c.default_checklist.checklist_id, c.default_checklist.version);
    return new Set(v.criteria.filter((x) => x.kind !== "gross_error").map((x) => x.section_id)).size;
  })`);

  // every start waits until the test releases (or fails) it
  await page.eval(`(() => {
    const api = window.__cqaTest.api;
    const real = api.startEvaluations;
    api.startEvaluations = async (payload) => {
      await new Promise((resolve, reject) => { window.__release = resolve; window.__fail = reject; });
      return real(payload);
    };
  })()`);

  // ---- a run: the loading card takes the brand panel's place ----
  await page.click(sel("run-eval"));
  await page.waitFor(running, 2000);
  assert.equal(await page.count(sel("total")), 0, "no total while the evaluator works");
  assert.equal(await page.count(sel("scorecard-empty")), 0, "the empty state gives way to the loading card");
  assert.equal(await page.eval(`document.querySelector(${quote(running)}).getAttribute("aria-busy")`), "true");
  assert.equal(await page.count(sel("running-section")), sections, "one moving bar per scored section");
  assert.notEqual(await page.eval(`getComputedStyle(document.querySelector('[data-test="running-section"] .cqa-sc-sec-bar i')).animationName`), "none", "the bars move");
  const clock = await page.text(sel("run-clock"));
  assert.match(clock, /^0:0\d$/, "the clock starts near zero");
  await until(page, `document.querySelector(${quote(sel("run-clock"))}).textContent !== ${quote(clock)}`, "the clock to tick", 2500);
  await page.eval(`window.__release()`);
  await page.waitFor(sel("total"), 10000);
  assert.equal(await page.count(running), 0, "the result replaces the loading card");
  assert.equal(await page.eval(stale), false);

  // ---- a re-run: the old total is hidden, the cards stay but are dimmed ----
  const cards = await page.count(sel("crit"));
  await page.click(sel("run-eval"));
  await page.waitFor(running, 2000);
  assert.equal(await page.count(sel("total")), 0, "the old total is not shown during a re-run");
  assert.equal(await page.count(sel("crit")), cards, "the criterion cards stay on screen");
  assert.equal(await page.eval(stale), true, "and are dimmed");
  assert.equal(await page.eval(`document.querySelector(".cqa-sc-body").getAttribute("aria-busy")`), "true");
  await page.eval(`window.__release()`);
  await page.waitFor(sel("total"), 10000);
  assert.equal(await page.count(running), 0);
  assert.equal(await page.eval(stale), false, "the cards are no longer dimmed");
  const total = await page.text(sel("total"));

  // ---- a failed run: the previous card comes back, with the error toast ----
  await page.click(sel("run-eval"));
  await page.waitFor(running, 2000);
  await page.eval(`window.__fail(Object.assign(new Error("offline"), { retryable: true }))`);
  await page.waitFor(`${sel("toast")}[data-kind="error"]`, 4000);
  await until(page, `document.querySelector(${quote(running)}) === null`, "the loading card to go", 2000);
  assert.equal(await page.text(sel("total")), total, "the previous total is back");
  assert.equal(await page.eval(stale), false);
  assert.equal(await page.eval(`document.querySelector(".cqa-sc-body").hasAttribute("aria-busy")`), false);
  assert.equal(await page.eval(`document.documentElement.scrollWidth <= innerWidth`), true, "no sideways scroll");
}
