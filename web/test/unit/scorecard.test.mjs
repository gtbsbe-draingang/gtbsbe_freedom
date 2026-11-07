import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { answerTag, jobSettled, pickSelection, thresholdCheck } from "../../src/ui/scorecard.js";

const scale = { kind: "scored", answer_type: "scale", scale_steps: [{ value: 0 }, { value: 10 }, { value: 20 }] };
const gross = { kind: "gross_error", answer_type: "yes_no", scale_steps: [] };
const plain = { kind: "scored", answer_type: "yes_no", scale_steps: [] };

describe("answerTag", () => {
  test("yes, no and N/A", () => {
    assert.deepEqual(answerTag(plain, "yes"), { kind: "ok", text: "Да" });
    assert.deepEqual(answerTag(plain, "no"), { kind: "bad", text: "Нет" });
    assert.deepEqual(answerTag(plain, "na"), { kind: "na", text: "N/A" });
  });
  test("a gross-error «yes» is the bad one", () => {
    assert.equal(answerTag(gross, "yes").kind, "bad");
    assert.equal(answerTag(gross, "no").kind, "ok");
  });
  test("a step is judged against the scale", () => {
    assert.deepEqual(answerTag(scale, { step: 20 }), { kind: "ok", text: "шаг 20" });
    assert.equal(answerTag(scale, { step: 10 }).kind, "mid");
    assert.equal(answerTag(scale, { step: 0 }).kind, "bad");
  });
});

describe("thresholdCheck", () => {
  test("3 minutes is the limit, unknown stays unknown", () => {
    assert.equal(thresholdCheck(0), "ok");
    assert.equal(thresholdCheck(180), "ok");
    assert.equal(thresholdCheck(181), "over");
    assert.equal(thresholdCheck(null), null);
    assert.equal(thresholdCheck(Number.NaN), null);
  });
});

describe("jobSettled", () => {
  test("running is not settled; done, failed and full counts are", () => {
    assert.equal(jobSettled({ status: "running", total: 2, done: 1, failed: 0 }), false);
    assert.equal(jobSettled({ status: "queued", total: 1, done: 0, failed: 0 }), false);
    assert.equal(jobSettled({ status: "done", total: 1, done: 1, failed: 0 }), true);
    assert.equal(jobSettled({ status: "failed", total: 1, done: 0, failed: 1 }), true);
    assert.equal(jobSettled({ status: "running", total: 1, done: 0, failed: 1 }), true);
  });
});

describe("pickSelection", () => {
  const checklists = [
    { checklist_id: "a", versions: [{ version: 1 }, { version: 2 }] },
    { checklist_id: "b", versions: [{ version: 1 }] },
  ];
  test("a valid stored choice wins, then the default, then the latest of the default checklist", () => {
    const server = { default_checklist: { checklist_id: "a", version: 1 } };
    assert.deepEqual(pickSelection({ checklist_id: "b", version: 1 }, server, checklists), { checklist_id: "b", version: 1 });
    assert.deepEqual(pickSelection(null, server, checklists), { checklist_id: "a", version: 1 });
    assert.deepEqual(pickSelection({ checklist_id: "zz", version: 9 }, server, checklists), { checklist_id: "a", version: 1 });
    assert.deepEqual(pickSelection(null, { default_checklist: { checklist_id: "a", version: 7 } }, checklists), { checklist_id: "a", version: 2 });
    assert.deepEqual(pickSelection(null, { default_checklist: { checklist_id: "gone", version: 1 } }, checklists), { checklist_id: "a", version: 2 });
  });
  test("no checklists, no selection", () => {
    assert.equal(pickSelection(null, {}, []), null);
  });
});
