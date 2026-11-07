// The mock "model": deterministic, no network. A criterion's result depends only on
// `conversation.id + criterion.fingerprint`, so the same dialogue and the same criterion always
// give the same answer, evidence and wording, in any group, run or session. All the text a
// "model" writes (explanations, coaching, second opinions, topics) lives here, not in i18n.
import { seeded } from "../../domain/prng.js";

export const RATES = Object.freeze({
  na: 0.2, // N/A, where the criterion allows it
  grossYes: 0.05, // a gross error found
  lowConfidence: 0.1, // confidence "low", which also sets needs_review
  yes: 0.75, // "yes" on a yes/no criterion
  referenceFlip: 0.15, // the reference grader disagrees
  secondOpinionDiffers: 0.6, // the second opinion differs from the graded answer
});

const DEMO = "Демо-оценка:";

const sameAnswer = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sortedSteps = (criterion) => [...(criterion.scale_steps ?? [])].sort((a, b) => a.value - b.value);
const stripNaPrefix = (text) => String(text ?? "").replace(/^N\/A\s*[—–-]\s*/i, "");
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const stripYesPrefix = (text) => String(text ?? "").replace(/^Да\s*[—–-]\s*/, "");

/** "Да", "Нет", "N/A" or "шаг 15", for the mock's own sentences and the CSV. */
export function answerLabel(answer) {
  if (answer === "yes") return "Да";
  if (answer === "no") return "Нет";
  if (answer === "na") return "N/A";
  if (answer !== null && typeof answer === "object") return `шаг ${answer.step}`;
  return "";
}

/** Every answer the criterion accepts, N/A last when it is allowed. */
export function allowedAnswers(criterion) {
  const base =
    criterion.answer_type === "scale" ? sortedSteps(criterion).map((s) => ({ step: s.value })) : ["yes", "no"];
  return criterion.na_allowed ? [...base, "na"] : base;
}

const alternative = (criterion, answer, u) => {
  const options = allowedAnswers(criterion).filter((a) => !sameAnswer(a, answer));
  return options.length === 0 ? answer : options[Math.min(options.length - 1, Math.floor(u * options.length))];
};

// Indices of the operator's lines (non-duplicates when there are any).
function operatorLines(transcript) {
  const all = [];
  const fresh = [];
  transcript.forEach((line, index) => {
    if (line.speaker !== "operator") return;
    all.push(index);
    if (!line.duplicate) fresh.push(index);
  });
  return fresh.length > 0 ? fresh : all;
}

const evidenceAt = (transcript, index, role) => ({ message_index: index, quote: transcript[index].text, role });

/**
 * The mock's result for one criterion. Fields the scoring fills in later (`points`,
 * `effective_weight`) are null; `final_answer` equals `answer`; nothing is reused or carried.
 * @param {{id: string, transcript: {speaker: string, text: string, duplicate?: boolean}[]}} conversation
 * @param {object} criterion a checklist criterion with its `fingerprint`
 */
