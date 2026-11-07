// Re-import of the open dialogue (review of #64): an import that leaves the dialogue as it was does
// not redraw the transcript; an import that updates it redraws the open transcript with the new
// lines, keeps its scroll position, and the scorecard reloads too. The server's newer version is
// synthetic (the mock API is wrapped in the page); no dialogue text is printed.
import assert from "node:assert/strict";

export const name = "reimport";
export const path = "/#/";
export const viewports = [
  [1400, 900],
  [600, 800],
];

const sel = (test) => `[data-test="${test}"]`;
const quote = (value) => JSON.stringify(value);
const MSG = `${sel("transcript")} ${sel("msg")}`;

async function until(page, expression, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!(await page.eval(expression))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await page.sleep(25);
  }
}

const visible = (page, selector) => page.eval(`(() => { const el = document.querySelector(${quote(selector)}); return Boolean(el) && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden"; })()`);
async function showQueue(page) {
  if (!(await visible(page, sel("queue-pane")))) await page.click(sel("queue-toggle"));
  await until(page, `document.querySelector(${quote(sel("queue-pane"))}).getBoundingClientRect().width > 0`, "the queue");
}

async function importAgain(page, summary) {
  const before = await page.eval(`window.__fetches`);
  await page.click(sel("import-group"));
  await until(page, `${summary}.test(document.querySelector(${quote(sel("import-summary"))})?.textContent ?? "")`, `the summary ${summary}`);
  // The transcript and the scorecard each fetch the dialogue again.
  await until(page, `window.__fetches >= ${before + 2}`, "the transcript and the scorecard to fetch the dialogue again");
  await page.sleep(150);
}

export async function run(page) {
  await page.waitFor(sel("queue-item"), 10000);
  const id = await page.eval(`(async () => (await window.__cqaTest.api.listConversations({ group_id: "DEV" })).find((c) => c.channel === "agent chat").id)()`);
  await page.eval(`location.hash = "#/c/" + encodeURIComponent(${quote(id)})`);
  await page.waitFor(sel("transcript-msgs"), 8000);
  await until(page, `document.querySelector(${quote(sel("scorecard-loading"))}) === null`, "the scorecard");
  const lines = await page.count(MSG);

  // The server's newer version of the open dialogue has one more line; the import says so.
  await page.eval(`(() => {
    const api = window.__cqaTest.api;
    const realGet = api.getConversation;
    window.__updated = false;
    window.__fetches = 0;
    api.getConversation = (cid) => realGet(cid).then((c) => {
      if (cid !== ${quote(id)}) return c;
      window.__fetches += 1;
      if (!window.__updated) return c;
      const last = c.transcript[c.transcript.length - 1];
      return { ...c, transcript: [...c.transcript, { timestamp: last ? last.timestamp : "", speaker: "operator", text: "Синтетическая строка после обновления" }] };
    });
    api.importDataset = (group) => Promise.resolve(window.__updated
      ? { group_id: group, total: 1, imported: 0, updated: 1, unchanged: 0 }
      : { group_id: group, total: 1, imported: 0, updated: 0, unchanged: 1 });
  })()`);

  await showQueue(page);
  await page.click(sel("open-loader"));
  await page.waitFor(sel("loader"));
  await page.type(sel("group-id"), "DEV");

  // ---- nothing changed: the transcript is not redrawn ----
  await page.eval(`window.__firstLine = document.querySelector(${quote(MSG)})`);
  await importAgain(page, "/без изменений 1/");
  assert.equal(await page.count(MSG), lines, "the same lines");
  assert.equal(await page.eval(`document.querySelector(${quote(MSG)}) === window.__firstLine`), true, "an unchanged dialogue is not redrawn");

  // ---- the dialogue was updated: the open transcript shows the new line ----
  await page.eval(`(() => {
    const scroller = document.querySelector(${quote(sel("transcript-list"))});
    scroller.scrollTop = Math.min(40, scroller.scrollHeight - scroller.clientHeight);
    window.__scrollTop = scroller.scrollTop;
    window.__updated = true;
  })()`);
  await importAgain(page, "/обновлено 1/");
  await until(page, `document.querySelectorAll(${quote(MSG)}).length === ${lines + 1}`, "the transcript to show the updated dialogue");
  assert.equal(
    await page.eval(`[...document.querySelectorAll(${quote(MSG)})].at(-1).textContent.includes("Синтетическая строка после обновления")`),
    true,
    "the new line is the last message",
  );
  assert.match(await page.text(sel("transcript-meta")), new RegExp(`${lines + 1}`), "the line count in the header follows");
  assert.equal(await page.eval(`document.querySelector(${quote(sel("transcript-list"))}).scrollTop === window.__scrollTop`), true, "the scroll position is kept");
  await page.click(sel("loader-close"));
  await until(page, `document.querySelector(${quote(sel("loader"))}) === null`, "the loader to close");
}
