// The transcript pane: bubbles by speaker, system notes, evidence highlights that keep the scroll
// position, focusMessage on a normal and on the longest call (Review Focus 4), and records the
// pane has to survive: an empty transcript and an unknown speaker (Review Focus 1).
// Counts and geometry only; no dialogue text is printed.
import assert from "node:assert/strict";

export const name = "transcript";
export const path = "/#/c/DEV%3Ap1-ru-001";
export const viewports = [
  [1400, 900],
  [600, 800],
];

const sel = (test) => `[data-test="${test}"]`;
const quote = (value) => JSON.stringify(value);

async function until(page, expression, what, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!(await page.eval(expression))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await page.sleep(25);
  }
}

// Opens a conversation by hash and waits until the transcript pane shows it.
async function open(page, id) {
  await page.eval(`location.hash = ${quote(`#/c/${encodeURIComponent(id)}`)}`);
  await until(page, `window.__cqaTest.store.get().route.params.id === ${quote(id)}`, "the route");
  await until(page, `document.querySelector(${quote(sel("transcript-title"))}) !== null`, `the transcript of ${id}`);
}

// A message is "in view" when it lies inside the pane's scroller (and so inside the pane).
const inView = (page, index) =>
  page.eval(`(() => {
    const el = document.querySelector('[data-test="msg"][data-index="${index}"]');
    const list = document.querySelector('[data-test="transcript-list"]');
    const pane = document.querySelector('[data-test="transcript-pane"]');
    if (!el || !list || !pane) return { ok: false, why: "missing" };
    const m = el.getBoundingClientRect(), l = list.getBoundingClientRect(), p = pane.getBoundingClientRect();
    const inside = m.top >= l.top - 1 && m.bottom <= l.bottom + 1;
    const meets = m.bottom > p.top && m.top < p.bottom && m.right > p.left && m.left < p.right;
    return { ok: inside && meets, why: { top: m.top, bottom: m.bottom, listTop: l.top, listBottom: l.bottom } };
  })()`);

const noOverflow = (page) =>
  page.eval(`(() => {
    const list = document.querySelector('[data-test="transcript-list"]');
    const l = list.getBoundingClientRect();
    const wide = [...list.querySelectorAll('[data-test="msg"]')].filter((el) => el.getBoundingClientRect().right > l.right + 1);
    return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, list: list.scrollWidth - list.clientWidth, wide: wide.length };
  })()`);

export async function run(page) {
  await page.waitFor(sel("msg"), 10000);

  // ---- a real dialogue: one bubble per line, the last one can be focused ----
  const conversation = await page.eval(`window.__cqaTest.api.getConversation("DEV:p1-ru-001").then((c) => ({ n: c.transcript.length, id: c.conversation_id }))`);
  assert.equal(await page.count(sel("msg")), conversation.n, "one message per line");
  assert.equal(await page.text(sel("transcript-title")), conversation.id);
  assert.equal(await page.eval(`[...document.querySelectorAll('[data-test="msg"]')].every((el, i) => el.getAttribute("data-index") === String(i))`), true, "data-index runs 0..n-1");
  assert.equal(await page.eval(`typeof window.__cqaTest.transcript.focusMessage + typeof window.__cqaTest.transcript.highlight`), "functionfunction");
  assert.equal(await page.eval(`window.__cqaTest.store.get().transcript !== null`), true, "the handle is published in the store");

  assert.equal(await page.eval(`window.__cqaTest.transcript.focusMessage(${conversation.n - 1})`), true);
  assert.equal(await page.count(`${sel("msg")}.is-flash`), 1, "the focused line flashes");
  assert.equal((await inView(page, conversation.n - 1)).ok, true, "the last message is inside the pane");
  assert.equal(await page.eval(`window.__cqaTest.transcript.focusMessage(${conversation.n})`), false, "no such message");
  assert.equal(await page.eval(`window.__cqaTest.transcript.focusMessage(-1)`), false);
  assert.equal(await page.eval(`window.__cqaTest.transcript.focusMessage(1.5)`), false);
  await until(page, `document.querySelectorAll('[data-test="msg"].is-flash').length === 0`, "the flash to end", 2500);

  // ---- the longest call: no horizontal overflow, line 100 comes into view (Review Focus 4) ----
  const longest = await page.eval(`(async () => {
    const list = await window.__cqaTest.api.listConversations();
    let best = { id: null, n: -1 };
    for (const item of list) {
      const c = await window.__cqaTest.api.getConversation(item.id);
      if (c.transcript.length > best.n) best = { id: item.id, n: c.transcript.length };
    }
    return best;
  })()`);
  assert.ok(longest.n > 0, "no conversation with lines");
  await open(page, longest.id);
  assert.equal(await page.count(sel("msg")), longest.n);
  const overflow = await noOverflow(page);
  assert.deepEqual(overflow, { page: 0, list: 0, wide: 0 }, "no horizontal overflow on the longest call");
  const at = Math.min(100, longest.n - 1);
  await page.eval(`window.__cqaTest.transcript.focusMessage(${at})`);
  const seen = await inView(page, at);
  assert.equal(seen.ok, true, `line ${at} is in view: ${JSON.stringify(seen.why)}`);
  if (longest.n > 120) {
    // a long dialogue scrolls inside the pane, not the page
    const scrolled = await page.scrollState(sel("transcript-list"));
    assert.ok(scrolled.scrollTop > 0 && scrolled.scrollHeight > scrolled.clientHeight, "the pane scrolls itself");
  }

  // ---- highlights toggle classes and keep the scroll position ----
  await page.eval(`document.querySelector('[data-test="transcript-list"]').scrollTop = 120`);
  const before = (await page.scrollState(sel("transcript-list"))).scrollTop;
  await page.eval(`window.__cqaTest.transcript.highlight("c-1", [
    { message_index: 0, quote: "", role: "supports" },
    { message_index: 2, quote: "", role: "expected_here" },
    { message_index: 999, quote: "", role: "supports" },
    { message_index: 1, quote: "", role: "no-such-role" },
  ], { from: 1, to: 3 }, "Приветствие")`);
  const classes = (index) => page.eval(`document.querySelector('[data-test="msg"][data-index="${index}"]').className`);
  assert.match(await classes(0), /is-evidence/);
  assert.doesNotMatch(await classes(0), /is-checked/);
  assert.match(await classes(2), /is-expected/);
  assert.match(await classes(2), /is-checked/);
  assert.match(await classes(1), /is-checked/);
  assert.doesNotMatch(await classes(1), /is-evidence|is-expected/, "an unknown role marks nothing");
  assert.match(await classes(3), /is-checked/);
  assert.doesNotMatch(await classes(4), /is-checked|is-evidence|is-expected/);
  const flagOf = (index) => page.eval(`document.querySelector('[data-test="msg"][data-index="${index}"] [data-test="msg-flag"]').textContent`);
  assert.equal(await flagOf(0), "Приветствие");
  assert.equal(await flagOf(2), "здесь ожидалось");
  assert.equal(await flagOf(1), "");
  assert.equal((await page.scrollState(sel("transcript-list"))).scrollTop, before, "highlighting does not scroll");
  // the label falls back to the criterion id; a new call replaces the old marks; null clears them
  await page.eval(`window.__cqaTest.transcript.highlight("c-2", [{ message_index: 4, quote: "", role: "supports" }], null)`);
  assert.equal(await flagOf(4), "c-2");
  assert.equal(await page.count(`${sel("msg")}.is-expected, ${sel("msg")}.is-checked`), 0, "the old marks are gone");
  assert.equal(await page.count(`${sel("msg")}.is-evidence`), 1);
  await page.eval(`window.__cqaTest.transcript.highlight(null, [], null)`);
  assert.equal(await page.count(`${sel("msg")}.is-evidence, ${sel("msg")}.is-expected, ${sel("msg")}.is-checked`), 0);
  assert.equal(await page.eval(`[...document.querySelectorAll('[data-test="msg-flag"]')].every((el) => el.textContent === "")`), true);
  assert.equal((await page.scrollState(sel("transcript-list"))).scrollTop, before, "clearing does not scroll");

  // ---- speakers, time, duplicates, system notes (invented lines) ----
  const upload = await page.eval(`window.__cqaTest.api.uploadConversations([
    { conversation_id: "t9-shapes", channel: "agent chat", language: "RU", transcript: [
      { timestamp: "00:05", speaker: "client", text: "Первая реплика клиента" },
      { timestamp: "01:05", speaker: "operator", text: "Ответ оператора" },
      { timestamp: "01:05", speaker: "operator", text: "Ответ оператора" },
      { timestamp: "01:20", speaker: "bot", text: "Ответ бота" },
      { timestamp: "01:30", speaker: "system", text: "Оператор вышел из чата" },
      { timestamp: "01:31", speaker: "supervisor", text: "Реплика неизвестного участника" },
    ] },
    { conversation_id: "t9-empty", channel: "agent chat", language: "RU", transcript: [] },
    { conversation_id: "t9-unknown", channel: "voice call", language: "KZ", transcript: [
      { timestamp: "2025-01-01T10:00:00.0000000+05:00", speaker: "alien", text: "Привет" },
      { timestamp: "2025-01-01T10:01:05.5000000+05:00", speaker: "", text: "Ещё одна строка" },
    ] },
  ])`);
  const group = upload.group_id;
  assert.ok(group, "the upload gave a group id");

  await open(page, `${group}:t9-shapes`);
  assert.equal(await page.count(sel("msg")), 6);
  const speaker = (index) => page.eval(`document.querySelector('[data-test="msg"][data-index="${index}"]').getAttribute("data-speaker")`);
  assert.deepEqual([await speaker(0), await speaker(1), await speaker(3), await speaker(4), await speaker(5)], ["client", "operator", "bot", "system", "other"]);
  const rect = (index, inner = "") =>
    page.eval(`(() => { const r = document.querySelector('[data-test="msg"][data-index="${index}"] ${inner}').getBoundingClientRect(); return { left: r.left, right: r.right, cx: (r.left + r.right) / 2 }; })()`);
  const listBox = await page.eval(`(() => { const r = document.querySelector('[data-test="transcript-list"]').getBoundingClientRect(); return { left: r.left, right: r.right, cx: (r.left + r.right) / 2 }; })()`);
  const client = await rect(0, ".cqa-msg-text");
  const operator = await rect(1, ".cqa-msg-text");
  const bot = await rect(3, ".cqa-msg-text");
  const system = await rect(4, ".cqa-msg-text");
  assert.ok(client.left < listBox.left + 12, "the client bubble sits on the left");
  assert.ok(operator.right > listBox.right - 12, "the operator bubble sits on the right");
  assert.ok(bot.right > listBox.right - 12, "the bot bubble sits on the right");
  assert.ok(Math.abs(system.cx - listBox.cx) < 6, "the system note is centred");
  assert.match(await page.eval(`document.querySelector('[data-test="msg"][data-index="4"]').className`), /cqa-msg--system/);
  assert.notEqual(await page.eval(`getComputedStyle(document.querySelector('[data-test="msg"][data-index="3"] .cqa-msg-text')).backgroundColor`), await page.eval(`getComputedStyle(document.querySelector('[data-test="msg"][data-index="1"] .cqa-msg-text')).backgroundColor`), "the bot has its own style");
  // labels, the time as an offset from the first line with the original timestamp in the title
  const speakerText = (index) => page.eval(`document.querySelector('[data-test="msg"][data-index="${index}"] [data-test="msg-speaker"]')?.textContent ?? null`);
  assert.deepEqual([await speakerText(0), await speakerText(1), await speakerText(3), await speakerText(4), await speakerText(5)], ["Клиент", "Оператор", "Бот", null, "Другое"]);
  const time = (index) => page.eval(`(() => { const el = document.querySelector('[data-test="msg"][data-index="${index}"] [data-test="msg-time"]'); return { text: el.textContent, title: el.getAttribute("title") }; })()`);
  assert.deepEqual(await time(0), { text: "0:00", title: "00:05" });
  assert.deepEqual(await time(1), { text: "1:00", title: "01:05" });
  // the repeated line
  assert.equal(await page.count(`${sel("msg")}.is-duplicate`), 1);
  assert.match(await page.eval(`document.querySelector('[data-test="msg"][data-index="2"]').className`), /is-duplicate/);
  assert.ok(Number(await page.eval(`getComputedStyle(document.querySelector('[data-test="msg"][data-index="2"] .cqa-msg-text')).opacity`)) < 1, "a duplicate is greyed out");
  assert.equal(await page.eval(`document.querySelector('[data-test="msg"][data-index="1"] .cqa-msg-text').textContent === document.querySelector('[data-test="msg"][data-index="2"] .cqa-msg-text').textContent`), true, "the duplicate keeps its text");

  // ---- Review Focus 1: an empty transcript and an unknown speaker open without exceptions ----
  await open(page, `${group}:t9-empty`);
  await page.waitFor(sel("transcript-empty"));
  assert.match(await page.text(sel("transcript-empty")), /Нет реплик/);
  assert.equal(await page.count(sel("msg")), 0);
  assert.equal(await page.eval(`window.__cqaTest.transcript.focusMessage(0)`), false, "nothing to focus in an empty dialogue");
  await page.eval(`window.__cqaTest.transcript.highlight("c-1", [{ message_index: 0, quote: "", role: "supports" }], { from: 0, to: 5 })`); // must not throw

  await open(page, `${group}:t9-unknown`);
  await page.waitFor(sel("msg"));
  assert.equal(await page.count(sel("msg")), 2);
  assert.equal(await speakerText(0), "Другое");
  assert.equal(await speakerText(1), "Другое", "an empty speaker is «Другое» too");
  assert.deepEqual(await time(1), { text: "1:05", title: "2025-01-01T10:01:05.5000000+05:00" }, "ISO times show the offset from the first line");

  // ---- the pane is rebuilt for the next conversation and drops the old handle ----
  await open(page, longest.id);
  assert.equal(await page.count(sel("msg")), longest.n);
  assert.equal(await page.count(`${sel("msg")}.is-evidence, ${sel("msg")}.is-checked`), 0, "no marks survive a new conversation");
}
