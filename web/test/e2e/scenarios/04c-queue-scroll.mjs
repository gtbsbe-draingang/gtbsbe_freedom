// The queue keeps its place: ticking rows, "select all" and opening a conversation leave the list
// scrolled where it was and keep focus on the clicked checkbox; filters keep the rows' order.
import assert from "node:assert/strict";

export const name = "queue-scroll";
export const path = "/#/";
export const viewports = [
  [1400, 900],
  [600, 800],
];

const sel = (test) => `[data-test="${test}"]`;
// The element that scrolls the rows: the list's box on a wide screen, the drawer when narrow.
const scroller = `(() => { let el = document.querySelector('[data-test="queue-list"]'); while (el && !(el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement; return el; })()`;
const ids = `[...document.querySelectorAll('[data-test="queue-item"]')].map((row) => row.getAttribute("data-id"))`;

async function until(page, expression, what) {
  const deadline = Date.now() + 8000;
  while (!(await page.eval(expression))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await page.sleep(25);
  }
}

// The data-id of the n-th row whose checkbox sits well inside the scrolled box, clear of the
// batch bar that appears at its bottom after the first tick.
const rowInView = (page, n = 0) =>
  page.eval(`(() => { const box = ${scroller}.getBoundingClientRect(); return [...document.querySelectorAll('[data-test="queue-item"]')].filter((row) => { const r = row.querySelector('[data-test="queue-select"]').getBoundingClientRect(); return r.top > box.top + 20 && r.bottom < box.bottom - 320; })[${n}]?.getAttribute("data-id") ?? null; })()`);

export async function run(page) {
  const narrow = page.viewport[0] < 900;
  await page.waitFor(sel("queue-item"), 10000);
  if (narrow) {
    await page.click(sel("queue-toggle"));
    await until(page, "window.__cqaTest.store.get().queueOpen", "the queue drawer");
  }
  await until(page, `${scroller} !== null`, "a scrollable queue");
  const top = () => page.eval(`Math.round(${scroller}.scrollTop)`);
  const order = await page.eval(ids);
  await page.eval(`${scroller}.scrollTop = Math.round(${scroller}.scrollHeight / 2)`);
  await page.sleep(100);
  const where = await top();
  assert.ok(where > 300, `the queue scrolled down (${where})`);
  const first = await rowInView(page);
  const second = await rowInView(page, 1);
  assert.ok(first && second, "two rows in view");

  // ---- ticking rows keeps the place and the focus ----
  for (const [n, id] of [[1, first], [2, second]]) {
    const box = `${sel("queue-item")}[data-id="${id}"] ${sel("queue-select")}`;
    await page.click(box, { scroll: false });
    await until(page, `window.__cqaTest.store.get().selection?.size === ${n}`, `selection of ${n}`);
    assert.equal(await top(), where, `tick ${n} keeps the scroll`);
    assert.equal(await page.eval(`document.activeElement === document.querySelector(${JSON.stringify(box)})`), true, `tick ${n} keeps focus on its checkbox`);
    assert.equal(await page.eval(`document.querySelector(${JSON.stringify(box)}).checked`), true, `row ${n} is ticked`);
  }
  // a click on a focused checkbox (what Space does) unticks it in place
  await page.eval(`document.activeElement.click()`);
  await until(page, "window.__cqaTest.store.get().selection?.size === 1", "the untick");
  assert.equal(await top(), where);

  // ---- select all and back, from the controls above the list (scrolled away when narrow) ----
  await page.eval(`document.querySelector('${sel("queue-select-all")}').click()`);
  await until(page, `window.__cqaTest.store.get().selection?.size === document.querySelectorAll('[data-test="queue-item"]').length`, "all rows ticked");
  assert.equal(await top(), where, "select all keeps the scroll");
  await page.eval(`document.querySelector('${sel("queue-select-all")}').click()`);
  await until(page, "(window.__cqaTest.store.get().selection?.size ?? 0) === 0", "all rows unticked");
  assert.equal(await top(), where);

  // ---- opening a conversation leaves the list where it was ----
  await page.click(`${sel("queue-item")}[data-id="${first}"] .cqa-q-id`, { scroll: false });
  await until(page, `decodeURIComponent(location.hash) === ${JSON.stringify(`#/c/${first}`)}`, "the conversation route");
  if (narrow) {
    await until(page, "!window.__cqaTest.store.get().queueOpen", "the drawer to close");
    await page.click(sel("queue-toggle"));
    await until(page, "window.__cqaTest.store.get().queueOpen", "the drawer to reopen");
  }
  assert.equal(await top(), where, "the list is where it was");
  await until(page, `document.querySelector('${sel("queue-item")}[data-id="${first}"]').classList.contains("is-current")`, "the opened row to be marked current");
  assert.equal(await top(), where, "still where it was once the row is marked");

  // ---- filters and search put the same rows back in the same order ----
  await page.click(sel("queue-filter-calls"));
  const calls = await page.eval(ids);
  assert.ok(calls.length > 0 && calls.length < order.length, "the calls filter narrows the list");
  assert.deepEqual(calls, order.filter((id) => calls.includes(id)), "filtered rows keep their order");
  await page.click(sel("queue-filter-all"));
  assert.deepEqual(await page.eval(ids), order);
  await page.type(sel("queue-search"), "-00");
  await until(page, `${ids}.length < ${order.length}`, "the search to narrow the list");
  const found = await page.eval(ids);
  assert.deepEqual(found, order.filter((id) => found.includes(id)));
  await page.eval(`(() => { const s = document.querySelector('${sel("queue-search")}'); s.value = ""; s.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  assert.deepEqual(await page.eval(ids), order, "clearing the search restores every row in order");
}
