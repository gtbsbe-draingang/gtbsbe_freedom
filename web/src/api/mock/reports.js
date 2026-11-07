// Comparison, accuracy, analytics and the CSV export, computed from the mock's own evaluations.
// Everything reads FINAL totals and final answers, so a reviewer's decision shows everywhere.
//
// `ctx` is what index.js knows:
//   conversations(): every loaded conversation, in load order
//   latestEvaluation(conversationId, checklistId, version?): newest done evaluation or undefined
//   version(checklistId, version): a checklist version or undefined
//   appeals: every appeal
//   defaultChecklist: {checklist_id, version}
import { toCsv } from "../../domain/csv.js";
import { answerLabel, gradeReference } from "./grader.js";
import { MODEL } from "./fixtures.js";

export const REFERENCE_NOTE = "Демо: эталон не загружен";

const hundredths = (x) => Math.round(x * 100);
const fromHundredths = (n) => n / 100;
const round2 = (x) => fromHundredths(hundredths(x));
const sameAnswer = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const rate = (part, whole) => (whole === 0 ? 0 : round2(part / whole));

// ---- comparison ----------------------------------------------------------------------------

/**
 * Final totals of two checklist versions side by side, for the dialogues that were graded with
 * both. `delta` is null when either total is null (not calculated).
 */
export function buildComparison(ctx, { from, to, groupId, conversations }) {
  const header = (ref) => ({ checklist_id: ref.checklist_id, version: ref.version, name: ctx.version(ref.checklist_id, ref.version).name });
  const wanted = conversations ? new Set(conversations) : null;
  const rows = [];
  for (const conv of ctx.conversations()) {
    if (wanted && !wanted.has(conv.id)) continue;
    if (!wanted && groupId && conv.group_id !== groupId) continue;
    const before = ctx.latestEvaluation(conv.id, from.checklist_id, from.version);
    const after = ctx.latestEvaluation(conv.id, to.checklist_id, to.version);
    if (!before || !after) continue;
    const delta =
      before.final_total === null || after.final_total === null
        ? null
        : fromHundredths(hundredths(after.final_total) - hundredths(before.final_total));
    rows.push({
      conversation: conv.id,
      conversation_id: conv.conversation_id,
      group_id: conv.group_id,
      old_total: before.final_total,
      new_total: after.final_total,
      delta,
    });
  }
  const deltas = rows.map((r) => r.delta).filter((d) => d !== null);
  return {
    from: header(from),
    to: header(to),
    summary: {
      total: rows.length,
      changed: deltas.filter((d) => d !== 0).length,
      avg_delta: deltas.length === 0 ? null : fromHundredths(Math.round(deltas.reduce((a, d) => a + hundredths(d), 0) / deltas.length)),
    },
    rows,
  };
}

// ---- accuracy ------------------------------------------------------------------------------

/**
 * Agreement of the evaluated (model) answers with a second seeded grader, on the default
 * checklist. Criteria with an appeal (open or decided) are left out as disputed; dialogues
 * without an evaluation count as missing, one per criterion.
 */
export function buildAccuracy(ctx) {
  const version = ctx.version(ctx.defaultChecklist.checklist_id, ctx.defaultChecklist.version);
  const byCriterion = new Map(version.criteria.map((c) => [c.id, { criterion_id: c.id, title: c.title, hit: 0, n: 0 }]));
  const byLanguage = new Map();
  const byChannel = new Map();
  const disagreements = [];
  let hit = 0;
  let n = 0;
  let missing = 0;
  let disputed = 0;
  const tick = (map, key, field, matched) => {
    const row = map.get(key) ?? { [field]: key, hit: 0, n: 0 };
    row.n += 1;
    if (matched) row.hit += 1;
    map.set(key, row);
  };

  for (const conv of ctx.conversations()) {
    const evaluation = ctx.latestEvaluation(conv.id, version.checklist_id, version.version);
    if (!evaluation) {
      missing += version.criteria.length;
      continue;
    }
    const reference = new Map(gradeReference(conv, version).map((r) => [r.criterion_id, r.answer]));
    for (const result of evaluation.results) {
      if (!byCriterion.has(result.criterion_id)) continue;
      const hasAppeal = ctx.appeals.some((a) => a.evaluation_id === evaluation.id && a.criterion_id === result.criterion_id);
      if (hasAppeal) {
        disputed += 1;
        continue;
      }
      const expected = reference.get(result.criterion_id);
      const matched = sameAnswer(expected, result.answer);
      n += 1;
      if (matched) hit += 1;
      else disagreements.push({ conversation: conv.id, conversation_id: conv.conversation_id, criterion_id: result.criterion_id, reference: expected, evaluated: result.answer });
      const row = byCriterion.get(result.criterion_id);
      row.n += 1;
      if (matched) row.hit += 1;
      tick(byLanguage, conv.language, "language", matched);
      tick(byChannel, conv.channel, "channel", matched);
    }
  }

  const strip = ({ hit: h, n: count, ...rest }) => ({ ...rest, agreement: rate(h, count), n: count });
  return {
    reference_note: REFERENCE_NOTE,
    model: MODEL,
    overall: { agreement: rate(hit, n), n },
    by_criterion: [...byCriterion.values()].filter((r) => r.n > 0).map(strip),
    by_language: [...byLanguage.values()].map(strip),
    by_channel: [...byChannel.values()].map(strip),
    missing,
    disputed_excluded: disputed,
    disagreements,
  };
}

