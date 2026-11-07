// The language and checklist pickers: a button and a list drawn like the role menu over a hidden
// native <select>, which stays the source of truth (ui/dropdown.js).
import assert from "node:assert/strict";

export const name = "dropdowns";
export const path = "/#/c/DEV%3Ap1-ru-001";
export const viewports = [
  [1400, 900],
  [600, 800],
];

const sel = (test) => `[data-test="${test}"]`;
const q = (selector) => `document.querySelector(${JSON.stringify(selector)})`;
const option = (test, n) => `${sel(`${test}-list`)} [role="option"]:nth-child(${n})`;
const key = (name) => `document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(name)}, bubbles: true }))`;
const isOpen = (page, test) => page.eval(`!${q(sel(`${test}-list`))}.hidden && ${q(sel(`${test}-button`))}.getAttribute("aria-expanded") === "true"`);
const focused = (page) => page.eval("document.activeElement.textContent");
const shown = (page, test) => page.eval(`${q(sel(`${test}-button`))}.querySelector(".cqa-dd-value").textContent`);
const visibleText = (page, test) => page.eval(`${q(sel(`${test}-button`))}.innerText.trim()`);
const tick = "new Promise((resolve) => setTimeout(resolve, 0))";

async function until(page, expression, what) {
  const deadline = Date.now() + 8000;
  while (!(await page.eval(expression))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await page.sleep(25);
  }
}

