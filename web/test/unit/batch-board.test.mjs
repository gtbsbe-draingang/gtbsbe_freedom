// The batch board's pure parts: the copy of the last batch (mergeBatch) and each card's state.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cardState, mergeBatch } from "../../src/ui/batch-board.js";

const dialogues = [
  { id: "DEV:a", name: "a", language: "RU", channel: "agent chat" },
  { id: "DEV:b", name: "b", language: "KZ", channel: "voice call" },
];
const meta = (key) => ({ key, dialogues, label: "Чек-лист · v1" });
const item = (conversation, status, evaluation_id = null, error = null) => ({ conversation, status, evaluation_id, error });
const job = (id, items) => ({ id, done: 0, total: items.length, failed: 0, running: true, items });

describe("mergeBatch: the board's copy of the last batch", () => {
  test("a slot without the board's meta changes nothing", () => {
    assert.equal(mergeBatch(null, { lock: "starting", job: null, meta: null }), null);
    const previous = mergeBatch(null, { lock: "starting", job: null, meta: meta("k1") });
    assert.equal(mergeBatch(previous, { lock: null, job: null, meta: { target: "apply" } }), previous);
  });

  test("a new batch starts empty and takes its dialogues, label and lock from the slot", () => {
    const batch = mergeBatch(null, { lock: "starting", job: null, meta: meta("k1") });
    assert.deepEqual(batch, { key: "k1", dialogues, label: "Чек-лист · v1", lock: "starting", ignore: null, items: {} });
    assert.deepEqual(dialogues.map((d) => cardState(batch, d.id)), ["queued", "queued"]);
  });

  test("job items are merged by dialogue as the job runs", () => {
    let batch = mergeBatch(null, { lock: "starting", job: null, meta: meta("k1") });
    batch = mergeBatch(batch, { lock: "watching", job: job("j1", [item("DEV:a", "running"), item("DEV:b", "queued")]), meta: meta("k1") });
    assert.deepEqual(dialogues.map((d) => cardState(batch, d.id)), ["running", "queued"]);
    batch = mergeBatch(batch, { lock: null, job: job("j1", [item("DEV:a", "done", "e1"), item("DEV:b", "failed", null, "timeout")]), meta: meta("k1") });
    assert.deepEqual(batch.items, { "DEV:a": { status: "done", evaluation_id: "e1", error: null }, "DEV:b": { status: "failed", evaluation_id: null, error: "timeout" } });
    assert.equal(batch.lock, null);
  });

  test("a retry job of the same batch updates only its own dialogues", () => {
    let batch = mergeBatch(null, { lock: "watching", job: null, meta: meta("k1") });
    batch = mergeBatch(batch, { lock: null, job: job("j1", [item("DEV:a", "done", "e1"), item("DEV:b", "failed")]), meta: meta("k1") });
    batch = mergeBatch(batch, { lock: null, job: job("j2", [item("DEV:b", "done", "e2")]), meta: meta("k1") });
    assert.deepEqual(dialogues.map((d) => cardState(batch, d.id)), ["done", "done"]);
    assert.equal(batch.items["DEV:a"].evaluation_id, "e1");
  });

  test("the previous batch's job, still in the slot when the next batch starts, is ignored", () => {
    let batch = mergeBatch(null, { lock: null, job: job("j1", [item("DEV:a", "done", "e1")]), meta: meta("k1") });
    // same dialogues evaluated again: the slot still holds j1 until the new job arrives
    batch = mergeBatch(batch, { lock: "starting", job: job("j1", [item("DEV:a", "done", "e1")]), meta: meta("k2") });
    assert.equal(batch.ignore, "j1");
    assert.deepEqual(batch.items, {});
    assert.equal(cardState(batch, "DEV:a"), "queued");
    batch = mergeBatch(batch, { lock: "watching", job: job("j3", [item("DEV:a", "running")]), meta: meta("k2") });
    assert.equal(cardState(batch, "DEV:a"), "running");
  });

  test("a dialogue the job never mentioned is unknown once nothing runs", () => {
    let batch = mergeBatch(null, { lock: "starting", job: null, meta: meta("k1") });
    batch = mergeBatch(batch, { lock: null, job: job("j1", [item("DEV:a", "done", "e1")]), meta: meta("k1") });
    assert.deepEqual(dialogues.map((d) => cardState(batch, d.id)), ["done", "unknown"]);
  });
});