// ---- analytics -----------------------------------------------------------------------------

const average = (totals) =>
  totals.length === 0 ? null : fromHundredths(Math.round(totals.reduce((a, t) => a + hundredths(t), 0) / totals.length));

/**
 * By criterion, language and channel, plus gross errors, over the newest evaluation of every
 * dialogue on the default checklist. A "fail" is a "no" or a scale step below the top.
 */
export function buildAnalytics(ctx) {
  const version = ctx.version(ctx.defaultChecklist.checklist_id, ctx.defaultChecklist.version);
  const scored = version.criteria.filter((c) => c.kind !== "gross_error");
  const topOf = (c) => (c.answer_type === "scale" ? Math.max(...c.scale_steps.map((s) => s.value)) : null);
  const stats = new Map(scored.map((c) => [c.id, { c, n: 0, na: 0, fail: 0 }]));
  const byLanguage = new Map();
  const byChannel = new Map();
  const grossKinds = new Map();
  const grossConversations = [];

  for (const conv of ctx.conversations()) {
    const evaluation = ctx.latestEvaluation(conv.id, version.checklist_id, version.version);
    if (!evaluation) continue;
    for (const result of evaluation.results) {
      const s = stats.get(result.criterion_id);
      if (!s) continue;
      const answer = result.final_answer;
      s.n += 1;
      if (answer === "na") s.na += 1;
      else if (answer === "no" || (typeof answer === "object" && answer.step < topOf(s.c))) s.fail += 1;
    }
    for (const [map, key, field] of [[byLanguage, conv.language, "language"], [byChannel, conv.channel, "channel"]]) {
      const row = map.get(key) ?? { [field]: key, totals: [], n: 0 };
      row.n += 1;
      if (evaluation.final_total !== null) row.totals.push(evaluation.final_total);
      map.set(key, row);
    }
    if (evaluation.gross_error.flag) {
      grossConversations.push(conv.id);
      for (const kind of evaluation.gross_error.kinds) grossKinds.set(kind, (grossKinds.get(kind) ?? 0) + 1);
    }
  }

  const strip = ({ totals, n, ...rest }) => ({ ...rest, avg_total: average(totals), n });
  return {
    by_criterion: [...stats.values()]
      .filter((s) => s.n > 0)
      .map((s) => ({ criterion_id: s.c.id, title: s.c.title, fail_rate: rate(s.fail, s.n - s.na), na_rate: rate(s.na, s.n), n: s.n })),
    by_language: [...byLanguage.values()].map(strip),
    by_channel: [...byChannel.values()].map(strip),
    gross_errors: {
      count: grossConversations.length,
      by_kind: [...grossKinds].map(([kind, count]) => ({ kind, count })),
      conversations: grossConversations,
    },
  };
}

// ---- CSV -----------------------------------------------------------------------------------

// Excel in ru-RU reads "88,82" as a number and "88.82" as text, so numbers get a decimal comma.
const decimal = (n) => (n === null || n === undefined ? "" : String(n).replace(".", ","));

const CHANNELS = { "agent chat": "чат", "voice call": "звонок" };

/**
 * One row per dialogue of the group (all groups when `groupId` is empty): the newest default-
 * checklist evaluation with the final answer and points per criterion, the totals and the
 * gross-error flag.
 * @returns {string} CSV text with a BOM
 */
export function buildCsv(ctx, groupId) {
  // Before the seed is written (it is async) there is no checklist yet: the base columns only.
  const version = ctx.version(ctx.defaultChecklist.checklist_id, ctx.defaultChecklist.version) ?? { name: "", criteria: [] };
  const columns = [
    { key: "group_id", header: "Группа" },
    { key: "conversation_id", header: "Диалог" },
    { key: "channel", header: "Канал", value: (r) => CHANNELS[r.conv.channel] ?? r.conv.channel },
    { key: "language", header: "Язык", value: (r) => r.conv.language },
    { key: "checklist", header: "Чек-лист", value: (r) => (r.ev ? `${version.name} v${r.ev.version}` : "") },
    { key: "total", header: "Итог", value: (r) => decimal(r.ev?.final_total) },
    { key: "original", header: "Итог модели", value: (r) => decimal(r.ev?.original_total) },
    { key: "gross", header: "Грубая ошибка", value: (r) => (r.ev ? (r.ev.gross_error.flag ? "Да" : "Нет") : "") },
    { key: "kinds", header: "Виды нарушений", value: (r) => r.ev?.gross_error.kinds.join(", ") ?? "" },
  ];
  for (const criterion of version.criteria) {
    const result = (r) => r.ev?.results.find((x) => x.criterion_id === criterion.id);
    columns.push({ key: `${criterion.id}-answer`, header: `${criterion.title}: ответ`, value: (r) => answerLabel(result(r)?.final_answer) });
    if (criterion.kind !== "gross_error") {
      columns.push({ key: `${criterion.id}-points`, header: `${criterion.title}: баллы`, value: (r) => decimal(result(r)?.points) });
    }
  }
  columns.push({ key: "source", header: "Источник", value: (r) => (r.ev ? "демо-оценка" : "") });

  const rows = ctx
    .conversations()
    .filter((conv) => !groupId || conv.group_id === groupId)
    .map((conv) => ({ ...conv, conv, ev: ctx.latestEvaluation(conv.id, version.checklist_id, version.version) }));
  return toCsv(rows, columns);
}