export function gradeCriterion(conversation, criterion) {
  const rng = seeded(`${conversation.id}${criterion.fingerprint}`);
  // Fixed draw order: what one branch does with a number never shifts another branch's numbers.
  const [uNa, uAnswer, uLow, uMedium, uLine, uKind] = [rng(), rng(), rng(), rng(), rng(), rng()];

  const steps = sortedSteps(criterion);
  const top = steps.length > 0 ? steps[steps.length - 1].value : null;
  const isScale = criterion.answer_type === "scale" && steps.length > 0;
  const isGross = criterion.kind === "gross_error";

  let answer;
  if (criterion.na_allowed && uNa < RATES.na) answer = "na";
  else if (isScale) {
    // Skewed to the top of the scale: u^2 is small more often than not.
    const position = Math.max(0, steps.length - 1 - Math.floor(uAnswer * uAnswer * steps.length));
    answer = { step: steps[position].value };
  } else if (isGross) answer = uAnswer < RATES.grossYes ? "yes" : "no";
  else answer = uAnswer < RATES.yes ? "yes" : "no";

  const kinds =
    isGross && answer === "yes" && (criterion.kinds ?? []).length > 0
      ? [criterion.kinds[Math.min(criterion.kinds.length - 1, Math.floor(uKind * criterion.kinds.length))]]
      : [];

  // "Bad" answers are the ones a coach comments on: a "no", a step below the top, a gross error.
  const missed = !isGross && (answer === "no" || (isScale && answer !== "na" && answer.step < top));
  const flagged = isGross && answer === "yes";

  // Evidence: only the operator's lines are cited, with their exact text.
  const lines = conversation.transcript ?? [];
  const last = lines.length - 1;
  const operators = operatorLines(lines);
  let evidence = [];
  let checkedRange = null;
  if (lines.length > 0 && operators.length === 0) {
    evidence = [evidenceAt(lines, last, "expected_here")];
    checkedRange = { from: 0, to: last };
  } else if (operators.length > 0) {
    const pick = Math.min(operators.length - 1, Math.floor(uLine * operators.length));
    const other = operators.length > 1 ? operators[(pick + 1) % operators.length] : null;
    const range = { from: operators[0], to: last };
    if (isGross && !flagged) {
      checkedRange = range; // nothing to cite: this is what was read
    } else if (missed) {
      evidence = [evidenceAt(lines, operators[pick], "expected_here")];
      if (isScale && answer.step > steps[0].value && other !== null) evidence.push(evidenceAt(lines, other, "supports"));
      checkedRange = range;
    } else {
      evidence = [evidenceAt(lines, operators[pick], "supports")];
      if (other !== null && uMedium < 0.5) evidence.push(evidenceAt(lines, other, "supports"));
    }
    evidence.sort((a, b) => a.message_index - b.message_index);
  }

  const confidence = uLow < RATES.lowConfidence ? "low" : uMedium < 0.35 ? "medium" : "high";
  const stepRow = isScale && answer !== "na" ? steps.find((s) => s.value === answer.step) : null;

  let explanation;
  if (answer === "na") {
    explanation = `${DEMO} критерий «${criterion.title}» неприменим. ${capitalize(stripNaPrefix(criterion.na_condition))}`;
  } else if (isGross) {
    explanation = flagged
      ? `${DEMO} в реплике оператора выявлено нарушение (${kinds.join(", ") || "вид не указан"}).`
      : `${DEMO} грубых нарушений в репликах оператора не выявлено.`;
  } else if (isScale) {
    explanation = `${DEMO} шаг ${answer.step} из ${top}. ${stepRow?.label ?? ""}`.trim();
  } else if (answer === "yes") {
    explanation = `${DEMO} критерий «${criterion.title}» выполнен: оператор действовал так, как требует формулировка.`;
  } else {
    explanation = `${DEMO} критерий «${criterion.title}» не выполнен: в диалоге нет нужного действия оператора.`;
  }

  let coaching = null;
  if (flagged) {
    coaching = `Демо-подсказка: исключите такие реплики. Отвечайте вежливо и только по существу вопроса клиента.`;
  } else if (missed && isScale) {
    coaching = `Демо-подсказка: чтобы получить максимум по критерию «${criterion.title}», добейтесь: ${steps[steps.length - 1].label}`;
  } else if (missed) {
    coaching = `Демо-подсказка: по критерию «${criterion.title}» нужно, чтобы ${stripYesPrefix(criterion.wording).replace(/\.$/, "")}.`;
  }

  return {
    criterion_id: criterion.id,
    answer,
    final_answer: answer,
    kinds,
    points: null,
    effective_weight: null,
    explanation,
    evidence,
    checked_range: checkedRange,
    na_reason: answer === "na" ? `Условие неприменимости выполнено: ${stripNaPrefix(criterion.na_condition)}` : null,
    confidence,
    needs_review: confidence === "low",
    coaching,
    reused: false,
    carried_decision: null,
  };
}

/**
 * The mock's results for a whole checklist version, one per criterion, in order.
 * @returns {object[]}
 */
export function gradeMock(conversation, version) {
  return version.criteria.map((criterion) => gradeCriterion(conversation, criterion));
}

/**
 * The "second grader" the accuracy report compares against: the mock's own answer, flipped with
 * probability RATES.referenceFlip, so agreement lands in a believable range.
 * @returns {{criterion_id: string, answer: unknown}[]}
 */
export function gradeReference(conversation, version) {
  return version.criteria.map((criterion) => {
    const modelAnswer = gradeCriterion(conversation, criterion).answer;
    const rng = seeded(`${conversation.id}${criterion.fingerprint}|reference`);
    const flip = rng() < RATES.referenceFlip;
    const pick = rng();
    return { criterion_id: criterion.id, answer: flip ? alternative(criterion, modelAnswer, pick) : modelAnswer };
  });
}

/**
 * The advice shown to the reviewer on an appeal.
 * @returns {{answer: unknown, reasoning: string}}
 */
export function secondOpinion(conversation, criterion, current) {
  const rng = seeded(`${conversation.id}${criterion.fingerprint}|second`);
  const differs = rng() < RATES.secondOpinionDiffers;
  const answer = differs ? alternative(criterion, current, rng()) : current;
  const same = sameAnswer(answer, current);
  const reasoning = same
    ? `Демо-второе мнение: исходная оценка «${answerLabel(current)}» по критерию «${criterion.title}» выглядит верной.`
    : `Демо-второе мнение: по репликам оператора ответ «${answerLabel(answer)}» подходит лучше, чем «${answerLabel(current)}».`;
  return { answer, reasoning };
}

const MOODS = ["нейтральное", "позитивное", "раздражённое", "тревожное"];
const OUTCOMES = ["resolved", "passed_to_specialists", "unresolved"]; // the contract's enum; "client_left" below

/**
 * Not-scored info (extra B) when the dialogue has none: the first client line as the topic, a
 * seeded mood, and an outcome from the contract's enum ("client_left" when the client left).
 */
export function mockInfo(conversation) {
  const rng = seeded(`${conversation.id}|info`);
  const first = (conversation.transcript ?? []).find((m) => m.speaker === "client" && m.text.trim() !== "");
  const text = first ? first.text.trim().replace(/\s+/g, " ") : "";
  const topic = text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text || null;
  return {
    topic,
    mood_start: MOODS[Math.floor(rng() * MOODS.length)],
    mood_end: MOODS[Math.floor(rng() * MOODS.length)],
    outcome: conversation.facts?.ending === "client_left" ? "client_left" : OUTCOMES[Math.floor(rng() * OUTCOMES.length)],
  };
}
