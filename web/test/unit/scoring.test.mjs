import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { add, div, fmt2, isZero, mul, rat, round2, sub } from "../../src/domain/rational.js";
import { finalAnswers, score, validateAnswer } from "../../src/domain/scoring.js";

// The official checklist, built inline (this test does not read checklists/*.json).
const yn = (id, section_id, weight, na_allowed) => ({
  id,
  section_id,
  answer_type: "yes_no",
  scale_steps: [],
  weight,
  na_allowed,
  kind: "scored",
  kinds: [],
});
const scale = (id, section_id, weight, na_allowed, values) => ({
  id,
  section_id,
  answer_type: "scale",
  scale_steps: values.map((value) => ({ value, label: `step ${value}` })),
  weight,
  na_allowed,
  kind: "scored",
  kinds: [],
});

const official = {
  checklist_id: "official-chat",
  version: 1,
  rounding: 2,
  sections: [
    { id: "start", title: "start", order: 1 },
    { id: "safety", title: "safety", order: 2 },
    { id: "conduct", title: "conduct", order: 3 },
    { id: "gross", title: "gross", order: 4 },
  ],
  criteria: [
    yn("c01", "start", 10, false),
    yn("c02", "start", 15, true),
    yn("c03", "safety", 20, true),
    scale("c04", "safety", 20, true, [0, 5, 10, 15, 20]),
    yn("c05", "conduct", 15, false),
    scale("c06", "conduct", 15, false, [0, 4, 7, 10]),
    yn("c07", "conduct", 5, true),
    {
      ...yn("c08", "gross", 0, false),
      kind: "gross_error",
      kinds: ["insult", "threat", "disclosure"],
    },
  ],
};

const A = (answer, extra = {}) => ({ answer, ...extra });
const step = (value) => ({ step: value });

const byId = (res) => Object.fromEntries(res.results.map((r) => [r.criterion_id, r]));
const section = (res, id) => res.sections.find((s) => s.section_id === id);

describe("rational", () => {
  test("rat parses decimal strings exactly", () => {
    assert.equal(fmt2(rat("7.5")), "7.50");
    assert.equal(round2(rat("7.5")), 7.5);
    assert.equal(fmt2(div(rat("7.5"), rat(2))), "3.75");
    assert.equal(fmt2(rat(-12)), "-12.00");
    assert.equal(fmt2(rat(12n)), "12.00");
    assert.equal(fmt2(rat(".5")), "0.50");
    assert.equal(fmt2(rat("1e2")), "100.00");
    assert.equal(fmt2(rat("25e-1")), "2.50");
  });

  test("numbers go through String(x)", () => {
    // 0.1 + 0.2 is not 0.3 in floats; the decimals 0.1 and 0.2 are exact here.
    assert.equal(fmt2(add(rat(0.1), rat(0.2))), "0.30");
    assert.equal(round2(sub(add(rat(0.1), rat(0.2)), rat(0.3))), 0);
    assert.equal(isZero(sub(add(rat(0.1), rat(0.2)), rat(0.3))), true);
    assert.equal(fmt2(rat(1e21)), "1000000000000000000000.00");
  });

  test("rejects values that are not finite decimals", () => {
    assert.throws(() => rat(NaN), TypeError);
    assert.throws(() => rat(Infinity), TypeError);
    assert.throws(() => rat("abc"), TypeError);
    assert.throws(() => rat(""), TypeError);
    assert.throws(() => rat(null), TypeError);
    assert.throws(() => div(rat(1), rat(0)), RangeError);
  });

  test("add, sub, mul, div are exact and normalised", () => {
    const third = div(rat(1), rat(3));
    assert.equal(isZero(sub(add(third, third), mul(rat(2), third))), true);
    assert.equal(isZero(sub(mul(third, rat(3)), rat(1))), true);
    assert.equal(isZero(rat(0)), true);
    assert.equal(isZero(rat("0.0")), true);
    assert.equal(isZero(third), false);
    // negative divisor keeps the denominator positive
    assert.equal(fmt2(div(rat(1), rat(-4))), "-0.25");
  });

  test("round2 is half-up, away from zero for .5", () => {
    assert.equal(round2(rat("1.005")), 1.01);
    assert.equal(round2(rat("1.0049999")), 1);
    assert.equal(round2(rat("-1.005")), -1.01);
    assert.equal(round2(rat("-1.0049")), -1);
    assert.equal(round2(div(rat(1), rat(3))), 0.33);
    assert.equal(round2(div(rat(2), rat(3))), 0.67);
    assert.equal(round2(rat("84.165")), 84.17);
    assert.equal(fmt2(rat("84.165")), "84.17");
    assert.equal(fmt2(rat("-0.004")), "0.00"); // no "-0.00"
    assert.equal(Object.is(round2(rat("-0.004")), 0), true); // not -0
    assert.equal(fmt2(rat("0.5")), "0.50");
    assert.equal(fmt2(rat("100")), "100.00");
  });
});

