// The shell: nav and routes, theme toggle with persistence, role switch, the narrow layouts,
// toasts, and the dev-only test hooks.
import assert from "node:assert/strict";

export const name = "shell";
export const path = "/";
export const viewports = [
  [1400, 900],
  [600, 800],
];

const sel = (test) => `[data-test="${test}"]`;
const visible = (page, selector) =>
  page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; })()`);

export async function run(page) {
  const narrow = page.viewport[0] < 700;
  await page.waitFor(sel("main"));
  await page.waitFor(sel("nav-workspace"));

  // ---- nav changes the route ----
  assert.equal(await page.eval("window.__cqaTest.store.get().route.name"), "workspace");
  assert.equal(await page.eval(`document.querySelector(${JSON.stringify(sel("nav-workspace"))}).getAttribute("aria-current")`), "page");
  for (const [route, hash, title] of [
    ["checklists", "#/checklists", "Чек-листы"],
    ["appeals", "#/appeals", "Апелляции"],
    ["analytics", "#/analytics", "Отчёты"],
    ["workspace", "#/", null],
  ]) {
    await page.click(sel(`nav-${route}`));
    await page.eval(`new Promise((resolve) => { const t = Date.now(); (function wait() { window.__cqaTest.store.get().route.name === ${JSON.stringify(route)} || Date.now() - t > 2000 ? resolve() : setTimeout(wait, 20); })(); })`);
    assert.equal(await page.eval("window.__cqaTest.store.get().route.name"), route);
    assert.equal(await page.eval("location.hash"), hash);
    assert.equal(await page.eval(`document.querySelector(${JSON.stringify(sel(`nav-${route}`))}).getAttribute("aria-current")`), "page");
    assert.equal(await page.count('[aria-current="page"]'), 1);
    if (title) assert.match(await page.text(sel("main")), new RegExp(title));
  }
  // an unknown route is a page of its own, not a crash
  await page.eval(`location.hash = "#/no/such/page"`);
  await page.waitFor(sel("notfound"));
  await page.eval(`location.hash = "#/"`);
  await page.waitFor(sel("workspace"));
  // a conversation route keeps the workspace and names the dataset
  await page.eval(`location.hash = "#/c/CTRL%3Ax-1"`);
  await page.waitFor(`${sel("transcript-pane")} ${sel("transcript-error")}`); // no such record: the pane says so and names it
  assert.match(await page.text(sel("transcript-pane")), /CTRL:x-1/);
  assert.match(await page.text(sel("dataset-badge")), /CTRL/);
  await page.eval(`location.hash = "#/"`);

  // ---- theme toggle: dark by default, toggles cqa--dark, persists across reload ----
  assert.equal(await page.count(".cqa.cqa--dark"), 1);
  assert.equal(await page.eval(`getComputedStyle(document.querySelector(".cqa")).backgroundColor`), "rgb(25, 25, 25)");
  await page.click(sel("theme-toggle"));
  assert.equal(await page.count(".cqa--dark"), 0);
  assert.equal(await page.eval(`getComputedStyle(document.querySelector(".cqa")).backgroundColor`), "rgb(245, 246, 247)");
  assert.equal(await page.eval(`localStorage.getItem("cqa-theme")`), "light");
  await page.goto("/");
  await page.waitFor(sel("theme-toggle"));
  assert.equal(await page.count(".cqa--dark"), 0, "the light theme survives a reload");
  assert.equal(await page.eval(`document.querySelector(${JSON.stringify(sel("theme-toggle"))}).getAttribute("aria-checked")`), "false");
  // an explicit ?theme= beats the stored choice
  await page.goto("/?theme=dark");
  await page.waitFor(sel("theme-toggle"));
  assert.equal(await page.count(".cqa.cqa--dark"), 1);
  await page.goto("/");
  await page.waitFor(sel("theme-toggle"));
  await page.click(sel("theme-toggle"));
  assert.equal(await page.count(".cqa.cqa--dark"), 1);
  assert.equal(await page.eval(`localStorage.getItem("cqa-theme")`), "dark");
  await page.goto("/");
  await page.waitFor(sel("theme-toggle"));
  assert.equal(await page.count(".cqa.cqa--dark"), 1, "the dark theme survives a reload");

  // ---- the mock Dynamics form: a header link there, and a link back ----
  assert.equal(await page.eval(`document.querySelector(${JSON.stringify(sel("dynamics-link"))}).getAttribute("href")`), "dynamics-mock.html");
  await page.click(sel("dynamics-link"));
  await page.waitFor('[data-test="cqa-frame"]');
  await page.click('[data-test="back-to-app"]');
  await page.waitFor(sel("dynamics-link"));
  await page.waitFor(sel("workspace"));

  // ---- role switch ----
  assert.match(await page.text(sel("role-switch")), /Контролёр/);
  await page.click(sel("role-switch"));
  assert.equal(await page.eval(`document.querySelector(${JSON.stringify(sel("role-menu"))}).hidden`), false);
  await page.click(sel("role-option-reviewer"));
  assert.match(await page.text(sel("role-switch")), /Проверяющий/);
  assert.equal(await page.eval("window.__cqaTest.store.get().role"), "reviewer");
  assert.equal(await page.eval(`document.querySelector(${JSON.stringify(sel("role-menu"))}).hidden`), true, "the menu closes after a choice");
  // a click elsewhere and Escape close the menu without choosing
  await page.click(sel("role-switch"));
  await page.click(sel("dataset-badge"));
  assert.equal(await page.eval(`document.querySelector(${JSON.stringify(sel("role-menu"))}).hidden`), true);
  await page.click(sel("role-switch"));
  await page.eval(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  assert.equal(await page.eval(`document.querySelector(${JSON.stringify(sel("role-menu"))}).hidden`), true);
  assert.equal(await page.eval("window.__cqaTest.store.get().role"), "reviewer");

  // ---- layout by width ----
  await page.eval(`location.hash = "#/"`);
  await page.waitFor(sel("queue-pane"));
  if (narrow) {
    assert.equal(await page.count(sel("queue-toggle")), 1);
    assert.equal(await visible(page, sel("queue-pane")), false, "the queue is a closed drawer");
    await page.click(sel("queue-toggle"));
    assert.equal(await visible(page, sel("queue-pane")), true);
    assert.equal(await page.count(".cqa-ws--queue-open"), 1);
    await page.click(sel("queue-scrim"));
    assert.equal(await visible(page, sel("queue-pane")), false);
    await page.click(sel("queue-toggle"));
    await page.eval(`document.querySelector(${JSON.stringify(sel("workspace"))}).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    assert.equal(await visible(page, sel("queue-pane")), false, "Escape closes the drawer");
    // transcript and scorecard are tabs
    assert.equal(await visible(page, sel("tab-transcript")), true);
    assert.equal(await visible(page, sel("transcript-pane")), true);
    assert.equal(await visible(page, sel("scorecard-pane")), false);
    await page.click(sel("tab-scorecard"));
    assert.equal(await visible(page, sel("scorecard-pane")), true);
    assert.equal(await visible(page, sel("transcript-pane")), false);
    await page.click(sel("tab-transcript"));
    assert.equal(await visible(page, sel("transcript-pane")), true);
  } else {
    assert.equal(await visible(page, sel("queue-toggle")), false);
    assert.equal(await visible(page, sel("tab-transcript")), false);
    for (const pane of ["queue-pane", "transcript-pane", "scorecard-pane"]) assert.equal(await visible(page, sel(pane)), true, pane);
  }

  // ---- toasts ----
  await page.eval(`window.__cqaTest.store.set({ toasts: [{ id: 901, kind: "error", text: "Тест: ошибка", retry: () => { window.__retried = true; } }, { id: 902, kind: "info", text: "Тест: сообщение", retry: null }] })`);
  assert.equal(await page.count(sel("toast")), 2);
  assert.equal(await page.count(sel("toast-retry")), 1);
  await page.click(sel("toast-retry"));
  assert.equal(await page.eval("window.__retried === true"), true);
  assert.equal(await page.count(sel("toast")), 1, "retry dismisses its toast");
  await page.click(sel("toast-close"));
  assert.equal(await page.count(sel("toast")), 0);

  // ---- dev-only test hooks: mockFault and mockModelKey ----
  await page.goto("/?mockFault=getConfig:network&mockModelKey=0");
  await page.waitFor(sel("main"));
  assert.equal(await page.eval(`window.__cqaTest.api.getConfig().then(() => "resolved", (error) => error.code)`), "network");
  await page.goto("/?mockModelKey=0");
  await page.waitFor(sel("main"));
  assert.equal(await page.eval(`window.__cqaTest.api.getConfig().then((config) => config.model_key_configured)`), false);
  await page.goto("/?mockModelKey=1");
  await page.waitFor(sel("main"));
  assert.equal(await page.eval(`window.__cqaTest.api.getConfig().then((config) => config.model_key_configured)`), true);
}
