// The Dynamics proof page: the UI in an iframe in a 600 px column under the strict CSP, opened on
// a conversation by the URL and by the form script's setClientApiContext().
import assert from "node:assert/strict";

export const name = "dynamics";
export const path = "/dynamics-mock.html";
export const viewports = [[1400, 900]];

const FRAME = `document.querySelector('[data-test="cqa-frame"]')`;
const inFrame = (expression) => `(() => { const frame = ${FRAME}; const win = frame.contentWindow; const doc = frame.contentDocument; return (${expression}); })()`;

async function waitFrame(page, expression, what, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) {
    let ok = false;
    try {
      ok = await page.eval(inFrame(expression));
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${ms} ms waiting for ${what} in the iframe`);
    await page.sleep(25);
  }
}

export async function run(page) {
  await page.waitFor('[data-test="cqa-frame"]');
  await waitFrame(page, `doc.querySelector(".cqa") !== null && doc.querySelector('[data-test="main"]') !== null`, "the app");

  // the form script handed the context over
  await waitFrame(page, `win.__cqaTest.store.get().conversationId === "DEV:p1-ru-001"`, "the conversation id");
  assert.match(await page.text('[data-test="handover-status"]'), /setClientApiContext|cqa_conversationid = DEV:p1-ru-001/);
  assert.equal(await page.eval(inFrame(`win.__cqaTest.store.get().route.params.id`)), "DEV:p1-ru-001");

  // the iframe sits in a 600 px column
  const width = await page.eval(`${FRAME}.getBoundingClientRect().width`);
  assert.ok(width <= 600 && width >= 590, `iframe width ${width}`);

  // compact mode: no queue, no nav, but the header controls and both panes
  assert.equal(await page.eval(inFrame(`doc.querySelectorAll('[data-test="nav-workspace"]').length`)), 0);
  assert.equal(await page.eval(inFrame(`doc.querySelectorAll('[data-test="queue-pane"], [data-test="queue-toggle"]').length`)), 0);
  assert.equal(await page.eval(inFrame(`doc.querySelectorAll('[data-test="role-switch"]').length`)), 1);
  assert.equal(await page.eval(inFrame(`doc.querySelectorAll('[data-test="dynamics-link"]').length`)), 0, "no link to the form inside the form");
  assert.equal(await page.eval(inFrame(`doc.querySelectorAll('[data-test="transcript-pane"], [data-test="scorecard-pane"]').length`)), 2);
  assert.equal(await page.eval(inFrame(`doc.querySelector(".cqa").classList.contains("cqa--compact")`)), true);

  // light by default when embedded; at 600 px transcript and scorecard are tabs
  assert.equal(await page.eval(inFrame(`doc.querySelector(".cqa").classList.contains("cqa--dark")`)), false);
  assert.equal(await page.eval(inFrame(`win.getComputedStyle(doc.querySelector(".cqa")).backgroundColor`)), "rgb(245, 246, 247)");
  assert.equal(await page.eval(inFrame(`doc.querySelector('[data-test="tab-scorecard"]').getBoundingClientRect().width > 0`)), true);
  assert.equal(await page.eval(inFrame(`doc.documentElement.scrollWidth <= win.innerWidth`)), true, "no horizontal overflow in the frame");

  // the embedded page ignores a stored theme (and does not write one)
  assert.equal(await page.eval(inFrame(`win.localStorage.getItem("cqa-theme")`)), null);

  // nothing in the page reaches for the parent, and the host-facing API is there
  assert.equal(await page.eval(inFrame(`typeof win.CQA.setClientApiContext`)), "function");

  // a form that points at another record switches the compact view (what Xrm does on record change)
  await page.eval(
    inFrame(`win.CQA.setClientApiContext({}, { getAttribute: (field) => (field === "cqa_conversationid" ? { getValue: () => "DEV:p4-ru-001" } : null) })`),
  );
  assert.equal(await page.eval(inFrame(`win.__cqaTest.store.get().route.params.id`)), "DEV:p4-ru-001");
  assert.equal(await page.eval(inFrame(`win.__cqaTest.store.get().groupId`)), "DEV");
  // a form without the field, or with an empty one, changes nothing
  await page.eval(inFrame(`win.CQA.setClientApiContext({}, { getAttribute: () => null })`));
  await page.eval(inFrame(`win.CQA.setClientApiContext({}, { getAttribute: () => ({ getValue: () => "" }) })`));
  assert.equal(await page.eval(inFrame(`win.__cqaTest.store.get().route.params.id`)), "DEV:p4-ru-001");

  // strict CSP: no violation in the host page or in the iframe
  assert.deepEqual(await page.eval(`window.__csp`), []);
  assert.deepEqual(await page.eval(inFrame(`win.__csp`)), []);
}
