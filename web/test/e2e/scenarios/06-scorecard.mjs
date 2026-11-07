// The scorecard: run an evaluation on the mock, the brand panel, the criterion cards, evidence
// links that jump into the transcript, the dispute button, and the two failure states (Review
// Focus 3: an API fault, a missing model key). Counts, classes and geometry only; no dialogue text
// is printed.
import assert from "node:assert/strict";

export const name = "scorecard";
export const path = "/#/c/DEV%3Ap1-ru-001";
export const viewports = [
  [1400, 900],
  [600, 800],
];

const sel = (test) => `[data-test="${test}"]`;
const quote = (value) => JSON.stringify(value);
const ID = "DEV:p1-ru-001";
const HASH = "#/c/DEV%3Ap1-ru-001";

async function until(page, expression, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!(await page.eval(expression))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await page.sleep(25);
  }
}

// Below 700 px the scorecard is a tab; bring it forward when its tab is on screen.
async function showScorecard(page) {
  await page.eval(`(() => { const tab = document.querySelector('[data-test="tab-scorecard"]'); if (tab && tab.offsetParent !== null) tab.click(); })()`);
}

// A fresh page load with a query (the hash alone would not reload the document).
async function load(page, query) {
  await page.goto(`/?${query}${HASH}`);
  await page.waitFor(sel("scorecard"), 10000);
  await until(page, `document.querySelector(${quote(sel("scorecard-loading"))}) === null`, "the scorecard to load");
}

const disabled = (page, test) => page.eval(`document.querySelector(${quote(sel(test))}).disabled`);

