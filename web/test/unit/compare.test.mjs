// Pure parts of the compare page (Task 14): the signed delta, the summary line, the table order and
// the side-by-side criteria. The DOM part is covered by the e2e scenario 10-compare.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { signedText, sideRows, sortRows, summaryText } from "../../src/ui/compare-page.js";

describe("signedText", () => {
  test("two decimals, a real minus sign, a plus for a gain, «—» for none", () => {
    assert.equal(signedText(-3.5), "−3.50");
    assert.equal(signedText(7), "+7.00");
    assert.equal(signedText(0), "0.00");
    assert.equal(signedText(-0.005), "−0.01"); // rounded half up on the exact value, like the totals
    assert.equal(signedText(null), "—");
    assert.equal(signedText(undefined), "—");
  });
});

describe("summaryText", () => {
  test("«N из M диалогов изменились, в среднем −X.XX»", () => {
    assert.equal(summaryText({ total: 40, changed: 12, avg_delta: -3.5 }), "12 из 40 диалогов изменились, в среднем −3,50");
  });

  test("the noun after «из» and the verb agree with their numbers", () => {
    assert.equal(summaryText({ total: 1, changed: 1, avg_delta: 2 }), "1 из 1 диалога изменился, в среднем +2,00");
    assert.equal(summaryText({ total: 21, changed: 0, avg_delta: 0 }), "0 из 21 диалога изменились, в среднем 0,00");
    assert.equal(summaryText({ total: 3, changed: 2, avg_delta: null }), "2 из 3 диалогов изменились, в среднем —");
  });
});

describe("sortRows", () => {
  const rows = [
    { conversation: "B:2", conversation_id: "2", group_id: "B", old_total: 80, new_total: 75, delta: -5 },
    { conversation: "A:1", conversation_id: "1", group_id: "A", old_total: 60, new_total: null, delta: null },
    { conversation: "A:3", conversation_id: "3", group_id: "A", old_total: 50, new_total: 53, delta: 3 },
    { conversation: "B:4", conversation_id: "4", group_id: "B", old_total: 90, new_total: 90, delta: 0 },
  ];
  const ids = (list) => list.map((r) => r.conversation_id);

  test("by delta, ascending and descending; a missing delta stays last", () => {
    assert.deepEqual(ids(sortRows(rows, { key: "delta", dir: "asc" })), ["2", "4", "3", "1"]);
    assert.deepEqual(ids(sortRows(rows, { key: "delta", dir: "desc" })), ["3", "4", "2", "1"]);
  });

  test("by id, group (then id), old and new totals", () => {
    assert.deepEqual(ids(sortRows(rows, { key: "id", dir: "asc" })), ["1", "2", "3", "4"]);
    assert.deepEqual(ids(sortRows(rows, { key: "group", dir: "desc" })), ["2", "4", "1", "3"]);
    assert.deepEqual(ids(sortRows(rows, { key: "old", dir: "asc" })), ["3", "1", "2", "4"]);
    assert.deepEqual(ids(sortRows(rows, { key: "new", dir: "desc" })), ["4", "2", "3", "1"]);
  });

  test("does not change its input", () => {
    const before = ids(rows);
    sortRows(rows, { key: "delta", dir: "desc" });
    assert.deepEqual(ids(rows), before);
  });
});

describe("sideRows: both evaluations, criterion by criterion", () => {
  const criterion = (id, extra = {}) => ({ id, title: `Критерий ${id}`, answer_type: "yes_no", kind: "scored", fingerprint: `fp-${id}`, ...extra });
  const from = { criteria: [criterion("c01"), criterion("c05"), criterion("c06")] };
  const to = { criteria: [criterion("c01"), criterion("c06"), criterion("c09")] };
  const result = (criterion_id, final_answer, points) => ({ criterion_id, answer: final_answer, final_answer, points });
  const before = { results: [result("c01", "yes", 10), result("c05", "no", 0), result("c06", "yes", 15)] };
  const after = { results: [result("c01", "yes", 11.76), result("c06", "yes", 17.65), result("c09", "no", 0)] };

  test("the new version's order, then what it removed; a criterion on one side only says which", () => {
    const rows = sideRows(from, to, before, after);
    assert.deepEqual(rows.map((r) => [r.id, r.side]), [["c01", "both"], ["c06", "both"], ["c09", "new"], ["c05", "old"]]);
    const removed = rows.find((r) => r.id === "c05");
    assert.equal(removed.newResult, null);
    assert.equal(removed.oldResult.final_answer, "no");
  });

  test("changed: one side only, another final answer, or other points (a weight moved)", () => {
    const rows = sideRows(from, to, before, after);
    assert.deepEqual(rows.map((r) => [r.id, r.changed]), [["c01", true], ["c06", true], ["c09", true], ["c05", true]]);
    const same = sideRows(from, from, before, before);
    assert.deepEqual(same.map((r) => r.changed), [false, false, false]);
    const flipped = sideRows(from, from, before, { results: [result("c01", "no", 0), result("c05", "no", 0), result("c06", "yes", 15)] });
    assert.deepEqual(flipped.map((r) => r.changed), [true, false, false]);
  });

  test("a scale answer is compared by value", () => {
    const scale = { criteria: [criterion("c02", { answer_type: "scale" })] };
    const a = { results: [{ criterion_id: "c02", final_answer: { step: 10 }, points: 10 }] };
    const b = { results: [{ criterion_id: "c02", final_answer: { step: 10 }, points: 10 }] };
    assert.equal(sideRows(scale, scale, a, b)[0].changed, false);
    assert.equal(sideRows(scale, scale, a, { results: [{ criterion_id: "c02", final_answer: { step: 5 }, points: 5 }] })[0].changed, true);
  });

  test("the same id with another wording counts as changed and keeps both criteria", () => {
    const reworded = { criteria: [criterion("c01", { title: "Новый текст", fingerprint: "fp-other" })] };
    const [row] = sideRows({ criteria: [criterion("c01")] }, reworded, { results: [result("c01", "yes", 10)] }, { results: [result("c01", "yes", 10)] });
    assert.equal(row.side, "both");
    assert.equal(row.changed, true);
    assert.equal(row.reworded, true);
    assert.equal(row.oldCriterion.title, "Критерий c01");
    assert.equal(row.newCriterion.title, "Новый текст");
  });

  test("a side without an evaluation has no results, and every row counts as changed", () => {
    const rows = sideRows(from, to, null, after);
    assert.ok(rows.every((r) => r.oldResult === null && r.changed));
  });
});
