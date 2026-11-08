// The motion between the batch board and a dialogue (ui/pane-motion.js, styles/motion.css): a card
// grows into the scorecard's brand panel (a view transition of type cqa-open) and back (cqa-close);
// the board comes back where it was left, with its totals at once; a second click while the first
// still moves wins without motion; reduced motion fades; a browser without view transitions slides.
import assert from "node:assert/strict";

export const name = "board-motion";
export const path = "/#/";
export const viewports = [
  [1280, 720],
  [600, 800],
];
export const motion = true;

const sel = (test) => `[data-test="${test}"]`;
const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
const card = (id) => `${sel("board-card")}[data-id="${id}"]`;

// Wraps document.startViewTransition: window.__vt records the types, how many board totals were on
// screen right after the DOM change (before any fetch could answer) and, once the animations
// start, the pseudo-elements that move.
const RECORD = `(() => {
  window.__realVT ??= document.startViewTransition.bind(document);
  window.__vt = { count: 0, types: [], groups: [], totalsAfterSwap: null, done: false };
  document.startViewTransition = (arg) => {
    window.__vt.count += 1;
    window.__vt.types.push(...(arg.types ?? []));
    const update = () => {
      const done = arg.update(); // the DOM changes synchronously, before its first await
      window.__vt.totalsAfterSwap = document.querySelectorAll('${sel("board-total")}').length;
      return done;
    };
    const vt = window.__realVT({ ...arg, update });
    vt.ready.then(() => {
      window.__vt.groups = document.getAnimations().map((a) => a.effect?.pseudoElement).filter((p) => p?.startsWith("::view-transition"));
    }, () => {});
    vt.finished.then(() => { window.__vt.done = true; });
    return vt;
  };
})()`;

async function until(page, expression, what, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!(await page.eval(expression))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await page.sleep(25);
  }
}

const has = (groups, ...names) => names.every((n) => groups.includes(`::view-transition-${n}`));
const settled = (page, what) => until(page, `window.__vt.done && !${q(".cqa-ws")}.classList.contains("cqa-ws--vt")`, what);
const cleanAfter = async (page) => {
  assert.equal(await page.count(".is-vt-hero"), 0, "no card stays marked");
  assert.equal(await page.eval(`${q(".cqa-ws")}.classList.contains("cqa-ws--vt")`), false, "the transition class is gone");
  assert.equal(await page.eval(`[...document.querySelectorAll(".cqa-ws *")].some((el) => getComputedStyle(el).viewTransitionName !== "none")`), false, "nothing keeps a view-transition-name");
};

