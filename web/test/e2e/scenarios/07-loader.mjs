// Loading data and batch runs (R3, R9, control check 1): import a group by group_id, upload a
// file (and see a bad one refused with a precise message), pick dialogues, read the dry-run
// estimate, run the batch to the end, and select every dialogue of the imported group at once.
// Counts and states only; no dialogue text is printed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export const name = "loader";
export const path = "/#/";
export const viewports = [
  [1400, 900],
  [600, 800],
];

const sel = (test) => `[data-test="${test}"]`;
const quote = (value) => JSON.stringify(value);
const EXAMPLE = readFileSync(new URL("../../../../contract/examples/conversation.chat-ru.json", import.meta.url), "utf8");
const SUMMARY = /^Всего \d+ · новых \d+ · обновлено \d+ · без изменений \d+$/;
const ESTIMATE = /^(\d+) диалог(а|ов)? · \d+ вызов(а|ов)? модели · \d+ из кэша$/;

async function until(page, expression, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!(await page.eval(expression))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await page.sleep(25);
  }
}

const visible = (page, selector) => page.eval(`(() => { const el = document.querySelector(${quote(selector)}); return Boolean(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden"; })()`);

// Below 900 px the queue is a drawer; open it when it is closed.
async function showQueue(page) {
  if (!(await visible(page, sel("queue-pane")))) await page.click(sel("queue-toggle"));
  await until(page, `document.querySelector(${quote(sel("queue-pane"))}).getBoundingClientRect().width > 0`, "the queue");
}

