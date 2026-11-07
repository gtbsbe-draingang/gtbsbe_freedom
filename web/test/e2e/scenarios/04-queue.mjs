// The workspace queue: rows from the DEV import, the calls filter, search by id, a click that
// opens the conversation, the selection checkboxes, the language filter, and the same
// conversation_id in two groups (Review Focus 2).
import assert from "node:assert/strict";

export const name = "queue";
export const path = "/";
export const viewports = [
  [1400, 900],
  [600, 800],
];

const sel = (test) => `[data-test="${test}"]`;
const quote = (value) => JSON.stringify(value);
const visible = (page, selector) =>
  page.eval(`(() => { const el = document.querySelector(${quote(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; })()`);

// Below 900 px the queue is a drawer; open it when it is closed.
async function openQueue(page) {
  if (!(await visible(page, sel("queue-pane")))) await page.click(sel("queue-toggle"));
  await page.waitFor(sel("queue-pane"));
}

const rowIds = (page) => page.eval(`[...document.querySelectorAll('[data-test="queue-item"]')].map((el) => el.getAttribute("data-id"))`);
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && b.every((id) => a.includes(id));

// Waits until a page expression is truthy (the route follows the hash on an event, not at once).
async function until(page, expression, what) {
  const deadline = Date.now() + 3000;
  while (!(await page.eval(expression))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await page.sleep(25);
  }
}

