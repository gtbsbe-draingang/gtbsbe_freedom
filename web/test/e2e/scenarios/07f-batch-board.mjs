// The batch board: «Оценить выбранные» shows the batch's dialogues as cards in the middle pane,
// shimmering until each is evaluated, then with its total; a card opens the dialogue. The selection
// bar hides once the batch starts; the arrow left of an open dialogue's title (with a «2/3» counter
// while the batch runs) leads back; «Выбрать снова» ticks the batch's dialogues again.
import assert from "node:assert/strict";

export const name = "batch-board";
export const path = "/#/";
export const viewports = [
  [1400, 900],
  [600, 800],
];

const sel = (test) => `[data-test="${test}"]`;
const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
const picked = ["DEV:p1-ru-002", "DEV:p1-kz-004", "DEV:p4-ru-001"];
const card = (id) => `${sel("board-card")}[data-id="${id}"]`;
const states = `[...document.querySelectorAll(${JSON.stringify(sel("board-card"))})].map((c) => c.getAttribute("data-state"))`;
const hold = `(() => { const api = window.__cqaTest.api; window.__realStart ??= api.startEvaluations; api.startEvaluations = async (p) => { if (!p.dry_run) await new Promise((r) => { window.__release = r; }); return window.__realStart(p); }; })()`;
const unhold = `window.__cqaTest.api.startEvaluations = window.__realStart`;

async function until(page, expression, what, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!(await page.eval(expression))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await page.sleep(25);
  }
}

async function openQueue(page) {
  if (page.viewport[0] >= 900 || (await page.eval("window.__cqaTest.store.get().queueOpen"))) return;
  await page.click(sel("queue-toggle"));
  await until(page, "window.__cqaTest.store.get().queueOpen", "the queue drawer");
  const at = () => page.eval(`${q(sel("queue-pane"))}.getBoundingClientRect().left`);
  for (let before = null, now = await at(); now !== before; await page.sleep(60)) [before, now] = [now, await at()];
}

const runReady = (page) => until(page, `${q(sel("batch-run"))} && !${q(sel("batch-run"))}.disabled`, "an enabled «Оценить выбранные»");

