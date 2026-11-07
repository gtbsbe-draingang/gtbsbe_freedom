import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { answerChoices, answerValue, fragmentIndexes, parseAnswerValue } from "../../src/ui/review-panel.js";

describe("fragmentIndexes: the lines a reviewer sees", () => {
  test("evidence lines with two lines of context, clipped to the dialogue", () => {
    const result = { evidence: [{ message_index: 1, role: "supports" }, { message_index: 9, role: "expected_here" }] };
    assert.deepEqual(fragmentIndexes(result, 11), [0, 1, 2, 3, 7, 8, 9, 10]);
  });

  test("overlapping context is merged, indexes stay sorted and unique", () => {
    const result = { evidence: [{ message_index: 5 }, { message_index: 3 }] };
    assert.deepEqual(fragmentIndexes(result, 20), [1, 2, 3, 4, 5, 6, 7]);
  });

  test("without evidence, the checked range (inverted ranges read the other way round)", () => {
    assert.deepEqual(fragmentIndexes({ evidence: [], checked_range: { from: 6, to: 4 } }, 10), [4, 5, 6]);
  });

  test("indexes outside the dialogue are ignored; nothing to show gives []", () => {
    assert.deepEqual(fragmentIndexes({ evidence: [{ message_index: 99 }, { message_index: -1 }] }, 5), []);
    assert.deepEqual(fragmentIndexes({}, 5), []);
    assert.deepEqual(fragmentIndexes(null, 5), []);
  });
});

describe("answerChoices: what a reviewer may change the answer to", () => {
  const yesNo = (na) => ({ id: "c", answer_type: "yes_no", na_allowed: na, kind: "scored" });
  const scale = { id: "s", answer_type: "scale", na_allowed: false, scale_steps: [{ value: 0 }, { value: 10 }, { value: 20 }] };

  test("yes/no offers N/A only where the criterion allows it", () => {
    assert.deepEqual(answerChoices(yesNo(false)), ["yes", "no"]);
    assert.deepEqual(answerChoices(yesNo(true)), ["yes", "no", "na"]);
  });

  test("a scale offers its steps by value", () => {
    assert.deepEqual(answerChoices(scale), [{ step: 0 }, { step: 10 }, { step: 20 }]);
  });
});

describe("answerValue / parseAnswerValue: answers as <option> values", () => {
  test("round trip", () => {
    for (const answer of ["yes", "no", "na", { step: 15 }, { step: 0 }]) {
      assert.deepEqual(parseAnswerValue(answerValue(answer)), answer);
    }
  });

  test("a step encodes as step:<value>", () => {
    assert.equal(answerValue({ step: 7.5 }), "step:7.5");
  });

  test("anything else parses as null", () => {
    assert.equal(parseAnswerValue("step:x"), null);
    assert.equal(parseAnswerValue(""), null);
  });
});