describe("validateAnswer", () => {
  const c = Object.fromEntries(official.criteria.map((x) => [x.id, x]));

  test("accepts valid answers", () => {
    assert.equal(validateAnswer(c.c01, "yes"), null);
    assert.equal(validateAnswer(c.c01, "no"), null);
    assert.equal(validateAnswer(c.c02, "na"), null);
    assert.equal(validateAnswer(c.c04, step(15)), null);
    assert.equal(validateAnswer(c.c04, step(0)), null);
    assert.equal(validateAnswer(c.c04, "na"), null);
    assert.equal(validateAnswer(c.c08, "yes"), null);
  });

  test("rejects na where the criterion does not allow it", () => {
    assert.equal(validateAnswer(c.c01, "na"), "na_not_allowed");
    assert.equal(validateAnswer(c.c06, "na"), "na_not_allowed");
    assert.equal(validateAnswer(c.c08, "na"), "na_not_allowed");
  });

  test("rejects a step outside the scale, including a string step", () => {
    assert.equal(validateAnswer(c.c04, step(12)), "step_not_in_scale");
    assert.equal(validateAnswer(c.c04, step("15")), "step_not_in_scale");
    assert.equal(validateAnswer(c.c06, step(20)), "step_not_in_scale");
    assert.equal(validateAnswer(c.c04, { step: null }), "step_not_in_scale");
  });

  test("rejects the wrong shape", () => {
    assert.equal(validateAnswer(c.c01, step(1)), "bad_answer"); // yes_no with a step
    assert.equal(validateAnswer(c.c04, "yes"), "bad_answer"); // scale with yes
    assert.equal(validateAnswer(c.c04, "no"), "bad_answer");
    assert.equal(validateAnswer(c.c01, "YES"), "bad_answer");
    assert.equal(validateAnswer(c.c01, undefined), "bad_answer");
    assert.equal(validateAnswer(c.c01, null), "bad_answer");
    assert.equal(validateAnswer(c.c01, true), "bad_answer");
    assert.equal(validateAnswer(c.c04, {}), "bad_answer");
    assert.equal(validateAnswer(c.c04, { value: 15 }), "bad_answer");
    assert.equal(validateAnswer(c.c04, { step: 15, extra: 1 }), "bad_answer");
    assert.equal(validateAnswer(c.c04, [15]), "bad_answer");
    assert.equal(validateAnswer(c.c04, 15), "bad_answer");
  });
});

