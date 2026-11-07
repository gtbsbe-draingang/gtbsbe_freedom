// Appeals, the guide's demo step 3 (R7, R8): a controller disputes a «Нет» on the scorecard, a
// reviewer opens it on the appeals page, sees the second opinion arrive, changes the answer with a
// reason and gets the new total; the card then shows its history. Without a model key, filing
// still works and the second opinion says «недоступно». Counts, states and totals only; no
// dialogue text is printed.
import assert from "node:assert/strict";

export const name = "appeals";
export const path = "/#/";
export const viewports = [
  [1400, 900],
  [600, 800],
];

const sel = (test) => `[data-test="${test}"]`;
const quote = (value) => JSON.stringify(value);
const TOTAL = /^Итог: (\d+,\d{2}|не рассчитывается) → (\d+,\d{2}|не рассчитывается)$/;

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

async function openCard(page, id) {
  await page.eval(`location.hash = "#/c/" + encodeURIComponent(${quote(id)})`);
  await until(page, `document.querySelector(${quote(sel("total"))}) !== null && document.querySelector(${quote(sel("scorecard-loading"))}) === null`, "the scorecard", 10000);
  await showScorecard(page);
}

async function asRole(page, role) {
  await page.click(sel("role-switch"));
  await page.click(sel(`role-option-${role}`));
  await until(page, `window.__cqaTest.store.get().role === ${quote(role)}`, `the ${role} role`);
}

// Evaluates DEV chats through the API until one has a «Нет» on a weighted yes/no criterion, so the
// reviewer's «Да» must raise the total. Returns that dialogue, the criterion and one more criterion.
async function findDisputable(page) {
  return page.eval(`(async () => {
    const api = window.__cqaTest.api;
    const cfg = await api.getConfig();
    const { checklist_id, version } = cfg.default_checklist;
    const v = await api.getChecklistVersion(checklist_id, version);
    const weighted = (id) => { const c = v.criteria.find((x) => x.id === id); return c && c.kind !== "gross_error" && c.answer_type === "yes_no" && c.weight > 0; };
    const ids = (await api.listConversations({ group_id: "DEV" })).filter((c) => c.channel === "agent chat").map((c) => c.id);
    for (const id of ids) {
      let job = await api.startEvaluations({ conversations: [id], checklist_id, version, mode: "reuse" });
      while (["queued", "running", "pending", "started"].includes(job.status)) { await new Promise((r) => setTimeout(r, 100)); job = await api.getJob(job.id); }
      const [ev] = await api.listEvaluations({ conversation: id, checklist_id });
      const hit = ev && ev.results.find((r) => r.final_answer === "no" && weighted(r.criterion_id));
      const rest = ev && ev.results.filter((r) => r.criterion_id !== hit?.criterion_id).map((r) => r.criterion_id);
      if (hit && rest.length >= 2) return { id, criterion: hit.criterion_id, other: rest[0], third: rest[1], total: ev.final_total };
    }
    return null;
  })()`);
}

const money = (value) => (value === null ? "не рассчитывается" : value.toFixed(2).replace(".",","));

