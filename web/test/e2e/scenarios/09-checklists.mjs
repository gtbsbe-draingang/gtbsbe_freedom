// Checklists, the guide's demo step 4 and control check 2 (R1, R2, R10): open the locked official
// checklist, replace one criterion with a new one, save it as a new checklist (based_on), apply it
// to two selected dialogues with a dry-run estimate, and follow «Сравнить». Counts and states only.
import assert from "node:assert/strict";

export const name = "checklists";
export const path = "/#/checklists";
export const viewports = [
  [1400, 900],
  [600, 800],
];

const sel = (test) => `[data-test="${test}"]`;
const quote = (value) => JSON.stringify(value);
const ESTIMATE = /^(\d+) диалог(а|ов)? · (\d+) вызов(а|ов)? модели · (\d+) из кэша$/;

async function until(page, expression, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!(await page.eval(expression))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await page.sleep(25);
  }
}

// Sets a field's value the way typing would end (replacing what was there) and fires `input`.
async function fill(page, selector, value) {
  await page.eval(`(() => { const el = document.querySelector(${quote(selector)}); el.focus(); el.value = ${quote(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
}

export async function run(page) {
  await page.waitFor(sel("checklist-row"), 10000);

  // Setup through the test hook: two DEV dialogues graded with the official checklist (so the new
  // checklist can reuse answers and be compared), and selected in the queue.
  const setup = await page.eval(`(async () => {
    const api = window.__cqaTest.api;
    await api.importDataset("DEV");
    const { checklist_id, version } = (await api.getConfig()).default_checklist;
    const ids = (await api.listConversations({ group_id: "DEV" })).filter((c) => c.channel === "agent chat").slice(0, 2).map((c) => c.id);
    let job = await api.startEvaluations({ conversations: ids, checklist_id, version, mode: "reuse" });
    while (["queued", "running", "pending", "started"].includes(job.status)) { await new Promise((r) => setTimeout(r, 100)); job = await api.getJob(job.id); }
    window.__cqaTest.store.set({ selection: new Set(ids) });
    const v = await api.getChecklistVersion(checklist_id, version);
    return { checklist_id, version, ids, c05: v.criteria.find((c) => c.id === "c05").title, rows: (await api.listChecklists()).length };
  })()`);

  // ---- the list: the official checklist is locked ----
  const official = `${sel("checklist-row")}[data-id="${setup.checklist_id}"]`;
  await page.waitFor(official);
  assert.equal(await page.count(`${official} ${sel("checklist-locked")}`), 1, "the official checklist is marked locked");
  await page.click(`${official} ${sel("checklist-open")}`);
  await page.waitFor(sel("editor"), 5000);
  await until(page, `document.querySelector(${quote(sel("editor-save"))}) !== null`, "the editor");
  assert.equal(await page.text(sel("editor-save")), "Сохранить как новый чек-лист", "a locked checklist saves as a new one");
  assert.equal(await page.count(sel("weight-sum")), 0, "the official weights add up to 100");

  // ---- replace c05 with a new yes/no criterion ----
  await page.click(`${sel("editor-criterion")}[data-id="c05"] ${sel("remove-criterion")}`);
  await until(page, `document.querySelector(${quote(`${sel("editor-criterion")}[data-id="c05"]`)}) === null`, "c05 to go");
  assert.match(await page.text(sel("removed-list")), new RegExp(setup.c05.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the removal is listed");
  await page.click(`${sel("editor-section")}[data-id="conduct"] ${sel("add-criterion")}`);
  const fresh = `${sel("editor-criterion")}[data-new="true"]`;
  await page.waitFor(fresh);
  assert.equal(await page.text(`${fresh} ${sel("criterion-badge")}`), "новый");
  assert.equal(await page.eval(`document.querySelector(${quote(`${fresh} ${sel("crit-type")}`)}).value`), "yes_no", "a new criterion starts as yes/no");
  await page.waitFor(sel("weight-sum")); // 85 without the new criterion's weight
  assert.equal(await page.eval(`document.querySelector(${quote(sel("editor-save"))}).disabled`), true, "an untitled criterion blocks saving");
  await fill(page, `${fresh} ${sel("crit-title")}`, "Предложил дополнительные услуги");
  await fill(page, `${fresh} ${sel("crit-wording")}`, "Оператор уместно предложил клиенту подходящий продукт или услугу.");
  await fill(page, `${fresh} ${sel("crit-weight")}`, "15");
  await until(page, `document.querySelector(${quote(sel("weight-sum"))}) === null`, "the weight sum to reach 100");
  assert.match(await page.text(sel("editor-diff")), /новых: 1 · удалено: 1/, "the summary counts the change");
  assert.equal(await page.eval(`document.querySelector(${quote(sel("editor-save"))}).disabled`), false);

  // ---- save as a new checklist based on the official one ----
  await page.click(sel("editor-save"));
  await page.waitFor(sel("editor-saved"), 5000);
  const saved = await page.eval(`window.__cqaTest.api.listChecklists().then((rows) => rows.find((r) => r.based_on && r.based_on.checklist_id === ${quote(setup.checklist_id)}))`);
  assert.ok(saved, "the new checklist exists with based_on");
  assert.equal(saved.based_on.version, setup.version);
  assert.match(await page.eval(`location.hash`), new RegExp(`^#/checklists/${encodeURIComponent(saved.checklist_id)}/1`), "the editor moved to the new checklist");
  assert.equal(await page.text(sel("editor-save")), "Сохранить версию", "the copy is unlocked: later saves make versions");

  // ---- apply to the selection: estimate, run, compare ----
  await page.click(sel("open-apply"));
  await page.waitFor(sel("apply-dialog"));
  assert.equal(await page.count(sel("apply-target-all")), 0, "there is no «все» target");
  await page.click(sel("apply-target-selected"));
  await until(page, `${quote(ESTIMATE.source)} && new RegExp(${quote(ESTIMATE.source)}).test(document.querySelector(${quote(sel("apply-estimate"))})?.textContent ?? "")`, "the estimate");
  const estimate = ESTIMATE.exec(await page.text(sel("apply-estimate")));
  assert.equal(estimate[1], "2", "two selected dialogues");
  assert.ok(Number(estimate[3]) > 0, "the new criterion needs model calls");
  assert.ok(Number(estimate[5]) > 0, "the unchanged criteria are reused");
  await page.click(sel("apply-run"));
  await until(page, `document.querySelector(${quote(sel("apply-compare"))}) !== null`, "the run to finish", 15000);
  const compare = await page.eval(`document.querySelector(${quote(sel("apply-compare"))}).getAttribute("href")`);
  assert.match(compare, /^#\/compare\?/);
  assert.match(compare, new RegExp(`from_checklist=${encodeURIComponent(setup.checklist_id)}`));
  assert.match(compare, new RegExp(`to_checklist=${encodeURIComponent(saved.checklist_id)}`));
  await page.click(sel("apply-compare"));
  await until(page, `location.hash.startsWith("#/compare?")`, "the comparison route");

  // ---- the list shows the new checklist and what it is based on ----
  await page.eval(`location.hash = "#/checklists"`);
  await until(page, `document.querySelectorAll(${quote(sel("checklist-row"))}).length === ${setup.rows + 1}`, "the new row");
  assert.equal(await page.count(`${sel("checklist-row")}[data-id="${saved.checklist_id}"] ${sel("checklist-based-on")}`), 1);
}
