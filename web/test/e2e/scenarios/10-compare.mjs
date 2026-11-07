// The before/after comparison (extra 1, protected; the guide's demo step 4 ends here). The Task 13
// drill first: the official checklist with c05 replaced by a new criterion, saved as a new checklist
// based on it (through the API), applied to three selected dialogues through the apply dialog;
// then its «Сравнить» link. The summary counts the rows whose total changed, the table sorts, and a
// row opens both results side by side, changed criteria only, with the replaced criterion on one
// side only. Counts and states only; no dialogue text is printed.
import assert from "node:assert/strict";

export const name = "compare";
export const path = "/#/checklists";
export const viewports = [
  [1400, 900],
  [600, 800],
];

const sel = (test) => `[data-test="${test}"]`;
const quote = (value) => JSON.stringify(value);
const SUMMARY = /^(\d+) из (\d+) диалог(а|ов)? изменил(ся|ись), в среднем ([−+]?\d+,\d\d|—)$/;

async function until(page, expression, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!(await page.eval(expression))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await page.sleep(25);
  }
}

// The table as the page shows it: one {id, delta} per row, in order (delta null for «—»).
const tableRows = (page) =>
  page.eval(`[...document.querySelectorAll(${quote(sel("compare-row"))})].map((r) => ({ id: r.getAttribute("data-id"), delta: r.getAttribute("data-delta") === "" ? null : Number(r.getAttribute("data-delta")) }))`);