export async function run(page) {
  await page.waitFor(sel("scorecard"), 10000);
  await until(page, `document.querySelector(${quote(sel("run-eval"))}) !== null && !document.querySelector(${quote(sel("run-eval"))}).disabled`, "the run button");
  const checklist = await page.eval(`window.__cqaTest.api.getConfig().then(async (c) => {
    const v = await window.__cqaTest.api.getChecklistVersion(c.default_checklist.checklist_id, c.default_checklist.version);
    return { id: c.default_checklist.checklist_id, version: c.default_checklist.version, criteria: v.criteria.length };
  })`);
  assert.equal(await page.eval(`document.querySelector(${quote(sel("checklist-select"))}).selectedOptions[0].textContent.length > 0`), true, "the picker shows the default checklist");
  assert.equal(await page.text(sel("run-eval")), "Оценить");
  assert.equal(await page.count(sel("total")), 0, "nothing is shown before a run");
  assert.equal(await page.count(sel("scorecard-empty")), 1);

  // ---- run: «Оценить», progress, then the brand panel ----
  await showScorecard(page);
  await page.click(sel("run-eval"));
  await until(page, `document.querySelector(${quote(sel("job-progress"))}).textContent.length > 0`, "the progress line", 3000);
  assert.equal(await disabled(page, "run-eval"), true, "no second run while one is going");
  await page.waitFor(sel("total"), 10000);
  await until(page, `document.querySelector(${quote(sel("job-progress"))}).textContent === ""`, "the progress line to clear");

  assert.equal(await page.count(sel("crit")), checklist.criteria, "one card per criterion");
  const total = await page.text(sel("total"));
  assert.match(total, /^(\d+,\d{2}|не рассчитывается)$/, "the total has two decimals");
  assert.equal(await page.text(sel("demo-badge")), "демо-оценка", "a mock evaluation is marked");
  assert.equal(await page.text(sel("run-eval")), "Переоценить");
  assert.match(await page.text(sel("gross-flag")), /грубая ошибка|грубых ошибок нет/);
  assert.equal(await page.eval(`document.querySelector(${quote(sel("gross-flag"))}).getAttribute("data-state")`), (await page.eval(`window.__cqaTest.api.listEvaluations({ conversation: ${quote(ID)} }).then((l) => l[0].gross_error.flag)`)) ? "on" : "off");
  assert.ok((await page.count(sel("section"))) >= 1, "sections are listed");
  assert.match(await page.text(sel("section-score")), /^\d+,\d{2} из \d+,\d{2} · \d+,\d{2} %$|нет применимых критериев/);
  assert.match(await page.text(sel("model")), /Модель:/);
  assert.equal(await page.eval(`window.__cqaTest.store.get().queueRefresh > 0`), true, "the queue was told to reload");
  // the total is the one the server (mock) computed, to the cent
  const server = await page.eval(`window.__cqaTest.api.listEvaluations({ conversation: ${quote(ID)} }).then((l) => l[0].final_total)`);
  assert.equal(total, server === null ? "не рассчитывается" : server.toFixed(2).replace(".",","));

  // ---- cards: answer tag, points, explanation, coaching, info ----
  assert.equal(await page.eval(`[...document.querySelectorAll('[data-test="crit"]')].every((c) => c.querySelector('[data-test="answer"]') && c.querySelector('[data-test="points"]'))`), true);
  assert.equal(await page.eval(`[...document.querySelectorAll('[data-test="crit"]')].filter((c) => c.querySelector('[data-test="why"]')).length`), checklist.criteria, "every card explains itself");
  assert.equal(await page.eval(`[...document.querySelectorAll('[data-test="answer"]')].every((a) => /^(Да|Нет|N\\/A|шаг -?[\\d.]+)$/.test(a.textContent))`), true, "answer tags use the contract's four forms");
  assert.equal(await page.eval(`[...document.querySelectorAll('[data-test="points"]')].every((p) => /^(\\d+,\\d{2} из \\d+,\\d{2}|вес распределён по остальным|не влияет на итог|—)$/.test(p.textContent))`), true, "points read «earned из max»");
  assert.equal(await page.count(sel("info")), 1);
  assert.equal(await page.eval(`document.querySelector(${quote(sel("info"))}).hidden`), false, "the info block has something to show");
  assert.match(await page.text(`${sel("info")} h3`), /Не влияет на оценку/);

  // ---- an N/A card shows its reason (found among a few dialogues when this one has none) ----
  async function naCard() {
    return page.eval(`(() => {
      const card = [...document.querySelectorAll('[data-test="crit"]')].find((c) => c.getAttribute("data-answer") === "na");
      if (!card) return null;
      return { id: card.getAttribute("data-criterion"), reason: card.querySelector('[data-test="na-reason"]')?.textContent ?? "" };
    })()`);
  }
  let na = await naCard();
  if (!na) {
    // evaluate other DEV dialogues through the API until one has an N/A, then open it in the UI
    const found = await page.eval(`(async () => {
      const api = window.__cqaTest.api;
      const ids = (await api.listConversations({ group_id: "DEV" })).map((c) => c.id).filter((id) => id !== ${quote(ID)});
      for (const id of ids) {
        const job = await api.startEvaluations({ conversations: [id], checklist_id: ${quote(checklist.id)}, version: ${checklist.version}, mode: "reuse" });
        let j = job;
        while (j.status === "running") { await new Promise((r) => setTimeout(r, 150)); j = await api.getJob(job.id); }
        const [ev] = await api.listEvaluations({ conversation: id });
        if (ev && ev.results.some((r) => r.final_answer === "na")) return id;
      }
      return null;
    })()`);
    assert.ok(found, "some DEV dialogue has an N/A answer");
    await page.eval(`location.hash = "#/c/" + encodeURIComponent(${quote(found)})`);
    await until(page, `document.querySelector(${quote(sel("total"))}) !== null`, "the scorecard of the dialogue with an N/A", 10000);
    await showScorecard(page);
    na = await naCard();
  }
  assert.ok(na, "an N/A card is on screen");
  assert.ok(na.reason.length > 0, "the N/A card shows its reason");
  assert.ok((await page.count(`${sel("crit")}[data-answer="na"] ${sel("answer")}`)) >= 1);
  // back to the first dialogue (its evaluation is stored)
  await page.eval(`location.hash = ${quote(HASH)}`);
  await until(page, `document.querySelector(${quote(sel("total"))}) !== null && document.querySelector(${quote(sel("transcript-title"))}) !== null`, "the first dialogue again", 10000);
  await showScorecard(page);

  // ---- evidence: the link marks the line and brings it into the pane ----
  const link = `${sel("evidence-link")}[data-role="supports"]`;
  assert.ok((await page.count(link)) >= 1, "a card cites a supporting line");
  const index = Number(await page.eval(`document.querySelector(${quote(link)}).getAttribute("data-index")`));
  const criterion = await page.eval(`document.querySelector(${quote(link)}).closest('[data-test="crit"]').getAttribute("data-criterion")`);
  await page.click(link);
  await until(page, `document.querySelector('[data-test="msg"][data-index="${index}"]')?.classList.contains("is-evidence") === true`, "the line to be marked", 3000);
  assert.equal(await page.eval(`document.querySelector('[data-test="msg"][data-index="${index}"]').getAttribute("data-criterion")`), criterion);
  const meets = await page.eval(`(() => {
    const m = document.querySelector('[data-test="msg"][data-index="${index}"]').getBoundingClientRect();
    const p = document.querySelector('[data-test="transcript-pane"]').getBoundingClientRect();
    return m.width > 0 && m.bottom > p.top && m.top < p.bottom && m.right > p.left && m.left < p.right;
  })()`);
  assert.equal(meets, true, "the cited line is inside the transcript pane");
  assert.equal(await page.count(`${sel("msg")}.is-flash`), 1, "the cited line flashes");
  assert.equal(await page.eval(`document.querySelector('[data-criterion="${criterion}"][data-test="crit"]').classList.contains("is-open")`), true, "the card is marked as open");
  await showScorecard(page);

  // ---- «Переоценить всё» runs a full re-grade ----
  await page.click(sel("run-eval-full"));
  await until(page, `document.querySelector(${quote(sel("job-progress"))}).textContent.length > 0`, "the progress of the full run", 3000);
  await until(page, `document.querySelector(${quote(sel("job-progress"))}).textContent === "" && document.querySelector(${quote(sel("run-eval"))}).disabled === false`, "the full run to finish");
  assert.equal(await page.count(sel("crit")), checklist.criteria);

  // ---- «Оспорить»: controller only; an open appeal disables it ----
  assert.equal(await page.count(sel("dispute")), checklist.criteria, "a controller sees the button on every card");
  assert.equal(await page.eval(`[...document.querySelectorAll('[data-test="dispute"]')].every((b) => b.disabled === false && b.textContent === "Оспорить")`), true);
  await page.eval(`window.__cqaTest.store.set({ role: "reviewer" })`);
  assert.equal(await page.count(sel("dispute")), 0, "a reviewer does not get the button");
  await page.eval(`window.__cqaTest.store.set({ role: "controller" })`);
  assert.equal(await page.count(sel("dispute")), checklist.criteria);
  await page.click(`${sel("crit")}[data-criterion="${criterion}"] ${sel("dispute")}`);
  await page.waitFor(sel("appeal-drawer")); // filing through the drawer is covered by 08-appeals
  await page.click(sel("appeal-cancel"));
  await until(page, `document.querySelector(${quote(sel("appeal-drawer"))}) === null`, "the drawer to close");
  const filed = await page.eval(`window.__cqaTest.api.listEvaluations({ conversation: ${quote(ID)} }).then((l) =>
    window.__cqaTest.api.fileAppeal({ evaluation_id: l[0].id, criterion_id: ${quote(criterion)}, comment: "проверка" }).then(() => true))`);
  assert.equal(filed, true);
  await load(page, "appeal=1");
  await page.waitFor(sel("total"), 10000);
  await showScorecard(page);
  assert.equal(await page.eval(`document.querySelector('[data-criterion="${criterion}"][data-test="crit"] [data-test="dispute"]').disabled`), true, "an open appeal disables the button");
  assert.equal(await page.count(`${sel("crit")}[data-criterion="${criterion}"] ${sel("appeal-open")}`), 1);
  assert.equal(await page.eval(`[...document.querySelectorAll('[data-test="dispute"]')].filter((b) => !b.disabled).length`), checklist.criteria - 1, "the other cards stay open to dispute");

  // ---- Review Focus 3: an API fault shows an error toast with a retry; the rest keeps working ----
  await load(page, "mockFault=startEvaluations:network");
  await page.waitFor(sel("total"), 10000);
  await showScorecard(page);
  await page.click(sel("run-eval"));
  await page.waitFor(`${sel("toast")}[data-kind="error"]`, 4000);
  assert.ok((await page.count(sel("toast-retry"))) >= 1, "a retryable error offers a retry");
  assert.equal(await disabled(page, "run-eval"), false, "the run button is usable again");
  assert.equal(await page.count(sel("job-progress")) === 1 && (await page.text(sel("job-progress"))) === "", true, "no progress is left behind");
  assert.ok((await page.count(sel("queue-item"))) > 0, "the queue is still there");
  assert.ok((await page.count(sel("msg"))) > 0, "the transcript is still there");
  assert.equal(await page.count(sel("crit")), checklist.criteria, "the earlier result stays on screen");
  await page.click(sel("toast-retry"));
  await page.waitFor(`${sel("toast")}[data-kind="error"]`, 4000); // the fault is still injected, so it fails again

  // ---- no model key: the run buttons are disabled and say why ----
  await load(page, "mockModelKey=0");
  await showScorecard(page);
  await until(page, `document.querySelector(${quote(sel("run-eval"))}).disabled === true`, "the run button to be disabled");
  assert.equal(await disabled(page, "run-eval-full"), true);
  assert.equal(await page.eval(`document.querySelector(${quote(sel("key-hint"))}).hidden`), false);
  assert.match(await page.text(sel("key-hint")), /нужен ключ модели/);
  assert.match(await page.eval(`document.querySelector(${quote(sel("run-eval"))}).getAttribute("title")`), /нужен ключ модели/);
}