export async function run(page) {
  const tabs = page.viewport[0] < 700;
  await page.waitFor(sel("queue-item"), 10000);

  // ---- a batch of 22: the board scrolls ----
  await page.eval(`(() => { const ids = [...document.querySelectorAll('${sel("queue-item")}')].map((r) => r.getAttribute("data-id")).filter((id) => /:p1-/.test(id)).slice(0, 22); window.__cqaTest.store.set({ selection: new Set(ids) }); })()`);
  await until(page, `${q(sel("batch-run"))} && !${q(sel("batch-run"))}.disabled`, "an enabled «Оценить выбранные»");
  await page.eval(`${q(sel("batch-run"))}.click()`);
  await until(page, `document.querySelectorAll(${JSON.stringify(sel("board-total"))}).length === 22`, "22 evaluated cards", 20000);
  await page.eval("window.__cqaTest.store.set({ queueOpen: false })");
  const scroll = q(sel("board-scroll"));
  await page.eval(`${scroll}.scrollTop = ${scroll}.scrollHeight`);
  const scrolled = await page.eval(`${scroll}.scrollTop`);
  assert.ok(scrolled > 0, "22 cards scroll inside the board");
  const ids = await page.eval(`[...document.querySelectorAll(${JSON.stringify(sel("board-card"))})].map((c) => c.getAttribute("data-id"))`);
  const last = ids.at(-1);
  const cardTotal = await page.text(`${card(last)} ${sel("board-total")}`);

  // ---- open: the card grows into the brand panel; the board steps back; the dialogue and scorecard come in ----
  await page.eval(RECORD);
  await page.click(card(last), { scroll: false });
  await settled(page, "the open transition to end");
  const open = await page.eval("window.__vt");
  assert.deepEqual(open.types, ["cqa-open"]);
  assert.equal(decodeURIComponent(await page.eval("location.hash")), `#/c/${last}`);
  assert.ok(has(open.groups, "old(cqa-hero)", "old(cqa-board)", "new(cqa-convo)"), `open moves: ${open.groups.join(" ")}`);
  if (tabs) {
    // the scorecard is a hidden tab: the card fades with the board, nothing lands
    assert.ok(!has(open.groups, "new(cqa-hero)") && !has(open.groups, "new(cqa-side)"), `narrow open: ${open.groups.join(" ")}`);
  } else {
    assert.ok(has(open.groups, "group(cqa-hero)", "new(cqa-hero)", "old(cqa-hero-num)", "new(cqa-hero-num)", "new(cqa-side)"), `the card lands on the panel: ${open.groups.join(" ")}`);
    assert.equal(await page.text(sel("total")), cardTotal, "the panel shows the card's total");
  }
  await page.waitFor(sel("msg"));
  await cleanAfter(page);

  // ---- close: the panel shrinks back into its card; the board is where it was, totals at once ----
  await page.eval(RECORD);
  await page.eval(`${q(sel(tabs ? "board-back-bar" : "board-back"))}.click()`);
  await settled(page, "the close transition to end");
  const close = await page.eval("window.__vt");
  assert.deepEqual(close.types, ["cqa-close"]);
  assert.equal(close.totalsAfterSwap, 22, "the board comes back with its totals, not shimmers");
  assert.equal(await page.eval(`${scroll}.scrollTop`), scrolled, "the board comes back where it was left");
  assert.ok(has(close.groups, "new(cqa-hero)", "new(cqa-board)", "old(cqa-convo)"), `close moves: ${close.groups.join(" ")}`);
  if (!tabs) assert.ok(has(close.groups, "group(cqa-hero)", "old(cqa-hero)", "old(cqa-side)"), `the panel shrinks into the card: ${close.groups.join(" ")}`);
  await cleanAfter(page);

  // ---- a second change while the first still moves: the latest wins, without motion ----
  await page.eval(RECORD);
  await page.eval(`(() => { ${q(card(ids[0]))}.click(); location.hash = "#/c/" + encodeURIComponent(${JSON.stringify(ids[1])}); })()`);
  await until(page, `decodeURIComponent(location.hash) === "#/c/${ids[1]}" && ${q(sel("transcript-pane"))}.textContent.includes(${JSON.stringify(ids[1].split(":")[1])})`, "the second dialogue");
  await until(page, `!${q(".cqa-ws")}.classList.contains("cqa-ws--vt")`, "the skipped transition to end");
  assert.equal(await page.eval("window.__vt.count"), 1, "the first click started a transition, the second skipped it");
  assert.equal(await page.count(sel("transcript")), 1, "one transcript");
  assert.equal(await page.count(sel("scorecard")), 1, "one scorecard");
  await cleanAfter(page);

  // ---- reduced motion: no view transition, a short fade ----
  await page.eval(`location.hash = "#/"`);
  await until(page, `${q(sel("batch-board"))} !== null && !${q(".cqa-ws")}.classList.contains("cqa-ws--vt")`, "the board again");
  await page.reducedMotion(true);
  await page.eval(RECORD);
  await page.eval(`${q(card(ids[2]))}.click()`);
  await until(page, `decodeURIComponent(location.hash) === "#/c/${ids[2]}" && ${q(sel("transcript"))} !== null`, "the dialogue, reduced");
  assert.equal(await page.eval("window.__vt.count"), 0, "reduced motion: no view transition");
  assert.equal(await page.eval(`${q(".cqa-ws")}.classList.contains("cqa-ws--arrive-fade")`), true, "the fade class is on");
  assert.equal(await page.eval(`getComputedStyle(${q(sel("transcript"))}).animationName`), "cqa-vt-fade-in");
  await until(page, `!${q(".cqa-ws")}.classList.contains("cqa-ws--arrive-fade")`, "the fade class to go", 3000);
  await page.reducedMotion(false);

  // ---- no view transitions (older browsers): the new panes slide in by themselves ----
  await page.eval(`location.hash = "#/"`);
  await until(page, `${q(sel("batch-board"))} !== null && !${q(".cqa-ws")}.classList.contains("cqa-ws--vt")`, "the board, once more");
  await page.eval(`(() => { window.__savedVT = window.ViewTransition; window.ViewTransition = undefined; })()`);
  await page.eval(RECORD);
  await page.eval(`${q(card(ids[3]))}.click()`);
  await until(page, `decodeURIComponent(location.hash) === "#/c/${ids[3]}" && ${q(sel("transcript"))} !== null`, "the dialogue, sliding");
  assert.equal(await page.eval("window.__vt.count"), 0, "no view transition without the API");
  assert.equal(await page.eval(`${q(".cqa-ws")}.classList.contains("cqa-ws--arrive-slide")`), true, "the slide class is on");
  assert.equal(await page.eval(`getComputedStyle(${q(sel("transcript"))}).animationName`), "cqa-vt-rise");
  if (!tabs) assert.equal(await page.eval(`getComputedStyle(${q(sel("scorecard-pane"))}).animationName`), "cqa-vt-from-right");
  await page.eval(`window.ViewTransition = window.__savedVT`);
  await until(page, `!${q(".cqa-ws")}.classList.contains("cqa-ws--arrive-slide")`, "the slide class to go", 3000);
}