describe("score: official checklist test vectors", () => {
  test("T1 all yes, c04=20, c06=10 -> 100", () => {
    const res = score(official, {
      c01: A("yes"),
      c02: A("yes"),
      c03: A("yes"),
      c04: A(step(20)),
      c05: A("yes"),
      c06: A(step(10)),
      c07: A("yes"),
      c08: A("no"),
    });
    assert.equal(res.total, 100);
    assert.deepEqual(res.gross_error, { flag: false, kinds: [] });
    for (const s of ["start", "safety", "conduct"]) {
      assert.equal(section(res, s).percent, 100);
    }
  });

  test("T2 c02,c03,c07 na, c04=15, c06=7 -> 84.17", () => {
    const res = score(official, {
      c01: A("yes"),
      c02: A("na"),
      c03: A("na"),
      c04: A(step(15)),
      c05: A("yes"),
      c06: A(step(7)),
      c07: A("na"),
      c08: A("no"),
    });
    assert.equal(res.total, 84.17);
    const r = byId(res);
    assert.equal(r.c01.points, 16.67);
    assert.equal(r.c01.effective_weight, 16.67);
    assert.equal(r.c04.points, 25);
    assert.equal(r.c04.effective_weight, 33.33);
    assert.equal(r.c05.points, 25);
    assert.equal(r.c06.points, 17.5);
    assert.equal(r.c06.effective_weight, 25);
    // n/a criteria carry no points and no weight
    for (const id of ["c02", "c03", "c07"]) {
      assert.equal(r[id].points, null);
      assert.equal(r[id].effective_weight, null);
      assert.equal(r[id].answer, "na");
    }
    // effective weights add up to 100 (compare in whole hundredths: no float drift)
    const sumHundredths = res.results.reduce(
      (acc, x) => acc + (x.effective_weight === null ? 0 : Math.round(x.effective_weight * 100)),
      0,
    );
    assert.equal(sumHundredths, 10000);
    assert.deepEqual(section(res, "conduct"), {
      section_id: "conduct",
      points: 42.5,
      available: 50,
      percent: 85,
    });
  });

  test("section percent = sum(fraction x weight) / sum(weight) x 100 over applicable (T2 safety)", () => {
    const res = score(official, {
      c01: A("yes"),
      c02: A("na"),
      c03: A("na"),
      c04: A(step(15)),
      c05: A("yes"),
      c06: A(step(7)),
      c07: A("na"),
      c08: A("no"),
    });
    assert.deepEqual(section(res, "safety"), {
      section_id: "safety",
      points: 25,
      available: 33.33,
      percent: 75,
    });
    // start has only c01 applicable (c02 is na)
    assert.deepEqual(section(res, "start"), {
      section_id: "start",
      points: 16.67,
      available: 16.67,
      percent: 100,
    });
    // the gross-error section has nothing applicable
    assert.deepEqual(section(res, "gross"), {
      section_id: "gross",
      points: null,
      available: null,
      percent: null,
    });
    assert.deepEqual(
      res.sections.map((s) => s.section_id),
      ["start", "safety", "conduct", "gross"],
    );
  });

  test("T3 -> 51, gross_error flag with kinds, total unchanged by the flag", () => {
    const answers = {
      c01: A("no"),
      c02: A("yes"),
      c03: A("no"),
      c04: A(step(10)),
      c05: A("yes"),
      c06: A(step(4)),
      c07: A("yes"),
      c08: A("yes", { kinds: ["insult"] }),
    };
    const res = score(official, answers);
    assert.equal(res.total, 51);
    assert.equal(res.gross_error.flag, true);
    assert.deepEqual(res.gross_error.kinds, ["insult"]);
    const r = byId(res);
    assert.equal(r.c08.points, null);
    assert.equal(r.c08.effective_weight, null);
    assert.equal(r.c08.answer, "yes");
    assert.equal(r.c06.points, 6);
    // the same answers with c08 = no give the same total
    const res2 = score(official, { ...answers, c08: A("no") });
    assert.equal(res2.total, 51);
    assert.deepEqual(res2.gross_error, { flag: false, kinds: [] });
  });

  test("gross_error kinds are taken only from a yes answer, deduplicated", () => {
    const base = {
      c01: A("yes"),
      c02: A("yes"),
      c03: A("yes"),
      c04: A(step(20)),
      c05: A("yes"),
      c06: A(step(10)),
      c07: A("yes"),
    };
    const stale = score(official, { ...base, c08: A("no", { kinds: ["insult"] }) });
    assert.deepEqual(stale.gross_error, { flag: false, kinds: [] });
    const many = score(official, {
      ...base,
      c08: A("yes", { kinds: ["insult", "threat", "insult"] }),
    });
    assert.deepEqual(many.gross_error, { flag: true, kinds: ["insult", "threat"] });
    const noKinds = score(official, { ...base, c08: A("yes") });
    assert.deepEqual(noKinds.gross_error, { flag: true, kinds: [] });
  });

  test("scale steps give step / top step", () => {
    const res = score(official, {
      c01: A("yes"),
      c02: A("yes"),
      c03: A("yes"),
      c04: A(step(5)),
      c05: A("yes"),
      c06: A(step(0)),
      c07: A("yes"),
      c08: A("no"),
    });
    const r = byId(res);
    assert.equal(r.c04.points, 5); // 5/20 x 20
    assert.equal(r.c06.points, 0);
    assert.equal(res.total, 70); // 10 + 15 + 20 + 5 + 15 + 0 + 5
  });
});