async function pickFile(page, name, text) {
  await page.eval(`(() => {
    const input = document.querySelector(${quote(sel("upload-file"))});
    const files = new DataTransfer();
    files.items.add(new File([${quote(text)}], ${quote(name)}, { type: "application/json" }));
    input.files = files.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
}

const rowsOf = (page, prefix) => page.eval(`[...document.querySelectorAll('[data-test="queue-item"]')].filter((r) => r.getAttribute("data-id").startsWith(${quote(prefix)})).length`);

export async function run(page) {
  await page.waitFor(sel("queue-item"), 10000);
  await showQueue(page);
  const devRows = await page.count(sel("queue-item"));

  // ---- import a group by its group_id ----
  await page.click(sel("open-loader"));
  await page.waitFor(sel("loader"));
  assert.equal(await page.eval(`document.querySelector(${quote(sel("import-group"))}).disabled`), true, "no import without a group_id");
  await page.type(sel("group-id"), "CTRL");
  await page.click(sel("import-group"));
  await until(page, `document.querySelector(${quote(sel("import-summary"))})?.textContent.length > 0`, "the import summary");
  assert.match(await page.text(sel("import-summary")), SUMMARY);
  assert.match(await page.text(sel("import-summary")), /новых 2/, "the two control dialogues are new");
  await until(page, `document.querySelector(${quote(sel("dataset-badge"))}).textContent.includes("CTRL")`, "the dataset badge to show CTRL");

  // ---- upload: a bad file is refused precisely; a record file adds its group ----
  await pickFile(page, "broken.json", "{ not json");
  await page.waitFor(sel("loader-error"));
  assert.match(await page.text(sel("loader-error")), /JSON/, "a broken file says it is not JSON");
  await pickFile(page, "dialog.json", EXAMPLE);
  await until(page, `document.querySelector(${quote(sel("loader-error"))}) === null && /новых 1/.test(document.querySelector(${quote(sel("import-summary"))})?.textContent ?? "")`, "the upload summary");
  await page.click(sel("loader-close"));
  await until(page, `document.querySelector(${quote(sel("loader"))}) === null`, "the loader to close");

  // ---- the queue follows the last import: only that group is shown ----
  await showQueue(page);
  await until(page, `document.querySelector(${quote(sel("queue-group-filter"))})?.value?.startsWith("upload-") === true`, "the group filter on the uploaded group");
  assert.equal(await rowsOf(page, "upload-"), 1, "the uploaded dialogue has its row");
  assert.equal(await page.count(sel("queue-item")), 1, "only the uploaded group is shown");

  // ---- select all shown, on the control group ----
  await page.eval(`(() => { const s = document.querySelector(${quote(sel("queue-group-filter"))}); s.value = "CTRL"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await until(page, `document.querySelectorAll('[data-test="queue-item"]').length === 2`, "the two control rows");
  assert.equal(await page.count(sel("batch-bar")), 0, "no batch bar without a selection");
  await page.click(sel("queue-select-all"));
  await page.waitFor(sel("batch-bar"));
  assert.equal(await page.eval(`window.__cqaTest.store.get().selection.size`), 2, "select all picks the shown rows only");
  await until(page, `/^2 /.test(document.querySelector(${quote(sel("batch-estimate"))})?.textContent ?? "")`, "the estimate for 2");
  assert.match(await page.text(sel("batch-estimate")), ESTIMATE);
  await page.click(sel("queue-select-all"));
  await until(page, `document.querySelector(${quote(sel("batch-bar"))}) === null`, "select all to clear the selection");

  // ---- pick 3 DEV rows, estimate, run to the end ----
  await page.eval(`(() => { const s = document.querySelector(${quote(sel("queue-group-filter"))}); s.value = "DEV"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await until(page, `document.querySelectorAll('[data-test="queue-item"]').length === ${devRows}`, "the DEV rows");
  const picked = await page.eval(`[...document.querySelectorAll('[data-test="queue-item"]')].slice(0, 3).map((r) => r.getAttribute("data-id"))`);
  // Rows fill in their topic line after they scroll into view, which moves the rows below them;
  // wait for these rows to settle so a click lands on the checkbox it measured.
  await until(page, `${quote(picked)}.every((id) => (document.querySelector('[data-test="queue-item"][data-id="' + id + '"] [data-test="queue-topic"]')?.textContent ?? "").length > 0)`, "the topic lines of the picked rows");
  await page.sleep(300);
  for (const id of picked) await page.click(`${sel("queue-item")}[data-id="${id}"] ${sel("queue-select")}`);
  await until(page, `window.__cqaTest.store.get().selection.size === 3 && location.hash === "#/"`, "three rows picked, no dialogue opened by a stray click");
  await page.waitFor(sel("batch-bar"));
  await until(page, `/^3 /.test(document.querySelector(${quote(sel("batch-estimate"))})?.textContent ?? "")`, "the estimate for 3");
  const estimate = ESTIMATE.exec(await page.text(sel("batch-estimate")));
  assert.ok(estimate, "the estimate reads «N диалогов · M вызовов модели · K из кэша»");
  assert.equal(estimate[1], "3");
  await page.eval(`window.scrollTo(0, 0)`);
  assert.equal(
    await page.eval(`(() => { const r = document.querySelector(${quote(sel("batch-run"))}).getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= innerHeight + 1; })()`),
    true,
    "«Оценить выбранные» is on screen without scrolling the list",
  );
  await page.click(sel("batch-run"));
  // the board takes over: the ticks are cleared and the bar hides
  assert.equal(await page.count(sel("batch-bar")), 0, "the bar hides once the batch starts");
  assert.equal(await page.eval(`window.__cqaTest.store.get().selection.size`), 0, "the ticks are cleared");
  await until(page, `/3 из 3/.test(document.querySelector(${quote(sel("board-progress"))})?.textContent ?? "")`, "the batch to reach 3 of 3", 15000);
  await until(
    page,
    `${quote(picked)}.every((id) => /\\d/.test(document.querySelector('[data-test="queue-item"][data-id="' + id + '"] [data-test="queue-score"]')?.textContent ?? ""))`,
    "the scores of the evaluated rows",
    10000,
  );
  assert.equal(await page.count(sel("batch-retry")), 0, "nothing failed, nothing to retry");
}