export async function run(page) {
  await page.waitFor(sel("queue-item"), 10000);
  const target = await findDisputable(page);
  assert.ok(target, "some DEV chat has a «Нет» on a weighted yes/no criterion");
  const card = `${sel("crit")}[data-criterion="${target.criterion}"]`;

  // ---- controller: «Оспорить» opens the drawer; the comment is required ----
  await openCard(page, target.id);
  assert.equal(await page.eval(`window.__cqaTest.store.get().role`), "controller");
  await page.click(`${card} ${sel("dispute")}`);
  await page.waitFor(sel("appeal-drawer"));
  assert.equal(await page.eval(`document.querySelector(${quote(sel("appeal-criterion"))}).value`), target.criterion, "the drawer is pre-filled with the disputed criterion");
  assert.ok((await page.count(`${sel("appeal-criterion")} option`)) > 1, "the criterion can be changed");
  assert.equal(await page.eval(`document.querySelector(${quote(sel("appeal-submit"))}).disabled`), true, "no appeal without a comment");
  await page.type(sel("appeal-comment"), "   ");
  assert.equal(await page.eval(`document.querySelector(${quote(sel("appeal-submit"))}).disabled`), true, "blanks are not a comment");
  await page.type(sel("appeal-comment"), "Оператор выполнил требование, ответ «Нет» ошибочен.");
  assert.equal(await page.eval(`document.querySelector(${quote(sel("appeal-submit"))}).disabled`), false);
  await page.click(sel("appeal-submit"));
  await until(page, `document.querySelector(${quote(sel("appeal-drawer"))}) === null`, "the drawer to close");
  await until(page, `document.querySelector(${quote(`${card} ${sel("appeal-open")}`)}) !== null`, "the open-appeal tag");
  assert.equal(await page.eval(`document.querySelector(${quote(`${card} ${sel("dispute")}`)}).disabled`), true, "an open appeal disables «Оспорить»");
  const appeals = await page.eval(`window.__cqaTest.api.listAppeals({ status: "open" })`);
  assert.equal(appeals.length, 1, "one appeal was filed");
  assert.equal(appeals[0].criterion_id, target.criterion);
  assert.equal(appeals[0].role, "controller");

  // ---- reviewer: the appeals page, the review panel, the second opinion ----
  await asRole(page, "reviewer");
  await page.eval(`location.hash = "#/appeals"`);
  await page.waitFor(sel("appeals-list"), 5000);
  await page.waitFor(`${sel("appeal-row")}[data-id="${appeals[0].id}"]`, 5000);
  await page.click(sel("appeals-filter-all"));
  await page.eval(`document.querySelector(${quote(sel("appeals-page"))}).__kept = true`);
  await page.click(`${sel("appeal-row")}[data-id="${appeals[0].id}"] a`);
  await page.waitFor(sel("review-panel"), 5000);
  await until(page, `document.querySelector(${quote(sel("review-comment"))}) !== null`, "the panel to load");
  assert.equal(await page.eval(`document.querySelector(${quote(sel("appeals-page"))}).__kept === true`), true, "opening an appeal keeps the page (no reload)");
  assert.equal(await page.eval(`document.querySelector(${quote(sel("appeals-filter-all"))}).getAttribute("aria-pressed")`), "true", "and keeps the chosen filter");
  assert.match(await page.text(sel("review-comment")), /ошибочен/, "the reviewer sees the comment");
  assert.ok((await page.count(`${sel("review-fragment")} ${sel("fragment-msg")}`)) > 0, "the reviewer sees the dialogue fragment");
  assert.equal(await page.count(sel("review-card-link")), 1, "the panel links to the full card");
  assert.equal(await page.eval(`document.querySelector(${quote(sel("second-opinion"))}).getAttribute("data-state")`), "pending", "the second opinion starts pending");
  await until(page, `document.querySelector(${quote(sel("second-opinion"))}).getAttribute("data-state") === "done"`, "the second opinion", 6000);
  assert.ok((await page.text(sel("second-opinion"))).length > 0);

  // ---- the decision: «Изменить» → «Да» with a reason; the total is recalculated ----
  await page.click(sel("decision-change"));
  await page.waitFor(sel("decision-answer"));
  await page.eval(`(() => { const s = document.querySelector(${quote(sel("decision-answer"))}); s.value = "yes"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  assert.equal(await page.eval(`document.querySelector(${quote(sel("decision-submit"))}).disabled`), true, "no decision without a reason");
  await page.type(sel("decision-reason"), "Требование выполнено в первом ответе.");
  // Fault injection (review of #63): the decision is saved, but the first read after it fails.
  // Recovery must re-read, never post the decision again.
  await page.eval(`(() => {
    const api = window.__cqaTest.api;
    const realDecide = api.decideAppeal;
    const realGet = api.getAppeal;
    let armed = false;
    window.__decides = 0;
    api.decideAppeal = (...args) => (window.__decides += 1, realDecide(...args).then((r) => ((armed = true), r)));
    api.getAppeal = (...args) => {
      if (armed) { armed = false; return Promise.reject(Object.assign(new Error("offline"), { code: "network", retryable: true })); }
      return realGet(...args);
    };
  })()`);
  await page.click(sel("decision-submit"));
  await page.waitFor(`${sel("toast")}[data-kind="error"] ${sel("toast-retry")}`, 5000);
  assert.equal(await page.count(sel("decision-submit")), 0, "a saved decision is not offered again while the panel re-reads");
  await page.click(`${sel("toast")}[data-kind="error"] ${sel("toast-retry")}`);
  await page.waitFor(sel("decision-result"), 5000);
  assert.equal(await page.eval(`window.__decides`), 1, "a failed read after the decision never posts it again");
  const result = TOTAL.exec(await page.text(sel("decision-result")));
  assert.ok(result, "the panel shows «Итог: old → new»");
  assert.equal(result[1], money(target.total), "the old total is the one before the decision");
  assert.notEqual(result[2], result[1], "changing «Нет» to «Да» changes the total");
  assert.equal(await page.text(sel("review-answer")), "Нет", "the model's answer stays visible");
  assert.equal(await page.text(sel("review-final-answer")), "Да", "next to the answer after the decision, which the points follow");
  const decided = await page.eval(`window.__cqaTest.api.getAppeal(${quote(appeals[0].id)})`);
  assert.equal(decided.status, "decided");
  assert.equal(decided.decision.outcome, "changed");
  assert.equal(decided.decision.role, "reviewer");

  // ---- the card: the new total and the history ----
  await page.click(sel("review-card-link"));
  await until(page, `document.querySelector(${quote(sel("total"))}) !== null && document.querySelector(${quote(sel("history"))}) !== null`, "the card with its history", 10000);
  await showScorecard(page);
  assert.equal(await page.text(sel("total")), result[2], "the card shows the new total");
  const kinds = await page.eval(`[...document.querySelectorAll('[data-test="history-item"]')].map((i) => i.getAttribute("data-kind"))`);
  assert.equal(kinds[0], "original", "history starts with the original total");
  assert.ok(kinds.includes("appeal") && kinds.includes("decision"), "history lists the appeal and its decision");
  assert.equal(kinds[kinds.length - 1], "final", "history ends with the final total");
  assert.equal(await page.count(sel("dispute")), 0, "a reviewer does not dispute");

  // ---- a new run carries the decision; the card says so and links to the appeal ----
  await asRole(page, "controller");
  await showScorecard(page);
  await page.click(sel("run-eval"));
  await until(page, `document.querySelector(${quote(sel("job-progress"))}).textContent === "" && document.querySelector(${quote(sel("run-eval"))}).disabled === false && document.querySelector(${quote(`${card} ${sel("carried")}`)}) !== null`, "the re-run with the carried decision", 10000);
  assert.equal(await page.eval(`document.querySelector(${quote(`${card} ${sel("carried")}`)}).getAttribute("href")`), `#/appeals/${encodeURIComponent(appeals[0].id)}`, "the carried tag links to the original appeal");
  assert.equal(await page.text(sel("total")), result[2], "the carried decision keeps the new total");
  assert.ok((await page.eval(`[...document.querySelectorAll('[data-test="history-item"]')].map((i) => i.getAttribute("data-kind"))`)).includes("carried"), "the history lists the carried decision");

  // ---- an open appeal survives a re-run: still shown, and no second appeal on that criterion ----
  const otherCard = `${sel("crit")}[data-criterion="${target.other}"]`;
  await page.click(`${otherCard} ${sel("dispute")}`);
  await page.waitFor(sel("appeal-drawer"));
  await page.type(sel("appeal-comment"), "Прошу пересмотреть.");
  await page.click(sel("appeal-submit"));
  await until(page, `document.querySelector(${quote(`${otherCard} ${sel("appeal-open")}`)}) !== null`, "the second appeal's tag");
  await page.click(sel("run-eval-full"));
  await until(page, `document.querySelector(${quote(sel("job-progress"))}).textContent === "" && document.querySelector(${quote(sel("run-eval"))}).disabled === false && document.querySelector(${quote(`${otherCard} ${sel("appeal-open-earlier")}`)}) !== null`, "the re-run that keeps the open appeal in view", 10000);
  assert.equal(await page.eval(`document.querySelector(${quote(`${otherCard} ${sel("dispute")}`)}).disabled`), true, "no second appeal on a criterion with an open one");
  assert.ok((await page.eval(`[...document.querySelectorAll('[data-test="history-item"]')].map((i) => i.getAttribute("data-kind"))`)).includes("earlier-open"), "the history lists the appeal on the earlier evaluation");
  // the drawer opened from another criterion must not offer it either (review of #63)
  await page.click(`${sel("crit")}[data-criterion="${target.third}"] ${sel("dispute")}`);
  await page.waitFor(sel("appeal-drawer"));
  const offered = await page.eval(`[...document.querySelectorAll('[data-test="appeal-criterion"] option')].map((o) => o.value)`);
  assert.ok(offered.includes(target.third), "the drawer offers the criterion it was opened from");
  assert.ok(!offered.includes(target.other), "the drawer does not offer a criterion with an open appeal on an earlier evaluation");
  await page.click(sel("appeal-cancel"));
  await until(page, `document.querySelector(${quote(sel("appeal-drawer"))}) === null`, "the drawer to close");

  // ---- no model key: filing still works; the second opinion is «недоступно» ----
  await page.goto(`/?mockModelKey=0#/c/${encodeURIComponent(target.id)}`);
  await until(page, `document.querySelector(${quote(sel("total"))}) !== null && document.querySelector(${quote(sel("scorecard-loading"))}) === null`, "the scorecard without a key", 10000);
  await showScorecard(page);
  await until(page, `window.__cqaTest.store.get().role !== undefined`, "the store");
  if ((await page.eval(`window.__cqaTest.store.get().role`)) !== "controller") await asRole(page, "controller");
  await showScorecard(page);
  await page.click(`${sel("crit")}[data-criterion="${target.third}"] ${sel("dispute")}`);
  await page.waitFor(sel("appeal-drawer"));
  await page.type(sel("appeal-comment"), "Прошу пересмотреть.");
  await page.click(sel("appeal-submit"));
  await until(page, `document.querySelector(${quote(sel("appeal-drawer"))}) === null`, "the drawer to close without a key");
  const [keyless] = await page.eval(`window.__cqaTest.api.listAppeals({ status: "open" })`);
  assert.equal(keyless.criterion_id, target.third, "the appeal was filed without a model key");
  await page.eval(`location.hash = "#/appeals/" + encodeURIComponent(${quote(keyless.id)})`);
  await page.waitFor(sel("second-opinion"), 5000);
  assert.equal(await page.eval(`document.querySelector(${quote(sel("second-opinion"))}).getAttribute("data-state")`), "unavailable");
  assert.match(await page.text(sel("second-opinion")), /недоступно/);
  assert.equal(await page.count(sel("decision-readonly")), 1, "a controller sees the decision area read-only");
  assert.equal(await page.count(sel("decision-submit")), 0);
}
