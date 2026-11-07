// The call player linked to the transcript (extra 7, R6): a DEV call gets an <audio> player on top
// of its transcript; clicking a line's time seeks to that line (audio_offsets), `timeupdate` marks
// the line being played, and an evidence link (focusMessage) seeks too. A chat has no player; a call
// without a known recording (the contract example in group CTRL: audio null, needs_import) says so
// and offers the import. Counts, times and states only; no dialogue text is printed.
import assert from "node:assert/strict";

export const name = "player";
export const path = "/#/";
export const viewports = [
  [1400, 900],
  [600, 800],
];

const sel = (test) => `[data-test="${test}"]`;
const quote = (value) => JSON.stringify(value);
const CALL = "DEV:p4-ru-001";
const AUDIO = `${sel("player")} audio`;

async function until(page, expression, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!(await page.eval(expression))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await page.sleep(25);
  }
}

const open = (page, id) => page.eval(`location.hash = "#/c/" + encodeURIComponent(${quote(id)})`);
const row = (index) => `${sel("transcript")} ${sel("msg")}[data-index="${index}"]`;
const playing = (page) => page.eval(`[...document.querySelectorAll(${quote(`${sel("transcript")} .is-playing`)})].map((el) => Number(el.getAttribute("data-index")))`);

export async function run(page) {
  await page.waitFor(sel("queue-item"), 10000);

  // ---- a DEV call: the player loads the recording ----
  await open(page, CALL);
  await page.waitFor(sel("transcript-msgs"), 8000);
  await page.waitFor(AUDIO, 5000);
  assert.equal(await page.eval(`document.querySelector(${quote(AUDIO)}).hasAttribute("controls")`), true, "native controls");
  assert.equal(await page.eval(`document.querySelector(${quote(AUDIO)}).getAttribute("preload")`), "metadata");
  await until(page, `document.querySelector(${quote(AUDIO)}).readyState >= 1`, "the recording's metadata", 5000);
  const at = await page.eval(`window.__cqaTest.api.getConversation(${quote(CALL)}).then((c) => Object.fromEntries(c.audio_offsets.map((o) => [o.message_index, o.seconds])))`);

  // ---- clicking the time of message 10 seeks to it ----
  await page.eval(`document.querySelector(${quote(row(10))}).scrollIntoView({ block: "center" })`);
  await page.sleep(100);
  await page.click(`${row(10)} ${sel("msg-time")}`);
  await until(page, `Math.abs(document.querySelector(${quote(AUDIO)}).currentTime - ${at[10]}) < 0.5`, "the seek to message 10");

  // ---- timeupdate marks the line being played ----
  await page.eval(`document.querySelector(${quote(AUDIO)}).dispatchEvent(new Event("timeupdate"))`);
  assert.deepEqual(await playing(page), [10], "message 10 is the line being played, and the only one");

  // ---- an evidence link (focusMessage) seeks too ----
  assert.equal(await page.eval(`window.__cqaTest.transcript.focusMessage(5)`), true);
  await until(page, `Math.abs(document.querySelector(${quote(AUDIO)}).currentTime - ${at[5]}) < 0.5`, "the seek to message 5");
  await page.eval(`document.querySelector(${quote(AUDIO)}).dispatchEvent(new Event("timeupdate"))`);
  assert.deepEqual(await playing(page), [5], "the mark follows the seek");

  // ---- a chat has no player ----
  const chat = await page.eval(`window.__cqaTest.api.listConversations({ group_id: "DEV" }).then((items) => items.find((c) => c.channel === "agent chat").id)`);
  await open(page, chat);
  await until(page, `document.querySelector(${quote(sel("transcript-title"))})?.textContent === ${quote(chat.split(":").pop())}`, "the chat");
  assert.equal(await page.count(sel("player")), 0, "no player on a chat");

  // ---- a call without a known recording offers the import ----
  await open(page, "CTRL:p4-ru-001");
  await page.waitFor(sel("player-import"), 8000);
  assert.match(await page.text(sel("player")), /Загрузите группу, чтобы включить запись/);
  assert.equal(await page.count(AUDIO), 0, "no audio element without a recording");
  await page.click(sel("player-import"));
  await page.waitFor(sel("loader"), 3000);
  assert.equal(await page.eval(`document.querySelector(${quote(sel("group-id"))}).value`), "CTRL", "the loader opens on this call's group");
  await page.click(sel("loader-close"));
}
