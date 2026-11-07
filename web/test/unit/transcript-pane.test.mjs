// Pure parts of the transcript pane: speaker kinds, which messages a highlight marks, and when a
// re-imported dialogue needs a redraw. The DOM part is covered by the e2e scenarios 05-transcript
// and 07c-reimport.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { FLASH_MS, highlightPlan, shownKey, speakerKind } from "../../src/ui/transcript.js";

describe("speakerKind", () => {
  test("the four known speakers", () => {
    for (const name of ["client", "operator", "bot", "system"]) assert.equal(speakerKind(name), name);
    assert.equal(speakerKind(" Client "), "client");
  });

  test("anything else is other", () => {
    for (const value of ["supervisor", "", "   ", undefined, null, 5, {}]) assert.equal(speakerKind(value), "other");
  });
});

describe("highlightPlan", () => {
  const marked = (plan, key) => plan.flatMap((m, i) => (m[key] ? [i] : []));

  test("supports, expected_here and the checked range", () => {
    const plan = highlightPlan(6, [{ message_index: 1, role: "supports" }, { message_index: 4, role: "expected_here" }], { from: 2, to: 4 });
    assert.deepEqual(marked(plan, "supports"), [1]);
    assert.deepEqual(marked(plan, "expected"), [4]);
    assert.deepEqual(marked(plan, "checked"), [2, 3, 4]);
  });

  test("a line can be both supporting and expected", () => {
    const plan = highlightPlan(3, [{ message_index: 1, role: "supports" }, { message_index: 1, role: "expected_here" }], null);
    assert.deepEqual([marked(plan, "supports"), marked(plan, "expected")], [[1], [1]]);
  });

  test("ignores indexes outside the dialogue, unknown roles and junk", () => {
    const plan = highlightPlan(3, [{ message_index: 3, role: "supports" }, { message_index: -1, role: "supports" }, { message_index: 1.5, role: "supports" }, { message_index: 0, role: "other" }, null, {}], null);
    assert.deepEqual(plan.flatMap((m, i) => (m.supports || m.expected || m.checked ? [i] : [])), []);
  });

  test("the range is clamped, and an inverted range is read the other way round", () => {
    assert.deepEqual(marked(highlightPlan(4, [], { from: 2, to: 99 }), "checked"), [2, 3]);
    assert.deepEqual(marked(highlightPlan(4, [], { from: 3, to: 1 }), "checked"), [1, 2, 3]);
    assert.deepEqual(marked(highlightPlan(4, [], { from: 7, to: 9 }), "checked"), []);
    assert.deepEqual(marked(highlightPlan(4, [], { from: "1", to: 2 }), "checked"), []);
    assert.deepEqual(marked(highlightPlan(4, [], null), "checked"), []);
  });

  test("an empty dialogue and missing arguments give nothing", () => {
    assert.deepEqual(highlightPlan(0, [{ message_index: 0, role: "supports" }], { from: 0, to: 3 }), []);
    assert.equal(highlightPlan(2, undefined, undefined).length, 2);
  });
});

describe("shownKey: a re-import redraws the pane only when what it shows changed", () => {
  const conv = { id: "DEV:1", conversation_id: "1", channel: "agent chat", language: "ru", status: "new", info: { topic: "a" }, transcript: [{ timestamp: "10:00", speaker: "client", text: "Здравствуйте" }] };

  test("the same dialogue gives the same key, whatever else changed", () => {
    assert.equal(shownKey(conv), shownKey({ ...conv, status: "evaluated", info: { topic: "b" }, transcript: [{ text: "Здравствуйте", speaker: "client", timestamp: "10:00" }] }));
  });

  test("a new, changed or removed line, or another header, changes the key", () => {
    const line = { timestamp: "10:01", speaker: "operator", text: "Добрый день" };
    assert.notEqual(shownKey(conv), shownKey({ ...conv, transcript: [...conv.transcript, line] }));
    assert.notEqual(shownKey(conv), shownKey({ ...conv, transcript: [{ ...conv.transcript[0], text: "Привет" }] }));
    assert.notEqual(shownKey(conv), shownKey({ ...conv, transcript: [] }));
    assert.notEqual(shownKey(conv), shownKey({ ...conv, language: "kk" }));
  });

  test("a call whose recording became playable (an import) changes the key", () => {
    const call = { ...conv, channel: "voice call", audio: null, audio_unavailable_reason: "needs_import", audio_offsets: [] };
    assert.notEqual(shownKey(call), shownKey({ ...call, audio: "conversations/DEV%3A1/audio", audio_unavailable_reason: null }));
    assert.notEqual(shownKey(call), shownKey({ ...call, audio_offsets: [{ message_index: 0, seconds: 2 }] }));
  });

  test("a missing transcript reads as an empty one", () => {
    assert.equal(shownKey({ ...conv, transcript: undefined }), shownKey({ ...conv, transcript: [] }));
  });
});

test("the flash lasts 1.2 s", () => {
  assert.equal(FLASH_MS, 1200);
});
