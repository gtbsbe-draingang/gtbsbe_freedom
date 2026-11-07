// The pure helpers of the queue: the topic line and the score text.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { FILTERS, clip, firstClientLine, scoreText } from "../../src/ui/queue.js";

describe("clip", () => {
  test("keeps a short line, collapses whitespace", () => {
    assert.equal(clip("  Здравствуйте,\n  хочу   открыть счёт "), "Здравствуйте, хочу открыть счёт");
  });

  test("cuts a long line to 80 characters with an ellipsis", () => {
    const out = clip("а".repeat(200));
    assert.equal(out.length, 80);
    assert.ok(out.endsWith("…"));
    assert.equal(clip("б".repeat(80)).length, 80, "exactly 80 is kept whole");
    assert.ok(!clip("б".repeat(80)).endsWith("…"));
  });

  test("does not leave a space before the ellipsis", () => {
    const out = clip(`${"а".repeat(78)} ${"б".repeat(20)}`);
    assert.ok(out.endsWith("а…"));
  });
});

describe("firstClientLine", () => {
  test("the first non-empty client line, skipping the bot, the system and the operator", () => {
    const conversation = {
      transcript: [
        { speaker: "system", text: "Чат начат" },
        { speaker: "operator", text: "Добрый день" },
        { speaker: "client", text: "   " },
        { speaker: "client", text: "Хочу открыть счёт" },
        { speaker: "client", text: "Второй вопрос" },
      ],
    };
    assert.equal(firstClientLine(conversation), "Хочу открыть счёт");
  });

  test("an empty or missing transcript gives an empty string", () => {
    assert.equal(firstClientLine({ transcript: [] }), "");
    assert.equal(firstClientLine({}), "");
    assert.equal(firstClientLine(null), "");
    assert.equal(firstClientLine({ transcript: [{ speaker: "operator", text: "Привет" }] }), "");
  });
});

describe("scoreText", () => {
  test("the total with a decimal comma", () => {
    assert.equal(scoreText({ total: 88.82 }), "88,82");
    assert.equal(scoreText({ total: 100 }), "100");
    assert.equal(scoreText({ total: 0 }), "0");
  });

  test("«—» for an ungraded conversation and for a total that is not calculated", () => {
    assert.equal(scoreText(null), "—");
    assert.equal(scoreText(undefined), "—");
    assert.equal(scoreText({ total: null }), "—");
  });
});

test("the filter names are the ones the pills and the test hooks use", () => {
  assert.deepEqual(FILTERS, ["all", "chats", "calls", "disputed", "new"]);
});
