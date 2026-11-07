import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { answerTag, cardAppeals, elapsedText, jobSettled, pickSelection, thresholdCheck } from "../../src/ui/scorecard.js";

describe("cardAppeals: the appeals that concern the card on screen", () => {
  const ev = (id, created_at, carried = []) => ({ id, created_at, results: carried.map((appeal_id, i) => ({ criterion_id: `c${i}`, carried_decision: { appeal_id, evaluation_id: "old" } })) });
  const appeal = (id, evaluation_id, status, decided_at = null, created_at = "2026-11-07T10:00:00Z") => ({ id, evaluation_id, status, created_at, decision: decided_at ? { outcome: "changed", decided_at } : null });
  const shown = ev("B", "2026-11-07T12:00:00Z");
  const history = [shown, ev("A", "2026-11-07T11:00:00Z"), ev("Z", "2026-11-07T13:00:00Z")]; // Z: newer, another version

  test("appeals on this evaluation are its own", () => {
    const res = cardAppeals(shown, [appeal("a1", "B", "open")], history);
    assert.deepEqual(res.own.map((a) => a.id), ["a1"]);
    assert.deepEqual(res.earlierOpen, []);
    assert.deepEqual(res.notCarried, []);
  });

  test("an open appeal on an earlier evaluation of the checklist still concerns the card", () => {
    const res = cardAppeals(shown, [appeal("a1", "A", "open")], history);
    assert.deepEqual(res.earlierOpen.map((a) => a.id), ["a1"]);
  });

  test("a decision on an earlier evaluation that was not carried: decided after this one was made", () => {
    const res = cardAppeals(shown, [appeal("a1", "A", "decided", "2026-11-07T12:30:00Z")], history);
    assert.deepEqual(res.notCarried.map((n) => [n.appeal.id, n.when]), [["a1", "after"]]);
  });

  test("decided before this evaluation and not carried: it applied to an earlier version of the criterion", () => {
    const res = cardAppeals(shown, [appeal("a1", "A", "decided", "2026-11-07T11:30:00Z")], history);
    assert.deepEqual(res.notCarried.map((n) => [n.appeal.id, n.when]), [["a1", "before"]]);
  });

  test("a carried decision is not listed as not carried", () => {
    const carrying = ev("B", "2026-11-07T12:00:00Z", ["a1"]);
    const res = cardAppeals(carrying, [appeal("a1", "A", "decided", "2026-11-07T11:30:00Z")], [carrying, history[1]]);
    assert.deepEqual(res.notCarried, []);
  });

  test("appeals on newer evaluations, other checklists or other dialogues are ignored", () => {
    const res = cardAppeals(shown, [appeal("a1", "Z", "open"), appeal("a2", "elsewhere", "open")], history);
    assert.deepEqual(res, { own: [], earlierOpen: [], notCarried: [] });
  });

  test("each list is in filing order", () => {
    const res = cardAppeals(shown, [appeal("late", "B", "open", null, "2026-11-07T12:20:00Z"), appeal("early", "B", "decided", "2026-11-07T12:40:00Z", "2026-11-07T12:10:00Z")], history);
    assert.deepEqual(res.own.map((a) => a.id), ["early", "late"]);
  });
});

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
  test("rows as the backend sends them (plain version numbers) never give NaN", () => {
    const real = [
      { checklist_id: "official-chat", version: 2, versions: [1, 2] },
      { checklist_id: "calls", version: 1, versions: [1] },
    ];
    const server = { default_checklist: { checklist_id: "official-chat", version: 1 } };
    assert.deepEqual(pickSelection(null, server, real), { checklist_id: "official-chat", version: 1 });
    assert.deepEqual(pickSelection({ checklist_id: "calls", version: 1 }, server, real), { checklist_id: "calls", version: 1 });
    assert.deepEqual(pickSelection(null, { default_checklist: { checklist_id: "official-chat", version: 9 } }, real), { checklist_id: "official-chat", version: 2 });
  });
  test("no checklists, no selection", () => {
    assert.equal(pickSelection(null, {}, []), null);
  });
});

describe("elapsedText: the loading card's clock", () => {
  test("minutes and zero-padded seconds", () => {
    assert.equal(elapsedText(0), "0:00");
    assert.equal(elapsedText(7_999), "0:07");
    assert.equal(elapsedText(102_000), "1:42");
    assert.equal(elapsedText(725_000), "12:05");
  });
  test("a clock that went backwards or a bad value shows zero", () => {
    assert.equal(elapsedText(-500), "0:00");
    assert.equal(elapsedText(Number.NaN), "0:00");
  });
});