export async function run(page) {
  await page.waitFor(sel("checklist-row"), 10000);

  // ---- the drill: grade three DEV chats with the official checklist, save the replaced copy ----
  const setup = await page.eval(`(async () => {
    const api = window.__cqaTest.api;
    await api.importDataset("DEV");
    const { checklist_id, version } = (await api.getConfig()).default_checklist;
    const ids = (await api.listConversations({ group_id: "DEV" })).filter((c) => c.channel === "agent chat").slice(0, 3).map((c) => c.id);
    let job = await api.startEvaluations({ conversations: ids, checklist_id, version, mode: "reuse" });
    while (["queued", "running", "pending", "started"].includes(job.status)) { await new Promise((r) => setTimeout(r, 100)); job = await api.getJob(job.id); }
    const v = await api.getChecklistVersion(checklist_id, version);
    const criteria = v.criteria.filter((c) => c.id !== "c05").map(({ fingerprint, ...c }) => c);
    criteria.push({ section_id: "conduct", title: "Предложил дополнительные услуги", wording: "Оператор уместно предложил клиенту подходящий продукт или услугу.", answer_type: "yes_no", scale_steps: [], weight: 15, na_allowed: false, na_condition: null, kind: "scored", kinds: [], guidance: null });
    const copy = await api.createChecklist({
      based_on: { checklist_id, version },
      name: "Чек-лист для сравнения",
      description: v.description ?? null,
      channel: v.channel ?? "any",
      guidance: v.guidance ?? "",
      rounding: v.rounding ?? 2,
      sections: v.sections.map((s) => ({ id: s.id, title: s.title, order: s.order })),
      criteria: criteria.map((c, i) => ({ ...c, order: i + 1 })),
    });
    window.__cqaTest.store.set({ selection: new Set(ids) });
    const added = copy.criteria.find((c) => !v.criteria.some((o) => o.id === c.id)).id;
    return { checklist_id, version, ids, copy: { id: copy.checklist_id, version: copy.version, name: copy.name }, added };
  })()`);

  // ---- apply the copy to the selection, then «Сравнить» ----
  await page.eval(`location.hash = ${quote(`#/checklists/${encodeURIComponent(setup.copy.id)}/${setup.copy.version}/edit`)}`);
  await page.waitFor(sel("open-apply"), 5000);
  await page.click(sel("open-apply"));
  await page.waitFor(sel("apply-target-selected"));
  await page.click(sel("apply-target-selected"));
  await until(page, `/из кэша$/.test(document.querySelector(${quote(sel("apply-estimate"))})?.textContent ?? "") && !document.querySelector(${quote(sel("apply-run"))}).disabled`, "the estimate");
  await page.click(sel("apply-run"));
  await page.waitFor(sel("apply-compare"), 15000);
  await page.click(sel("apply-compare"));
  await until(page, `location.hash.startsWith("#/compare?")`, "the comparison route");

  // ---- the page: what is compared, the summary, the table ----
  await page.waitFor(sel("compare-page"), 5000);
  await until(page, `document.querySelectorAll(${quote(sel("compare-row"))}).length === 3`, "three rows (the selection)");
  assert.match(await page.text(sel("compare-note")), /сравниваются итоговые баллы \(с решениями проверяющих\)/i);
  assert.match(await page.text(sel("compare-to")), new RegExp(setup.copy.name), "the new side names the copy");
  const summary = SUMMARY.exec(await page.text(sel("compare-summary")));
  assert.ok(summary, `the summary reads «N из M диалогов изменились, в среднем ±X.XX», got «${await page.text(sel("compare-summary"))}»`);
  const rows = await tableRows(page);
  assert.equal(Number(summary[2]), rows.length, "the summary's total is the row count");
  assert.equal(Number(summary[1]), rows.filter((r) => r.delta !== null && r.delta !== 0).length, "the summary counts the rows with delta != 0");
  assert.deepEqual(rows.map((r) => r.id).sort(), [...setup.ids].sort(), "the rows are the dialogues the copy was applied to");

  // ---- sorting: by delta (the default, ascending), then flipped; by id ----
  const deltas = rows.map((r) => r.delta).filter((d) => d !== null);
  assert.deepEqual(deltas, [...deltas].sort((a, b) => a - b), "the default order is by delta, ascending");
  await page.click(`${sel("compare-sort")}[data-key="delta"]`);
  const flipped = (await tableRows(page)).map((r) => r.delta).filter((d) => d !== null);
  assert.deepEqual(flipped, [...deltas].sort((a, b) => b - a), "a second click on «Δ» flips the order");
  assert.equal(await page.eval(`document.querySelector(${quote(`${sel("compare-sort")}[data-key="delta"]`)}).closest("th").getAttribute("aria-sort")`), "descending");
  await page.click(`${sel("compare-sort")}[data-key="id"]`);
  const byId = await page.eval(`[...document.querySelectorAll(${quote(sel("compare-row"))})].map((r) => r.querySelector('[data-test="compare-id"]').textContent)`);
  assert.deepEqual(byId, [...byId].sort((a, b) => a.localeCompare(b)), "«Диалог» sorts by id");

  // ---- a row opens both results side by side ----
  assert.equal(await page.count(sel("compare-side")), 0, "no card before a row is picked");
  const first = (await tableRows(page))[0].id;
  await page.click(`${sel("compare-row")}[data-id="${first}"] ${sel("compare-open")}`);
  await page.waitFor(sel("compare-side"), 5000);
  await until(page, `document.querySelectorAll(${quote(`${sel("compare-side")} ${sel("compare-crit")}`)}).length > 0`, "the criteria of the card");
  const crit = (id) => `${sel("compare-side")} ${sel("compare-crit")}[data-id="${id}"]`;
  assert.equal(await page.eval(`document.querySelector(${quote(crit("c05"))})?.getAttribute("data-side")`), "old", "the replaced criterion is on the old side only");
  assert.equal(await page.eval(`document.querySelector(${quote(crit(setup.added))})?.getAttribute("data-side")`), "new", "the new criterion is on the new side only");
  assert.equal(await page.count(`${crit("c05")} ${sel("compare-new")} ${sel("compare-answer")}`), 0, "no new answer for the removed criterion");
  assert.equal(await page.count(`${crit(setup.added)} ${sel("compare-old")} ${sel("compare-answer")}`), 0, "no old answer for the added criterion");
  const changedOnly = await page.count(`${sel("compare-side")} ${sel("compare-crit")}`);
  assert.equal(await page.eval(`[...document.querySelectorAll(${quote(`${sel("compare-side")} ${sel("compare-crit")}`)})].every((r) => r.getAttribute("data-changed") === "true")`), true, "changed criteria only by default");
  await page.click(sel("compare-all"));
  await until(page, `document.querySelectorAll(${quote(`${sel("compare-side")} ${sel("compare-crit")}`)}).length > ${changedOnly}`, "every criterion after «Показать все критерии»");
  assert.equal(await page.count(`${sel("compare-side")} ${sel("compare-crit")}[data-side="both"][data-changed="false"]`) > 0, true, "unchanged criteria are shown on both sides");
  assert.match(await page.eval(`document.querySelector(${quote(`${sel("compare-side")} ${sel("compare-link")}`)}).getAttribute("href")`), new RegExp(`^#/c/${encodeURIComponent(first).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "the card links to the dialogue");

  // ---- a card still loading when the comparison changes is dropped, not drawn under the new one ----
  await page.eval(`(() => {
    const api = window.__cqaTest.api;
    const real = api.listEvaluations;
    api.listEvaluations = (filters) => new Promise((r) => setTimeout(r, 600)).then(() => real(filters));
  })()`);
  const second = (await tableRows(page))[1].id;
  await page.click(`${sel("compare-row")}[data-id="${second}"] ${sel("compare-open")}`);
  await page.waitFor(sel("compare-side-loading"));
  await page.eval(`(() => { const s = document.querySelector(${quote(sel("compare-group"))}); s.value = "DEV"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await until(page, `location.hash.includes("group_id=DEV") && document.querySelectorAll(${quote(sel("compare-row"))}).length === 3`, "the comparison for DEV");
  await page.sleep(900); // the held card request has come back by now
  assert.equal(await page.count(sel("compare-side")), 0, "the card of the previous comparison is not drawn");
}