export async function run(page) {
  const narrow = page.viewport[0] < 700;
  await page.waitFor(sel("ui-language-button"), 10000);

  // ---- the native select is kept but out of sight and out of the tab order ----
  assert.equal(await page.eval(`${q(sel("ui-language"))}.getBoundingClientRect().width`), 0);
  assert.equal(await page.eval(`${q(sel("ui-language"))}.tabIndex`), -1);
  assert.equal(await page.eval(`${q(sel("ui-language"))}.getAttribute("aria-hidden")`), "true");
  assert.equal(await shown(page, "ui-language"), "Русский (RU)");
  // below 700 px the header pill shows only the language code
  assert.equal(await visibleText(page, "ui-language"), narrow ? "RU" : "Русский (RU)");
  // the button's name is the select's label plus the current value
  const name = await page.eval(`${q(sel("ui-language-button"))}.getAttribute("aria-labelledby").split(" ").map((id) => document.getElementById(id).textContent).join(" ")`);
  assert.equal(name, `${await page.eval(`${q(sel("ui-language"))}.getAttribute("aria-label")`)} Русский (RU)`);

  // ---- a real click opens the list on the current choice; a click on an item switches ----
  await page.click(sel("ui-language-button"));
  assert.equal(await isOpen(page, "ui-language"), true);
  assert.deepEqual(
    await page.eval(`[...document.querySelectorAll(${JSON.stringify(`${sel("ui-language-list")} [role="option"]`)})].map((o) => [o.textContent, o.getAttribute("aria-selected")])`),
    [["Қазақша (KAZ)", "false"], ["Русский (RU)", "true"], ["English (EN)", "false"]],
  );
  assert.equal(await focused(page), "Русский (RU)", "focus starts on the chosen item");
  await page.click(option("ui-language", 3));
  assert.equal(await page.text(sel("nav-workspace")), "Evaluation");
  assert.equal(await isOpen(page, "ui-language"), false, "the list closes after a choice");
  assert.equal(await shown(page, "ui-language"), "English (EN)");
  assert.equal(await page.eval(`${q(sel("ui-language"))}.value`), "en");
  assert.equal(await page.eval(`document.activeElement === ${q(sel("ui-language-button"))}`), true, "focus returns to the button");

  // ---- keyboard: arrows open and move (wrapping), Home and End jump ----
  await page.eval(key("ArrowDown"));
  assert.equal(await isOpen(page, "ui-language"), true);
  assert.equal(await focused(page), "English (EN)");
  await page.eval(key("ArrowDown"));
  assert.equal(await focused(page), "Қазақша (KAZ)", "ArrowDown wraps to the top");
  await page.eval(key("End"));
  assert.equal(await focused(page), "English (EN)");
  await page.eval(key("Home"));
  assert.equal(await focused(page), "Қазақша (KAZ)");
  await page.eval(key("ArrowUp"));
  assert.equal(await focused(page), "English (EN)", "ArrowUp wraps to the bottom");
  await page.eval(key("ArrowUp"));
  assert.equal(await focused(page), "Русский (RU)");
  await page.eval("document.activeElement.click()"); // Enter or Space on a focused button
  assert.equal(await page.text(sel("nav-workspace")), "Оценка");

  // ---- Escape closes without choosing and stays inside; a click elsewhere closes too ----
  await page.eval(`window.__escapes = 0; document.addEventListener("keydown", (e) => { if (e.key === "Escape") window.__escapes++; })`);
  await page.click(sel("ui-language-button"));
  await page.eval(key("ArrowDown"));
  await page.eval(key("Escape"));
  assert.equal(await isOpen(page, "ui-language"), false);
  assert.equal(await page.eval(`document.activeElement === ${q(sel("ui-language-button"))}`), true);
  assert.equal(await page.eval("window.__escapes"), 0, "the Escape does not reach the page behind");
  assert.equal(await page.eval(`${q(sel("ui-language"))}.value`), "ru");
  await page.click(sel("ui-language-button"));
  await page.click(sel("role-switch"));
  assert.equal(await isOpen(page, "ui-language"), false);
  await page.click(sel("role-switch"));

  // ---- writes that fire no event still repaint the button ----
  await page.eval(`${q(sel("ui-language"))}.value = "en"`);
  assert.equal(await shown(page, "ui-language"), "English (EN)");
  await page.eval(`${q(sel("ui-language"))}.selectedIndex = 1`);
  assert.equal(await shown(page, "ui-language"), "Русский (RU)");

  // ---- the checklist picker in the scorecard ----
  if (narrow) await page.click(sel("tab-scorecard"));
  await until(page, `${q(sel("checklist-select-button"))} && !${q(sel("checklist-select-button"))}.disabled`, "the checklist picker");
  assert.equal(await shown(page, "checklist-select"), await page.eval(`${q(sel("checklist-select"))}.selectedOptions[0].textContent`));
  await page.eval(`window.__changes = 0; ${q(sel("checklist-select"))}.addEventListener("change", () => window.__changes++)`);
  await page.click(sel("checklist-select-button"));
  assert.equal(await isOpen(page, "checklist-select"), true);
  assert.equal(await page.count(`${sel("checklist-select-list")} [role="option"]`), await page.eval(`${q(sel("checklist-select"))}.options.length`));
  assert.equal(await page.eval("document.documentElement.scrollWidth <= innerWidth"), true, "the open list does not widen the page");
  await page.click(`${sel("checklist-select-list")} [aria-selected="true"]`);
  assert.equal(await isOpen(page, "checklist-select"), false);
  assert.equal(await page.eval("window.__changes"), 0, "choosing the current item changes nothing");
  // options added or removed and the disabled state reach the button and the list
  await page.eval(`(async () => { const s = ${q(sel("checklist-select"))}; const o = document.createElement("option"); o.value = "x"; o.textContent = "Extra · v9"; s.append(o); await ${tick}; })()`);
  assert.equal(await page.eval(`[...document.querySelectorAll(${JSON.stringify(`${sel("checklist-select-list")} [role="option"]`)})].at(-1).textContent`), "Extra · v9");
  await page.eval(`(async () => { ${q(sel("checklist-select"))}.lastElementChild.remove(); ${q(sel("checklist-select"))}.disabled = true; await ${tick}; })()`);
  assert.equal(await page.eval(`${q(sel("checklist-select-button"))}.disabled`), true);
  assert.equal(await page.count(`${sel("checklist-select-list")} [role="option"]`), await page.eval(`${q(sel("checklist-select"))}.options.length`));
  await page.eval(`(async () => { ${q(sel("checklist-select"))}.disabled = false; await ${tick}; })()`);
  assert.equal(await page.eval(`${q(sel("checklist-select-button"))}.disabled`), false);
}