async function waitForRows(page, expected, what) {
  const deadline = Date.now() + 4000;
  for (;;) {
    const ids = await rowIds(page);
    if (expected(ids)) return ids;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; ${ids.length} rows`);
    await page.sleep(40);
  }
}

export async function run(page) {
  const narrow = page.viewport[0] < 900;
  await page.waitFor(sel("queue-item"), 10000); // the first load imports DEV
  if (narrow) await openQueue(page);

  // ---- rows ----
  const all = await page.eval(`window.__cqaTest.api.listConversations()`);
  assert.ok(all.length > 0, "the DEV import gave no conversations");
  assert.ok(sameSet(await rowIds(page), all.map((item) => item.id)), "one row per conversation");
  assert.equal(await page.count(sel("queue-group")), 0, "one group loaded: rows do not name it");
  assert.equal(await page.count(sel("queue-select")), all.length);
  assert.match(await page.text(sel("queue-count")), new RegExp(`${all.length}\\D+${all.length}`));
  const first = all[0];
  const firstRow = `${sel("queue-item")}[data-id=${quote(first.id)}]`;
  assert.match(await page.text(firstRow), new RegExp(first.conversation_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(await page.count(`${firstRow} ${sel("queue-score")}`), 1);

  // ---- a row without info.topic shows the first client line, at most 80 characters ----
  const topicless = all.slice(0, 6).find((item) => !(typeof item.info?.topic === "string" && item.info.topic.trim() !== ""));
  if (topicless) {
    const topic = `${sel("queue-item")}[data-id=${quote(topicless.id)}] ${sel("queue-topic")}`;
    await until(page, `document.querySelector(${quote(topic)})?.textContent.trim() !== ""`, "the first client line");
    const line = await page.text(topic);
    assert.ok(line.length > 0 && line.length <= 80, `the topic line is ${line.length} characters`);
  }

  // ---- «Звонки» shows only calls ----
  const calls = all.filter((item) => item.channel === "voice call").map((item) => item.id);
  const chats = all.filter((item) => item.channel === "agent chat").map((item) => item.id);
  await page.click(sel("queue-filter-calls"));
  assert.ok(sameSet(await rowIds(page), calls), "the calls filter shows exactly the calls");
  assert.equal(await page.eval(`document.querySelector(${quote(sel("queue-filter-calls"))}).getAttribute("aria-pressed")`), "true");
  assert.equal(await page.eval(`[...document.querySelectorAll('[data-test="queue-item"]')].every((el) => el.getAttribute("data-channel") === "voice call")`), true);
  assert.match(await page.text(sel("queue-filter-calls")), new RegExp(String(calls.length)));
  await page.click(sel("queue-filter-chats"));
  assert.ok(sameSet(await rowIds(page), chats), "the chats filter shows exactly the chats");
  await page.click(sel("queue-filter-all"));
  assert.equal((await rowIds(page)).length, all.length);

  // ---- search by id narrows to 1 ----
  // A conversation id that is not part of any other id, so exactly one row can match.
  const lower = (text) => text.toLowerCase();
  const unique = all.find((item) => all.filter((other) => lower(other.id).includes(lower(item.conversation_id))).length === 1);
  assert.ok(unique, "no conversation has an id of its own");
  await page.type(sel("queue-search"), unique.conversation_id);
  assert.deepEqual(await rowIds(page), [unique.id]);
  assert.match(await page.text(sel("queue-count")), /^Показано 1 из /);
  // a text that matches nothing shows the empty message, not a blank list
  await page.eval(`(() => { const el = document.querySelector(${quote(sel("queue-search"))}); el.value = "zzzz-no-such-id-zzzz"; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await page.waitFor(sel("queue-nomatch"));
  assert.equal((await rowIds(page)).length, 0);
  await page.eval(`(() => { const el = document.querySelector(${quote(sel("queue-search"))}); el.value = ${quote(unique.conversation_id)}; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  assert.deepEqual(await rowIds(page), [unique.id]);

  // ---- a click opens the conversation ----
  const row = `${sel("queue-item")}[data-id=${quote(unique.id)}]`;
  await page.click(row);
  assert.equal(await page.eval("location.hash"), `#/c/${encodeURIComponent(unique.id)}`);
  assert.match(await page.eval("location.hash"), /^#\/c\/DEV%3A/);
  await until(page, `window.__cqaTest.store.get().route.params.id === ${quote(unique.id)}`, "the route to follow the click");
  if (narrow) await openQueue(page);
  assert.equal(await page.count(`${row}.is-current`), 1, "the open conversation is marked");
  assert.equal(await page.count(`${sel("queue-item")}.is-current`), 1);
  // clearing the search brings every row back
  await page.eval(`(() => { const el = document.querySelector(${quote(sel("queue-search"))}); el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  assert.equal((await rowIds(page)).length, all.length);

  // ---- the checkbox selects without opening ----
  const hashBefore = await page.eval("location.hash");
  const pick = `${row} ${sel("queue-select")}`;
  await page.click(pick);
  assert.deepEqual(await page.eval(`[...window.__cqaTest.store.get().selection]`), [unique.id]);
  assert.equal(await page.eval(`document.querySelector(${quote(pick)}).checked`), true);
  assert.equal(await page.eval("location.hash"), hashBefore, "ticking a row does not open it");
  await page.click(pick);
  assert.deepEqual(await page.eval(`[...window.__cqaTest.store.get().selection]`), []);
  // a selection made elsewhere shows in the checkboxes
  await page.eval(`window.__cqaTest.store.set({ selection: new Set([${quote(first.id)}]) })`);
  assert.equal(await page.eval(`document.querySelector(${quote(`${firstRow} ${sel("queue-select")}`)}).checked`), true);
  await page.eval(`window.__cqaTest.store.set({ selection: new Set() })`);

  // ---- language filter ----
  const languages = [...new Set(all.map((item) => item.language))].sort();
  const options = await page.eval(`[...document.querySelector(${quote(sel("queue-language"))}).options].map((option) => option.value)`);
  assert.deepEqual(options, ["", ...languages]);
  const lang = languages[0];
  await page.eval(`(() => { const el = document.querySelector(${quote(sel("queue-language"))}); el.value = ${quote(lang)}; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  assert.ok(sameSet(await rowIds(page), all.filter((item) => item.language === lang).map((item) => item.id)), "the language filter narrows the rows");
  await page.eval(`(() => { const el = document.querySelector(${quote(sel("queue-language"))}); el.value = ""; el.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  assert.equal((await rowIds(page)).length, all.length);

  // ---- Review Focus 2: the same conversation_id in two groups ----
  const imported = await page.eval(`window.__cqaTest.api.importDataset("CTRL")`);
  assert.equal(imported.group_id, "CTRL");
  await page.eval(`window.__cqaTest.store.set((state) => ({ queueRefresh: state.queueRefresh + 1 }))`);
  await waitForRows(page, (ids) => ids.some((id) => id.startsWith("CTRL:")), "the CTRL rows");

  const both = await page.eval(`window.__cqaTest.api.listConversations()`);
  const byConversation = new Map();
  for (const item of both) byConversation.set(item.conversation_id, [...(byConversation.get(item.conversation_id) ?? []), item]);
  const twins = [...byConversation.values()].find((items) => new Set(items.map((item) => item.group_id)).size === 2);
  assert.ok(twins, "DEV and CTRL share no conversation_id (the contract examples reuse p1-ru-001)");
  assert.equal(await page.count(sel("queue-group")), both.length, "with two groups every row names its group");
  const [a, b] = twins;
  assert.notEqual(a.id, b.id);
  for (const twin of twins) {
    const twinRow = `${sel("queue-item")}[data-id=${quote(twin.id)}]`;
    assert.equal(await page.count(twinRow), 1, `${twin.id} has its own row`);
    assert.equal((await page.text(`${twinRow} ${sel("queue-group")}`)).trim(), twin.group_id);
  }
  // searching the shared id finds both rows
  await page.eval(`(() => { const el = document.querySelector(${quote(sel("queue-search"))}); el.value = ${quote(a.conversation_id)}; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  const found = await rowIds(page);
  assert.ok(found.includes(a.id) && found.includes(b.id), "both rows match the shared conversation_id");
  // ticking one never ticks the other
  const pickA = `${sel("queue-item")}[data-id=${quote(a.id)}] ${sel("queue-select")}`;
  const pickB = `${sel("queue-item")}[data-id=${quote(b.id)}] ${sel("queue-select")}`;
  await page.click(pickA);
  assert.deepEqual(await page.eval(`[...window.__cqaTest.store.get().selection]`), [a.id]);
  assert.equal(await page.eval(`document.querySelector(${quote(pickA)}).checked`), true);
  assert.equal(await page.eval(`document.querySelector(${quote(pickB)}).checked`), false);
  // opening one opens that group's conversation
  await page.click(`${sel("queue-item")}[data-id=${quote(b.id)}]`);
  await until(page, `window.__cqaTest.store.get().route.params.id === ${quote(b.id)}`, "the route to follow the click");
  assert.equal(await page.eval("window.__cqaTest.store.get().groupId"), b.group_id);

  // ---- a failed load: a visible error with a retry, and the rest of the page keeps working ----
  await page.goto("/?mockFault=listConversations:network");
  await page.waitFor(sel("queue-pane"));
  if (narrow) await openQueue(page);
  await page.waitFor(sel("queue-error"));
  assert.match(await page.text(sel("queue-error")), /Нет связи с сервером/);
  assert.equal(await page.count(sel("queue-item")), 0);
  await page.click(sel("queue-retry"));
  await page.waitFor(sel("queue-error")); // still failing: the message stays, the pane is not blank
  assert.equal(await page.count(sel("queue-retry")), 1);
  if (narrow) await page.click(sel("queue-scrim"));
  await page.click(sel("nav-checklists"));
  await until(page, `window.__cqaTest.store.get().route.name === "checklists"`, "the nav to work");
}
