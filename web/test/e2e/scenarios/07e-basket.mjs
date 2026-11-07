// The basket: «Выбрано: N» in the batch bar lists the selected dialogues; each one can be taken out
// of the selection there, and the count, the queue's checkboxes and the estimate follow.
import assert from "node:assert/strict";

export const name = "basket";
export const path = "/#/";
export const viewports = [
  [1400, 900],
  [600, 800],
];

const sel = (test) => `[data-test="${test}"]`;
const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
const picked = ["DEV:p1-ru-002", "DEV:p1-kz-004", "DEV:p4-ru-001"];
const queueBox = (id) => `${sel("queue-item")}[data-id="${id}"] ${sel("queue-select")}`;
const basketItem = (id) => `${sel("batch-basket-item")}[data-id="${id}"]`;
const basketIds = `[...document.querySelectorAll(${JSON.stringify(sel("batch-basket-item"))})].map((li) => li.getAttribute("data-id"))`;
const isOpen = (page) => page.eval(`!${q(sel("batch-basket-panel"))}.hidden && ${q(sel("batch-basket"))}.getAttribute("aria-expanded") === "true"`);
const selection = (page) => page.eval("[...(window.__cqaTest.store.get().selection ?? [])]");
const key = (name) => `document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(name)}, bubbles: true }))`;

async function until(page, expression, what) {
  const deadline = Date.now() + 8000;
  while (!(await page.eval(expression))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await page.sleep(25);
  }
}

async function openQueue(page) {
  if (page.viewport[0] >= 900 || (await page.eval("window.__cqaTest.store.get().queueOpen"))) return;
  await page.click(sel("queue-toggle"));
  await until(page, "window.__cqaTest.store.get().queueOpen", "the queue drawer");
  // the drawer slides in; a click during the slide lands where the button was a moment ago
  const at = () => page.eval(`${q(sel("queue-pane"))}.getBoundingClientRect().left`);
  for (let before = null, now = await at(); now !== before; await page.sleep(60)) [before, now] = [now, await at()];
}

