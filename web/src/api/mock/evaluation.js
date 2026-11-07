// Building and recalculating a mock evaluation: reuse of earlier results, carried decisions,
// and totals from the exact scoring in domain/scoring.js.
//
// Reuse key: a result is reused when its criterion fingerprint and the transcript hash match a
// stored result of the same conversation (any checklist, any version). Carry key: a decided
// appeal carries into a new evaluation when its criterion has the same id and fingerprint and
// the transcript hash is the same as in the appeal's own evaluation.
import { finalAnswers, score, validateAnswer } from "../../domain/scoring.js";
import { MODEL } from "./fixtures.js";
import { gradeCriterion } from "./grader.js";

// What the "model" produced; decisions and scoring live in the other result fields.
const MODEL_FIELDS = ["answer", "kinds", "explanation", "evidence", "checked_range", "na_reason", "confidence", "needs_review", "coaching"];

const pickModelFields = (result) => Object.fromEntries(MODEL_FIELDS.map((key) => [key, structuredClone(result[key])]));

/**
 * Stored results that can be reused for a conversation: fingerprint -> the newest done
 * evaluation's result for a criterion with that fingerprint, among evaluations made on the same
 * transcript.
 * @returns {Map<string, object>}
 */
export function collectReusable(evaluations, evalMeta, conversationId, hash) {
  const found = new Map();
  for (let i = evaluations.length - 1; i >= 0; i -= 1) {
    const ev = evaluations[i];
    if (ev.conversation !== conversationId || ev.status !== "done") continue;
    const meta = evalMeta[ev.id];
    if (!meta || meta.hash !== hash) continue;
    for (const [criterionId, fp] of Object.entries(meta.fps)) {
      if (found.has(fp)) continue;
      const result = ev.results.find((r) => r.criterion_id === criterionId);
      if (result) found.set(fp, result);
    }
  }
  return found;
}

/** True when every criterion of the version has a reusable result (and the mode allows reuse). */
export const fullyReusable = (version, reusable, mode) =>
  mode !== "full" && version.criteria.every((criterion) => reusable.has(criterion.fingerprint));

// The latest decided appeal that carries into `criterion` of a new evaluation, or null.
function carriedAppeal(criterion, conversationId, hash, appeals, evalMeta) {
  let best = null;
  const at = (appeal) => Date.parse(appeal.decision.decided_at) || 0;
  for (const appeal of appeals) {
    if (appeal.status !== "decided" || !appeal.decision) continue;
    if (appeal.conversation !== conversationId || appeal.criterion_id !== criterion.id) continue;
    const meta = evalMeta[appeal.evaluation_id];
    if (!meta || meta.hash !== hash || meta.fps[appeal.criterion_id] !== criterion.fingerprint) continue;
    if (validateAnswer(criterion, appeal.decision.answer) !== null) continue;
    if (best === null || at(appeal) >= at(best)) best = appeal; // appeals are in filing order
  }
  return best;
}

/**
 * Sets points, effective weights, totals, sections and the gross-error block of an evaluation
 * from its results: `points` and `effective_weight` follow `final_answer`, `original_total` comes
 * from the model's `answer`s and `final_total` from the final answers. Mutates `evaluation`.
 */
export function recompute(evaluation, version) {
  const modelAnswers = Object.fromEntries(
    evaluation.results.map((r) => [r.criterion_id, { answer: r.answer, ...(r.kinds.length > 0 ? { kinds: r.kinds } : {}) }]),
  );
  const original = score(version, modelAnswers);
  const final = score(version, finalAnswers(evaluation, []));
  const byId = new Map(final.results.map((r) => [r.criterion_id, r]));
  for (const result of evaluation.results) {
    const row = byId.get(result.criterion_id);
    result.points = row.points;
    result.effective_weight = row.effective_weight;
  }
  evaluation.original_total = original.total;
  evaluation.final_total = final.total;
  evaluation.sections = final.sections;

  const gross = evaluation.results.filter((r) => version.criteria.find((c) => c.id === r.criterion_id)?.kind === "gross_error");
  const shown = gross.find((r) => r.final_answer === "yes") ?? gross[0];
  evaluation.gross_error = {
    flag: final.gross_error.flag,
    kinds: final.gross_error.kinds,
    explanation: shown ? shown.explanation : null,
    evidence: shown ? structuredClone(shown.evidence) : [],
  };
  return evaluation;
}

/**
 * A finished mock evaluation of one conversation against one checklist version.
 * @param {object} p
 * @param {string} p.id
 * @param {string} p.createdAt ISO time
 * @param {object} p.conversation
 * @param {object} p.version
 * @param {string} p.hash transcript hash of the conversation
 * @param {"reuse" | "full"} p.mode
 * @param {Map<string, object>} p.reusable from collectReusable
 * @param {object[]} p.appeals every appeal, in filing order
 * @param {Record<string, {hash: string, fps: Record<string, string>}>} p.evalMeta
 * @returns {{evaluation: object, meta: {hash: string, fps: Record<string, string>}}}
 */
export function buildEvaluation({ id, createdAt, conversation, version, hash, mode, reusable, appeals, evalMeta }) {
  const results = version.criteria.map((criterion) => {
    const prior = mode === "full" ? undefined : reusable.get(criterion.fingerprint);
    const model = prior ? { ...pickModelFields(prior), reused: true } : { ...gradeCriterion(conversation, criterion), reused: false };
    const appeal = carriedAppeal(criterion, conversation.id, hash, appeals, evalMeta);
    return {
      ...model,
      criterion_id: criterion.id,
      final_answer: structuredClone(appeal ? appeal.decision.answer : model.answer),
      points: null,
      effective_weight: null,
      carried_decision: appeal ? { appeal_id: appeal.id, evaluation_id: appeal.evaluation_id } : null,
    };
  });

  const evaluation = {
    id,
    created_at: createdAt,
    conversation: conversation.id,
    checklist_id: version.checklist_id,
    version: version.version,
    status: "done",
    source: "mock",
    model: MODEL,
    cost_usd: 0,
    results,
    original_total: null,
    final_total: null,
    sections: [],
    gross_error: { flag: false, kinds: [], explanation: null, evidence: [] },
  };
  recompute(evaluation, version);
  return {
    evaluation,
    meta: { hash, fps: Object.fromEntries(version.criteria.map((c) => [c.id, c.fingerprint])) },
  };
}
