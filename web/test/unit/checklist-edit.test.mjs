import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateChecklist } from "../../src/domain/checklist-validate.js";
import { diffVersions } from "../../src/domain/checklist-diff.js";

const official = JSON.parse(readFileSync(new URL("../../../checklists/official-chat-v1.json", import.meta.url), "utf8"));
const draft = () => structuredClone(official);
const codes = (list) => list.map((e) => e.code);
const at = (result, path) => result.errors.filter((e) => e.path === path).map((e) => e.code);

describe("validateChecklist (Review Focus 5)", () => {
  test("the official checklist is valid as it is, with no warning", () => {
    const res = validateChecklist(draft());
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.warnings, []);
  });

  test('a decimal comma is normalised: "7,5" -> 7.5', () => {
    const d = draft();
    d.criteria[0].weight = "7,5";
    d.criteria[1].weight = "17,5";
    const res = validateChecklist(d);
    assert.equal(res.value.criteria[0].weight, 7.5);
    assert.equal(res.value.criteria[1].weight, 17.5);
    assert.deepEqual(res.errors, []);
  });

  test("weights summing to 110 give a warning with the sum, never an error", () => {
    const d = draft();
    d.criteria[0].weight = 20; // 10 -> 20: 110 in all
    const res = validateChecklist(d);
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.warnings, [{ code: "weight_sum", sum: 110 }]);
  });

  test("a weight that is not a number from 0 is weight_invalid", () => {
    const d = draft();
    d.criteria[0].weight = "abc";
    d.criteria[1].weight = -5;
    const res = validateChecklist(d);
    assert.deepEqual(at(res, "criteria.0.weight"), ["weight_invalid"]);
    assert.deepEqual(at(res, "criteria.1.weight"), ["weight_invalid"]);
  });

  test("duplicate scale values -> scale_duplicate", () => {
    const d = draft();
    d.criteria[3].scale_steps[1].value = 0; // 0, 0, 10, 15, 20
    assert.deepEqual(at(validateChecklist(d), "criteria.3.scale_steps"), ["scale_duplicate"]);
  });

  test("a scale with fewer than two steps -> scale_empty; a step that is not a number -> scale_value_invalid", () => {
    const d = draft();
    d.criteria[3].scale_steps = [{ value: 20, label: "всё" }];
    d.criteria[5].scale_steps[2].value = "x";
    const res = validateChecklist(d);
    assert.deepEqual(at(res, "criteria.3.scale_steps"), ["scale_empty"]);
    assert.deepEqual(at(res, "criteria.5.scale_steps"), ["scale_value_invalid"]);
  });

  test("scale steps accept a decimal comma and come back sorted", () => {
    const d = draft();
    d.criteria[5].scale_steps = [{ value: "10", label: "a" }, { value: "2,5", label: "b" }, { value: 0, label: "c" }];
    const res = validateChecklist(d);
    assert.deepEqual(res.value.criteria[5].scale_steps.map((s) => s.value), [0, 2.5, 10]);
  });

  test("an empty title -> title_required, for the checklist and for a criterion", () => {
    const d = draft();
    d.name = "  ";
    d.criteria[2].title = "";
    const res = validateChecklist(d);
    assert.deepEqual(at(res, "name"), ["title_required"]);
    assert.deepEqual(at(res, "criteria.2.title"), ["title_required"]);
  });

  test("N/A allowed without a condition -> na_condition_required", () => {
    const d = draft();
    d.criteria[0].na_allowed = true;
    d.criteria[0].na_condition = " ";
    assert.deepEqual(at(validateChecklist(d), "criteria.0.na_condition"), ["na_condition_required"]);
  });

  test("a criterion in a section that does not exist -> section_missing", () => {
    const d = draft();
    d.criteria[0].section_id = "nowhere";
    assert.deepEqual(at(validateChecklist(d), "criteria.0.section_id"), ["section_missing"]);
  });

  test("no criteria at all -> criteria_empty", () => {
    const d = draft();
    d.criteria = [];
    assert.ok(codes(validateChecklist(d).errors).includes("criteria_empty"));
  });

  test("the value is ready to send: gross error weighs 0, no N/A condition when N/A is off, no steps on yes/no", () => {
    const d = draft();
    d.criteria[7].weight = 30; // the gross-error criterion
    d.criteria[0].na_condition = "left over";
    d.criteria[0].scale_steps = [{ value: 1, label: "x" }];
    const res = validateChecklist(d);
    assert.equal(res.value.criteria[7].weight, 0);
    assert.equal(res.value.criteria[0].na_condition, null);
    assert.deepEqual(res.value.criteria[0].scale_steps, []);
    assert.deepEqual(res.warnings, [], "the gross-error weight does not count in the sum");
  });
});

describe("diffVersions", () => {
  test("classifies reworded vs weightOnly vs added vs removed", () => {
    const a = draft();
    const b = draft();
    b.criteria[0].weight = 12; // c01: weight only
    b.criteria[1].wording = "Новая формулировка"; // c02: reworded
    b.criteria[3].scale_steps[0].label = "Другая подпись"; // c04: a scale label counts as reworded
    b.criteria.splice(4, 1); // c05 removed
    b.criteria.push({ id: undefined, section_id: "conduct", order: 9, title: "Новый критерий", wording: "", answer_type: "yes_no", scale_steps: [], weight: 15, na_allowed: false, na_condition: null, kind: "scored", kinds: [], guidance: null });
    const diff = diffVersions(a, b);
    assert.deepEqual(diff.weightOnly, ["c01"]);
    assert.deepEqual(diff.reworded, ["c02", "c04"]);
    assert.deepEqual(diff.removed, ["c05"]);
    assert.deepEqual(diff.added.length, 1, "a criterion without an id is new");
  });

  test("moving a criterion or changing its order or model is not a change that needs the model", () => {
    const a = draft();
    const b = draft();
    b.criteria[0].order = 7;
    b.criteria[0].section_id = "conduct";
    b.criteria[0].model = "claude-sonnet-5-5";
    assert.deepEqual(diffVersions(a, b), { added: [], removed: [], reworded: [], weightOnly: [] });
  });

  test("without a source everything is new", () => {
    const b = draft();
    assert.equal(diffVersions(null, b).added.length, b.criteria.length);
  });
});