describe("score: custom checklists and edge cases", () => {
  const custom = (criteria, sections) => ({
    checklist_id: "custom",
    version: 1,
    rounding: 2,
    sections: sections ?? [{ id: "s", title: "s", order: 1 }],
    criteria,
  });

  test("T4 only weighted criterion is na -> total null, section percent null", () => {
    const v = custom([yn("x1", "s", 10, true), yn("x2", "s", 0, false)]);
    const res = score(v, { x1: A("na"), x2: A("yes") });
    assert.equal(res.total, null);
    assert.deepEqual(res.sections, [
      { section_id: "s", points: null, available: null, percent: null },
    ]);
    assert.deepEqual(res.gross_error, { flag: false, kinds: [] });
    const r = byId(res);
    assert.equal(r.x1.points, null);
    assert.equal(r.x2.points, null); // weight 0: not applicable
    assert.equal(r.x2.effective_weight, null);
  });

  test("sections come back in their `order`, not their array order (as the backend returns them)", () => {
    const v = custom(
      [yn("x1", "b", 10, false), yn("x2", "a", 10, false)],
      [
        { id: "b", title: "b", order: 2 },
        { id: "a", title: "a", order: 1 },
      ],
    );
    const res = score(v, { x1: A("yes"), x2: A("no") });
    assert.deepEqual(
      res.sections.map((s) => s.section_id),
      ["a", "b"],
    );
  });

  test("T5 exact half-up: weights 201 (yes) and 19799 (no) -> 1.01", () => {
    const v = custom([yn("x1", "s", 201, false), yn("x2", "s", 19799, false)]);
    const res = score(v, { x1: A("yes"), x2: A("no") });
    // 201 / 20000 x 100 = 1.005 exactly; floats give 1.00
    assert.equal(res.total, 1.01);
    assert.equal(byId(res).x1.points, 1.01);
    assert.equal(byId(res).x2.points, 0);
    assert.equal(section(res, "s").percent, 1.01);
  });

  test("weights summing to 110 rescale to 100", () => {
    const v = custom([yn("x1", "s", 55, false), yn("x2", "s", 55, false)]);
    assert.equal(score(v, { x1: A("yes"), x2: A("yes") }).total, 100);
    const half = score(v, { x1: A("yes"), x2: A("no") });
    assert.equal(half.total, 50);
    assert.equal(byId(half).x1.effective_weight, 50);
    // the official "Calls"-style 110: 10 + 20 + 30 + 50
    const v2 = custom([
      yn("a", "s", 10, false),
      yn("b", "s", 20, false),
      yn("c", "s", 30, false),
      yn("d", "s", 50, false),
    ]);
    const r = score(v2, { a: A("yes"), b: A("no"), c: A("yes"), d: A("no") });
    assert.equal(r.total, 36.36); // 40 / 110 x 100 = 36.3636...
    assert.equal(section(r, "s").percent, 36.36);
  });

  test("decimal weights and decimal scale steps stay exact", () => {
    const v = custom([
      yn("a", "s", 0.1, false),
      scale("b", "s", 0.2, false, [0, 0.5, 1]),
    ]);
    const res = score(v, { a: A("yes"), b: A(step(0.5)) });
    // 0.1 + 0.5 x 0.2 = 0.2 of 0.3 -> 66.666...
    assert.equal(res.total, 66.67);
  });

  test("a gross_error criterion with a weight still never changes the total", () => {
    const g = { ...yn("g", "s", 40, false), kind: "gross_error", kinds: ["insult"] };
    const v = custom([yn("a", "s", 10, false), g]);
    const res = score(v, { a: A("no"), g: A("yes", { kinds: ["insult"] }) });
    assert.equal(res.total, 0);
    assert.equal(res.gross_error.flag, true);
    assert.equal(byId(res).g.effective_weight, null);
  });

  test("a missing answer is left out of the maths and reported with answer null", () => {
    const v = custom([yn("a", "s", 10, false), yn("b", "s", 10, false)]);
    const res = score(v, { a: A("yes") });
    assert.equal(res.total, 100);
    const r = byId(res);
    assert.equal(r.b.answer, null);
    assert.equal(r.b.points, null);
    assert.equal(r.b.effective_weight, null);
  });

  test("an invalid answer throws instead of producing a wrong score", () => {
    assert.throws(() => score(official, { c01: A("na") }), /c01.*na_not_allowed/);
    assert.throws(() => score(official, { c04: A(step(12)) }), /c04.*step_not_in_scale/);
    assert.throws(() => score(official, { c01: A("maybe") }), /c01.*bad_answer/);
  });

  test("score does not mutate its inputs", () => {
    const answers = { c01: A("yes", { kinds: ["x"] }), c04: A(step(20)) };
    const before = JSON.stringify([official, answers]);
    score(official, answers);
    assert.equal(JSON.stringify([official, answers]), before);
  });

  test("results keep checklist order and carry the answer as given", () => {
    const res = score(official, {
      c04: A(step(10)),
      c01: A("yes"),
    });
    assert.deepEqual(
      res.results.map((r) => r.criterion_id),
      official.criteria.map((c) => c.id),
    );
    assert.deepEqual(byId(res).c04.answer, step(10));
  });
});