export async function run(page) {
  const narrow = page.viewport[0] < 900;
  const tabs = page.viewport[0] < 700;
  await page.waitFor(sel("queue-item"), 10000);

  // ---- before any batch: the old prompt, plus where results will appear ----
  await page.waitFor(sel("board-empty"));
  assert.match(await page.text(sel("board-empty")), /Выберите диалог в очереди/);
  // no dialogue: no empty «Оценка диалога» column; the board has its width (and no tabs when narrow)
  assert.equal(await page.eval(`getComputedStyle(${q(sel("scorecard-pane"))}).display`), "none");
  assert.equal(await page.eval(`${q(sel("transcript-pane"))}.getBoundingClientRect().right >= ${q(".cqa-ws-grid")}.getBoundingClientRect().right - 1`), true, "the board reaches the right edge");
  if (tabs) assert.equal(await page.eval(`getComputedStyle(${q(".cqa-tabs")}).display`), "none");
  assert.match(await page.text(sel("board-empty")), /Оценить выбранные/);
  // no batch yet: an open dialogue has no arrow back
  await page.eval(`location.hash = "#/c/DEV%3Ap1-ru-001"`);
  await page.waitFor(sel("transcript-title"));
  assert.equal(await page.eval(`${q(sel("board-back"))}.hidden && ${q(sel("board-back-bar"))}.hidden`), true, "no arrow back without a batch");
  await page.eval(`location.hash = "#/"`);
  await page.waitFor(sel("board-empty"));

  // ---- run a batch: the board shows a shimmering card per dialogue at once ----
  await openQueue(page);
  for (const id of picked) await page.eval(`${q(`${sel("queue-item")}[data-id="${id}"] ${sel("queue-select")}`)}.click()`);
  await runReady(page);
  await page.eval(hold);
  await page.click(sel("batch-run"));
  await until(page, `document.querySelectorAll(${JSON.stringify(sel("board-card"))}).length === 3`, "three cards");
  assert.equal(await page.count(sel("batch-bar")), 0, "the bar hides: the board takes over");
  assert.equal(await page.count(`${sel("queue-select")}:checked`), 0, "the ticks are cleared");
  assert.equal(await page.count(sel("board-reselect")), 0, "nothing to select again while the batch runs");
  if (narrow) assert.equal(await page.eval("window.__cqaTest.store.get().queueOpen"), false, "the drawer closes so the board shows");
  assert.deepEqual(await page.eval(`[...document.querySelectorAll(${JSON.stringify(sel("board-card"))})].map((c) => c.getAttribute("data-id"))`), picked);
  assert.deepEqual(await page.eval(states), ["queued", "queued", "queued"]);
  assert.equal(await page.eval(`${q(card(picked[0]))}.classList.contains("is-busy") && ${q(card(picked[0]))}.getAttribute("aria-busy") === "true"`), true);
  assert.equal(await page.count(`${card(picked[0])} .cqa-sc-shimmer`), 1, "a shimmer holds the total's place");
  assert.match(await page.text(card(picked[2])), /p4-ru-001RU · звонок/);
  assert.match(await page.text(sel("board-progress")), /Оценено 0 из 3/);

  // ---- the run ends: each card shows its evaluation's total and gross-error flag ----
  await page.eval("window.__release()");
  await page.eval(unhold);
  await until(page, `${states}.every((s) => s === "done")`, "every card done", 15000);
  assert.match(await page.text(sel("board-progress")), /Готово: оценено 3 из 3/);
  const expected = await page.eval(`(async () => {
    const items = window.__cqaTest.store.get().lastBatch.items;
    const out = [];
    for (const id of ${JSON.stringify(picked)}) {
      const ev = await window.__cqaTest.api.getEvaluation(items[id].evaluation_id);
      out.push([ev.final_total === null ? "не рассчитывается" : ev.final_total.toFixed(2).replace(".", ","), ev.gross_error?.flag === true]);
    }
    return out;
  })()`);
  const shown = await page.eval(`${JSON.stringify(picked)}.map((id) => [document.querySelector('${sel("board-card")}[data-id="' + id + '"] ${sel("board-total")}').textContent, !!document.querySelector('${sel("board-card")}[data-id="' + id + '"] ${sel("board-gross")}')])`);
  assert.deepEqual(shown, expected, "totals and gross-error tags match the server's evaluations");
  assert.equal(await page.eval("document.documentElement.scrollWidth <= innerWidth"), true);

  // ---- a card opens the dialogue; the arrow left of its title comes back to the board ----
  const back = tabs ? sel("board-back-bar") : sel("board-back");
  await page.click(card(picked[1]));
  await until(page, `decodeURIComponent(location.hash) === "#/c/${picked[1]}"`, "the dialogue route");
  if (!tabs) await until(page, `getComputedStyle(${q(sel("scorecard-pane"))}).display !== "none"`, "the scorecard column to come back with a dialogue");
  await until(page, `${q(back)} && ${q(back)}.getClientRects().length > 0`, "the arrow back");
  assert.equal(await page.eval(`${q(back)}.getAttribute("aria-label")`), "К результатам");
  assert.equal(await page.eval(`${q(`${back} ${sel("board-back-count")}`)}.hidden`), true, "no counter once the batch is over");
  assert.equal(await page.eval(`${q(sel("board-back"))}.getClientRects().length > 0`), !tabs, "the arrow is left of the title from 700 px");
  assert.equal(await page.eval(`${q(sel("board-back-bar"))}.getClientRects().length > 0`), tabs, "and in the tab strip below");
  if (tabs) {
    // reachable from the scorecard tab too
    await page.click(sel("tab-scorecard"));
    assert.equal(await page.eval(`${q(back)}.getClientRects().length > 0`), true, "the arrow stays on the scorecard tab");
  }
  await page.click(back);
  await until(page, `location.hash === "#/" && ${states}.length === 3`, "the board again");
  assert.equal(await page.count(sel("transcript")), 0, "the dialogue is closed");
  if (!tabs) assert.equal(await page.eval(`getComputedStyle(${q(sel("scorecard-pane"))}).display`), "none", "and so is the scorecard column");
  assert.deepEqual(await page.eval(states), ["done", "done", "done"], "the board still has the results");

  // ---- «Выбрать снова»: the batch's dialogues are ticked again and the bar is back ----
  await page.click(sel("board-reselect"));
  await page.waitFor(sel("batch-bar"));
  assert.deepEqual(await page.eval("[...window.__cqaTest.store.get().selection]"), picked, "the same dialogues, in the same order");
  if (narrow) assert.equal(await page.eval("window.__cqaTest.store.get().queueOpen"), true, "the drawer opens on the bar");
  await page.eval("window.__cqaTest.store.set({ selection: new Set(), queueOpen: false })");

  // ---- a new tick resets the bar's job, not the board ----
  await openQueue(page);
  await page.eval(`window.__cqaTest.store.set({ selection: new Set(${JSON.stringify(picked)}) })`);
  await page.eval(`${q(`${sel("queue-item")}[data-id="DEV:p1-en-003"] ${sel("queue-select")}`)}.click()`);
  assert.deepEqual(await page.eval(states), ["done", "done", "done"]);

  // ---- a failed dialogue says so, and the language switch reaches the board ----
  await page.eval(`(() => { const api = window.__cqaTest.api; const real = api.getJob; window.__realGetJob = real; api.getJob = async (id) => { const job = await real(id); return { ...job, failed: 1, done: job.done - 1, items: job.items.map((it) => it.conversation === "DEV:p1-en-003" ? { ...it, status: "failed", error: "timeout", evaluation_id: null } : it) }; }; })()`);
  await runReady(page);
  await page.click(sel("batch-run"));
  await until(page, `${states}.length === 4 && ${states}.every((s) => s === "done" || s === "failed")`, "the second batch to settle", 15000);
  assert.equal(await page.eval(`${q(card("DEV:p1-en-003"))}.getAttribute("data-state")`), "failed");
  assert.match(await page.text(card("DEV:p1-en-003")), /Не удалось оценить/);
  assert.match(await page.text(card("DEV:p1-en-003")), /timeout/);
  assert.match(await page.text(sel("board-progress")), /не удалось: 1/);
  assert.equal(await page.count(sel("batch-retry")), 1, "the board offers «Повторить неудачные»");
  await page.eval(`window.__cqaTest.api.getJob = window.__realGetJob`);
  await page.eval(`(() => { const s = ${q(sel("ui-language"))}; s.value = "en"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  assert.match(await page.text(sel("batch-board")), /Batch evaluation results/);
  assert.match(await page.text(card("DEV:p1-en-003")), /Evaluation failed/);
  await page.eval(`(() => { const s = ${q(sel("ui-language"))}; s.value = "ru"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);

  // ---- with a dialogue open, the dialogue stays; the arrow back counts the new batch, then leads to it ----
  await page.eval(`location.hash = "#/c/DEV%3Ap1-ru-001"`);
  await until(page, `${q(sel("transcript-pane"))}?.textContent.includes("p1-ru-001")`, "the dialogue");
  await openQueue(page);
  await page.eval(`window.__cqaTest.store.set({ selection: new Set(${JSON.stringify(picked)}) })`);
  await runReady(page);
  await page.eval(hold);
  await page.click(sel("batch-run"));
  assert.equal(await page.count(sel("batch-bar")), 0, "the bar hides with a dialogue open too");
  assert.equal(decodeURIComponent(await page.eval("location.hash")), "#/c/DEV:p1-ru-001", "the open dialogue stays");
  await until(page, `${q(`${back} ${sel("board-back-count")}`)}?.hidden === false`, "the counter on the arrow");
  assert.equal(await page.text(`${back} ${sel("board-back-count")}`), "0/3");
  assert.equal(await page.eval(`${q(back)}.getAttribute("aria-label")`), "К результатам: оценено 0 из 3");
  await page.eval("window.__release()");
  await page.eval(unhold);
  await until(page, `${q(`${back} ${sel("board-back-count")}`)}.hidden`, "the counter to go when the batch ends", 15000);
  await page.eval("window.__cqaTest.store.set({ queueOpen: false })");
  await page.click(back);
  await until(page, `location.hash === "#/" && ${states}.length === 3`, "the board of the new batch");
  await until(page, `${states}.every((s) => s === "done")`, "the new batch done", 15000);

  // ---- many dialogues: the cards scroll inside the board, under its head, within the screen ----
  await openQueue(page);
  await page.eval(`(() => { const ids = [...document.querySelectorAll('${sel("queue-item")}')].map((r) => r.getAttribute("data-id")).filter((id) => /:p1-/.test(id)).slice(0, 22); window.__cqaTest.store.set({ selection: new Set(ids) }); })()`);
  await runReady(page);
  await page.click(sel("batch-run"));
  await until(page, `document.querySelectorAll(${JSON.stringify(sel("board-total"))}).length === 22`, "22 evaluated cards", 20000);
  if (narrow) await page.eval("window.__cqaTest.store.set({ queueOpen: false })");
  const scroll = q(sel("board-scroll"));
  assert.equal(await page.eval(`${q(".cqa-bb-body")}.getBoundingClientRect().bottom <= innerHeight`), true, "the board ends on screen");
  assert.equal(await page.eval("document.documentElement.scrollHeight <= innerHeight + 1"), true, "the page itself does not scroll");
  assert.equal(await page.eval("document.documentElement.scrollWidth <= innerWidth"), true);
  if (tabs) assert.equal(await page.eval(`${scroll}.scrollHeight > ${scroll}.clientHeight`), true, "22 cards overflow at 600 px");
  const headTop = await page.eval(`${q(".cqa-bb-head")}.getBoundingClientRect().top`);
  await page.eval(`${scroll}.scrollTop = ${scroll}.scrollHeight`);
  assert.equal(await page.eval(`${q(".cqa-bb-head")}.getBoundingClientRect().top`), headTop, "the head stays while the cards scroll");
  assert.equal(await page.eval(`(() => { const last = [...document.querySelectorAll('${sel("board-card")}')].at(-1).getBoundingClientRect(); return last.bottom <= ${scroll}.getBoundingClientRect().bottom; })()`), true, "the last card can be scrolled into the box");
}
