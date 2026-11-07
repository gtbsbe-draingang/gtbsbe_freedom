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
  assert.equal(await page.eval(`document.querySelector(${quote(AUDIO)}).hasAttribute("controls")`), false, "custom waveform controls");
  assert.equal(await page.eval(`document.querySelector(${quote(AUDIO)}).getAttribute("preload")`), "metadata");
  await until(page, `document.querySelector(${quote(AUDIO)}).readyState >= 1`, "the recording's metadata", 5000);
  await until(page, `document.querySelector('[data-test="player"]')?.getAttribute('data-waveform') === 'ready'`, "the decoded waveform", 15000);
  assert.equal(await page.count(sel("waveform-track")), 2, "client and operator rows");
  assert.equal(await page.count(".cqa-wave-bar"), 440, "real decoded envelope on both rows");
  assert.equal(await page.eval(`document.querySelectorAll('.cqa-wave-bar[height="2"]').length < 440`), true, "recording contains non-silent waveform bars");
  // Playback controls and timeline navigation stay linked to the same recording.
  await page.click(sel("player-play"));
  await until(page, `!document.querySelector(${quote(AUDIO)}).paused && document.querySelector(${quote(AUDIO)}).currentTime > 0.1`, "playback");
  await page.click(sel("player-play"));
  assert.equal(await page.eval(`document.querySelector(${quote(AUDIO)}).paused`), true);
  await page.click(sel("player-mute"));
  assert.equal(await page.eval(`document.querySelector(${quote(AUDIO)}).muted`), true);
  await page.click(sel("player-mute"));
  await page.eval(`(() => {const speed=document.querySelector('[data-test="player-speed"]');speed.value='1.5';speed.dispatchEvent(new Event('change'));})()`);
  assert.equal(await page.eval(`document.querySelector(${quote(AUDIO)}).playbackRate`), 1.5);
  // A real pointer click in the middle of the first waveform seeks to the middle of the call.
  await page.click(sel("waveform-track"));
  await until(page, `Math.abs(document.querySelector(${quote(AUDIO)}).currentTime - document.querySelector(${quote(AUDIO)}).duration / 2) < 1`, "waveform pointer seek");
  const beforeKeyboard = await page.eval(`document.querySelector(${quote(AUDIO)}).currentTime`);
  await page.eval(`document.querySelector('[data-test="waveform-track"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
  await until(page, `Math.abs(document.querySelector(${quote(AUDIO)}).currentTime - ${beforeKeyboard + 5}) < 1`, "waveform keyboard seek");
  assert.ok(await page.count(".cqa-wave-selection:not([hidden])") > 0, "current transcript turn is highlighted");
  const at = await page.eval(`window.__cqaTest.api.getConversation(${quote(CALL)}).then((c) => Object.fromEntries(c.audio_offsets.map((o) => [o.message_index, o.seconds])))`);

  // Choose a recorded line: #85 correctly excludes message 10, which is inside a pause.
  const messageIndex = Object.keys(at).map(Number).find((index) => index >= 10);
  assert.ok(Number.isInteger(messageIndex), "there is a recorded line after the pause");
  // ---- clicking a recorded line's time seeks to it ----
  await page.eval(`document.querySelector(${quote(row(messageIndex))}).scrollIntoView({ block: "center" })`);
  await page.sleep(100);
  await page.click(`${row(messageIndex)} ${sel("msg-time")}`);
  await until(page, `Math.abs(document.querySelector(${quote(AUDIO)}).currentTime - ${at[messageIndex]}) < 0.5`, "the seek to the recorded line");

  // ---- timeupdate marks the line being played ----
  await page.eval(`document.querySelector(${quote(AUDIO)}).dispatchEvent(new Event("timeupdate"))`);
  assert.deepEqual(await playing(page), [messageIndex], "the recorded line is playing, and is the only one");

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

  await page.eval(`window.__cqaTest.api.getAudioWaveform = async () => { throw new Error('waveform unavailable'); }`);
  // ---- lines before the recording starts (no audio offset) show the dialogue's clock, not a raw stamp ----
  await page.eval(`(() => {
    const api = window.__cqaTest.api;
    const real = api.getConversation;
    api.getConversation = (id) => real(id).then((c) => (id === ${quote(CALL)} ? { ...c, audio_offsets: c.audio_offsets.filter((o) => o.message_index > 1) } : c));
  })()`);
  await open(page, CALL);
  await page.waitFor(AUDIO, 5000);
  await until(page, `document.querySelector('[data-test="player"]')?.getAttribute('data-waveform') === 'unavailable'`, "waveform fallback");
  assert.equal(await page.eval(`document.querySelector('[data-test="player-play"]').disabled`), false, "decoding failure keeps playback available");
  await until(page, `document.querySelector(${quote(`${row(0)} ${sel("msg-time")}`)}) !== null`, "the first line's time");
  assert.equal(await page.eval(`document.querySelector(${quote(`${row(0)} ${sel("msg-time")}`)}).tagName`), "SPAN", "a line without a start in the recording does not seek");
  assert.match(await page.text(`${row(0)} ${sel("msg-time")}`), /^\d+:\d\d$/, "it shows m:ss, not the raw timestamp");
  assert.equal(await page.eval(`document.querySelector(${quote(`${row(2)} ${sel("msg-time")}`)}).tagName`), "BUTTON", "a line with a start still seeks");
}