describe("finalAnswers", () => {
  const evaluation = {
    id: "ev1",
    results: [
      { criterion_id: "c01", answer: "yes" },
      { criterion_id: "c02", answer: "no" },
      { criterion_id: "c03", answer: "no", final_answer: "yes" },
      { criterion_id: "c04", answer: step(10) },
      { criterion_id: "c08", answer: "no", kinds: [] },
    ],
  };
  const changed = (criterion_id, answer, extra = {}) => ({
    evaluation_id: "ev1",
    criterion_id,
    status: "decided",
    decision: { outcome: "changed", answer, reason: "r", role: "reviewer", decided_at: "2026-11-07T10:00:00Z" },
    ...extra,
  });

  test("prefers final_answer, then own changed decision, then model answer", () => {
    const appeals = [
      changed("c02", "yes"), // own changed -> overrides the model answer
      changed("c03", "no"), // final_answer wins over a changed decision
      {
        evaluation_id: "ev1",
        criterion_id: "c01",
        status: "decided",
        decision: { outcome: "confirmed", answer: "no", reason: "r", role: "reviewer", decided_at: "2026-11-07T10:00:00Z" },
      }, // confirmed -> model answer stays
      changed("c04", step(20), { evaluation_id: "other" }), // not own -> ignored
    ];
    const out = finalAnswers(evaluation, appeals);
    assert.deepEqual(out.c01, { answer: "yes" });
    assert.deepEqual(out.c02, { answer: "yes" });
    assert.deepEqual(out.c03, { answer: "yes" });
    assert.deepEqual(out.c04, { answer: step(10) });
    assert.deepEqual(Object.keys(out), ["c01", "c02", "c03", "c04", "c08"]);
  });

  test("with no appeals it is the model answers", () => {
    const out = finalAnswers(evaluation, []);
    assert.equal(out.c02.answer, "no");
    assert.deepEqual(out.c04.answer, step(10));
  });

  test("the latest decision wins when a criterion was decided twice; open appeals are ignored", () => {
    const first = changed("c02", "yes");
    const later = changed("c02", "no", {
      decision: { outcome: "changed", answer: "no", reason: "r", role: "reviewer", decided_at: "2026-11-07T12:00:00Z" },
    });
    const open = { evaluation_id: "ev1", criterion_id: "c01", status: "open", decision: null };
    const out = finalAnswers(evaluation, [later, first, open]);
    assert.equal(out.c02.answer, "no");
    assert.equal(out.c01.answer, "yes");
  });

  test("kinds are carried through for the gross-error flag, and the result feeds score()", () => {
    const ev = {
      id: "ev2",
      results: [
        { criterion_id: "c01", answer: "yes" },
        { criterion_id: "c08", answer: "yes", kinds: ["insult"] },
      ],
    };
    const out = finalAnswers(ev, []);
    assert.deepEqual(out.c01, { answer: "yes" });
    assert.deepEqual(out.c08, { answer: "yes", kinds: ["insult"] });
    // a decided appeal that clears the flag drops the flag in score()
    const cleared = finalAnswers(ev, [
      {
        evaluation_id: "ev2",
        criterion_id: "c08",
        status: "decided",
        decision: { outcome: "changed", answer: "no", decided_at: "2026-11-07T10:00:00Z" },
      },
    ]);
    assert.equal(cleared.c08.answer, "no");
    const res = score(official, { ...cleared });
    assert.equal(res.gross_error.flag, false);
  });

  test("an appeal for a criterion that is not in the results is ignored", () => {
    const out = finalAnswers(evaluation, [changed("zz", "yes")]);
    assert.equal("zz" in out, false);
  });
});
