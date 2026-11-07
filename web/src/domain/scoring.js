// Exact scoring (spec section 6). Browser-safe ES module: no Node APIs.
// Arithmetic is rational until the final rounding; per-criterion and section
// numbers are rounded for display only, and the total is rounded from the
// exact sum.
import { add, div, isZero, mul, rat, round2 } from "./rational.js";

const ZERO = rat(0);
const HUNDRED = rat(100);

const isStep = (answer) =>
  answer !== null &&
  typeof answer === "object" &&
  !Array.isArray(answer) &&
  Object.keys(answer).length === 1 &&
  Object.hasOwn(answer, "step");

/**
 * Check one answer against its criterion.
 * @returns {null | "na_not_allowed" | "step_not_in_scale" | "bad_answer"}
 */
export function validateAnswer(criterion, answer) {
  if (answer === "na") return criterion.na_allowed ? null : "na_not_allowed";
  if (answer === "yes" || answer === "no") {
    return criterion.answer_type === "yes_no" ? null : "bad_answer";
  }
  if (isStep(answer)) {
    if (criterion.answer_type !== "scale") return "bad_answer";
    const inScale = (criterion.scale_steps ?? []).some((s) => s.value === answer.step);
    return typeof answer.step === "number" && inScale ? null : "step_not_in_scale";
  }
  return "bad_answer";
}

// Fraction of the weight earned: yes = 1, no = 0, a step = step / top step.
function fraction(criterion, answer) {
  if (answer === "yes") return rat(1);
  if (answer === "no") return ZERO;
  const top = criterion.scale_steps.reduce(
    (max, s) => (s.value > max ? s.value : max),
    criterion.scale_steps[0].value,
  );
  const topRat = rat(top);
  return isZero(topRat) ? ZERO : div(rat(answer.step), topRat);
}

const percentOf = (num, den) => round2(mul(div(num, den), HUNDRED));

/**
 * Score a set of answers against a checklist version.
 * @param version checklist version: { sections[], criteria[] }
 * @param answers Record<criterionId, { answer, kinds? }>
 *   A criterion without an entry is left out of the maths (answer null).
 *   An invalid answer throws: a wrong score is worse than none.
 */
export function score(version, answers) {
  const entries = version.criteria.map((criterion) => {
    const given = answers[criterion.id];
    const answer = given === undefined || given === null ? null : given.answer;
    if (answer !== null && answer !== undefined) {
      const problem = validateAnswer(criterion, answer);
      if (problem) throw new RangeError(`criterion ${criterion.id}: ${problem}`);
    }
    const scored = criterion.kind !== "gross_error";
    const weight = scored ? rat(criterion.weight ?? 0) : ZERO;
    const applicable =
      scored && answer !== null && answer !== undefined && answer !== "na" && weight.n > 0n;
    return { criterion, given, answer: answer ?? null, weight, applicable };
  });

  let weightSum = ZERO;
  for (const e of entries) if (e.applicable) weightSum = add(weightSum, e.weight);

  let total = ZERO;
  const perSection = new Map(); // section_id -> { points, available, earned, weight }
  for (const e of entries) {
    if (!e.applicable) continue;
    const frac = fraction(e.criterion, e.answer);
    e.effective = div(mul(e.weight, HUNDRED), weightSum);
    e.points = mul(frac, e.effective);
    total = add(total, e.points);
    const acc = perSection.get(e.criterion.section_id) ?? {
      points: ZERO,
      available: ZERO,
      earned: ZERO,
      weight: ZERO,
    };
    acc.points = add(acc.points, e.points);
    acc.available = add(acc.available, e.effective);
    acc.earned = add(acc.earned, mul(frac, e.weight));
    acc.weight = add(acc.weight, e.weight);
    perSection.set(e.criterion.section_id, acc);
  }

  const kinds = [];
  let flag = false;
  for (const e of entries) {
    if (e.criterion.kind !== "gross_error" || e.answer !== "yes") continue;
    flag = true;
    for (const kind of e.given.kinds ?? []) if (!kinds.includes(kind)) kinds.push(kind);
  }

  return {
    results: entries.map((e) => ({
      criterion_id: e.criterion.id,
      answer: e.answer,
      points: e.applicable ? round2(e.points) : null,
      effective_weight: e.applicable ? round2(e.effective) : null,
    })),
    total: weightSum.n > 0n ? round2(total) : null,
    // In their `order`, as the backend returns them (a stable sort keeps ties in array order).
    sections: [...version.sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((s) => {
      const acc = perSection.get(s.id);
      return {
        section_id: s.id,
        points: acc ? round2(acc.points) : null,
        available: acc ? round2(acc.available) : null,
        percent: acc ? percentOf(acc.earned, acc.weight) : null,
      };
    }),
    gross_error: { flag, kinds },
  };
}

const decidedAt = (appeal) => {
  const t = Date.parse(appeal.decision.decided_at ?? "");
  return Number.isNaN(t) ? -Infinity : t;
};

/**
 * The answers that make up an evaluation's final result: the result's
 * `final_answer` if present; otherwise the model `answer`, overridden by this
 * evaluation's own decided appeals whose outcome is "changed" (the latest
 * decision per criterion wins). `kinds` is carried when the result has some.
 * @returns {Record<string, { answer, kinds? }>}
 */
export function finalAnswers(evaluation, decidedAppeals) {
  const changed = new Map(); // criterion_id -> latest changed appeal
  for (const appeal of decidedAppeals ?? []) {
    if (appeal.evaluation_id !== evaluation.id) continue;
    if (appeal.decision?.outcome !== "changed") continue;
    const prior = changed.get(appeal.criterion_id);
    if (!prior || decidedAt(appeal) >= decidedAt(prior)) changed.set(appeal.criterion_id, appeal);
  }
  const out = {};
  for (const r of evaluation.results) {
    let answer = r.answer;
    if (r.final_answer !== undefined && r.final_answer !== null) answer = r.final_answer;
    else if (changed.has(r.criterion_id)) answer = changed.get(r.criterion_id).decision.answer;
    out[r.criterion_id] = { answer };
    if (Array.isArray(r.kinds) && r.kinds.length > 0) out[r.criterion_id].kinds = r.kinds;
  }
  return out;
}