export async function run(page) {
  await page.waitFor(sel("queue-item"), 10000);
  await openQueue(page);
  for (const id of picked) await page.eval(`${q(queueBox(id))}.click()`);
  await until(page, `${q(sel("batch-bar"))} !== null`, "the batch bar");
  assert.equal(await page.text(".cqa-batch-count"), "Выбрано: 3");
  assert.equal(await isOpen(page), false, "the basket starts closed");

  // ---- the basket lists the selection in the order picked, above the bar ----
  await page.click(sel("batch-basket"));
  assert.equal(await isOpen(page), true);
  assert.deepEqual(await page.eval(basketIds), picked);
  assert.equal(await page.text(`${basketItem("DEV:p1-ru-002")} .cqa-basket-id`), "p1-ru-002");
  assert.equal(await page.text(`${basketItem("DEV:p1-ru-002")} .cqa-basket-meta`), "DEV · RU · чат");
  assert.equal(await page.text(`${basketItem("DEV:p4-ru-001")} .cqa-basket-meta`), "DEV · RU · звонок");
  assert.equal(await page.eval(`${q(sel("batch-basket-panel"))}.getBoundingClientRect().bottom <= ${q(sel("batch-bar"))}.getBoundingClientRect().top`), true, "the list opens above the bar");
  assert.equal(await page.eval("document.documentElement.scrollWidth <= innerWidth"), true, "the open basket does not widen the page");
  assert.equal(await page.eval(`${q(`${basketItem("DEV:p1-kz-004")} ${sel("batch-basket-remove")}`)}.getAttribute("aria-label")`), "Убрать p1-kz-004 из выбора");

  // ---- removing one: the count, the queue checkbox and the estimate follow; focus moves on ----
  await until(page, `${q(sel("batch-estimate"))}.textContent.startsWith("3 ")`, "the estimate for 3");
  await page.click(`${basketItem("DEV:p1-kz-004")} ${sel("batch-basket-remove")}`);
  assert.equal(await page.text(".cqa-batch-count"), "Выбрано: 2");
  assert.deepEqual(await page.eval(basketIds), ["DEV:p1-ru-002", "DEV:p4-ru-001"]);
  assert.deepEqual(await selection(page), ["DEV:p1-ru-002", "DEV:p4-ru-001"]);
  assert.equal(await page.eval(`${q(queueBox("DEV:p1-kz-004"))}.checked`), false, "the queue row is unticked");
  assert.equal(await page.eval(`${q(queueBox("DEV:p1-ru-002"))}.checked`), true);
  assert.equal(await isOpen(page), true, "the basket stays open");
  assert.equal(await page.eval(`document.activeElement === ${q(`${basketItem("DEV:p4-ru-001")} ${sel("batch-basket-remove")}`)}`), true, "focus moves to the row that took its place");
  await until(page, `${q(sel("batch-estimate"))}.textContent.startsWith("2 ")`, "the estimate for 2");
  // the last row removed by keyboard: focus goes back to the previous row
  await page.eval("document.activeElement.click()");
  assert.deepEqual(await selection(page), ["DEV:p1-ru-002"]);
  assert.equal(await page.eval(`document.activeElement === ${q(`${basketItem("DEV:p1-ru-002")} ${sel("batch-basket-remove")}`)}`), true);

  // ---- ticking in the queue adds to the open basket (a keyboard tick: no click outside) ----
  await page.eval(`${q(queueBox("DEV:p1-kz-004"))}.click()`);
  assert.equal(await isOpen(page), true);
  assert.deepEqual(await page.eval(basketIds), ["DEV:p1-ru-002", "DEV:p1-kz-004"]);
  assert.equal(await page.text(".cqa-batch-count"), "Выбрано: 2");

  // ---- Escape closes it and stays inside; a click elsewhere closes it too ----
  await page.eval(`${q(`${basketItem("DEV:p1-ru-002")} ${sel("batch-basket-remove")}`)}.focus()`);
  await page.eval(key("Escape"));
  assert.equal(await isOpen(page), false);
  assert.equal(await page.eval(`document.activeElement === ${q(sel("batch-basket"))}`), true, "focus returns to the button");
  if (page.viewport[0] < 900) assert.equal(await page.eval("window.__cqaTest.store.get().queueOpen"), true, "the Escape does not close the queue drawer");
  await page.click(sel("batch-basket"));
  await page.click(sel("queue-search"));
  assert.equal(await isOpen(page), false);
  // an empty part of the basket card or of the bar closes it as well
  await page.click(sel("batch-basket"));
  await page.click(`${sel("batch-basket-panel")} > .cqa-rv-label`);
  assert.equal(await isOpen(page), false, "a press on the basket's title closes it");
  await page.click(sel("batch-basket"));
  await page.click(sel("batch-estimate"));
  assert.equal(await isOpen(page), false, "a press on the bar's empty space closes it");
  assert.deepEqual(await selection(page), ["DEV:p1-ru-002", "DEV:p1-kz-004"], "closing keeps the selection");

  // ---- a row's link opens the dialogue ----
  await page.click(sel("batch-basket"));
  await page.click(`${basketItem("DEV:p1-kz-004")} .cqa-basket-link`);
  await until(page, `decodeURIComponent(location.hash) === "#/c/DEV:p1-kz-004"`, "the dialogue route");
  assert.equal(await isOpen(page), false, "opening a dialogue closes the basket");
  if (page.viewport[0] < 900) await until(page, "!window.__cqaTest.store.get().queueOpen", "the queue drawer to close with the route change");
  assert.deepEqual(await selection(page), ["DEV:p1-ru-002", "DEV:p1-kz-004"], "and keeps the selection");

  // ---- removing the last one empties the selection and the bar goes ----
  await openQueue(page);
  await page.click(sel("batch-basket"));
  await page.click(`${basketItem("DEV:p1-ru-002")} ${sel("batch-basket-remove")}`);
  await page.click(`${basketItem("DEV:p1-kz-004")} ${sel("batch-basket-remove")}`);
  assert.deepEqual(await selection(page), []);
  assert.equal(await page.count(sel("batch-bar")), 0, "no selection, no bar");
}
