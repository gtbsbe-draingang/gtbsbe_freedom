// The review panel of one appeal (R7, R8): the disputed criterion with the model's answer, points
// and explanation; the controller's comment; the dialogue fragment (evidence lines with two lines
// of context, read-only) and a link to the full card; the second opinion (extra 6), polled every
// 2 s while pending; and the decision. Deciding needs the «Проверяющий» role; a controller sees
// the same panel read-only.
//
//   renderReviewPanel(store, api, appealId, {onDecided?}) -> { el, destroy }
//
// Data: api.getAppeal, getEvaluation, getConversation, getChecklistVersion, decideAppeal. After a
// decision it shows «Итог: old → new», bumps `queueRefresh` and calls onDecided(appeal).
import { validateAnswer } from "../domain/scoring.js";
import { fmt2, rat } from "../domain/rational.js";
import { formatOffset, offsets } from "../domain/time.js";
import { t } from "../i18n/ru.js";
import { watch } from "../state/store.js";
import { clear, h } from "./dom.js";
import { href } from "./router.js";
import { answerTag } from "./scorecard.js";
import { errorText, toastError } from "./toast.js";
import { speakerKind } from "./transcript.js";

export const POLL_MS = 2000;
const CONTEXT_LINES = 2;

// ---- pure helpers -----------------------------------------------------------------------------

const validIndex = (value, count) => Number.isInteger(value) && value >= 0 && value < count;

/**
 * The message indexes of the fragment a reviewer sees: every evidence line with CONTEXT_LINES
 * lines before and after; without evidence, the checked range. Sorted, unique, inside the dialogue.
 */
export function fragmentIndexes(result, count) {
  const picked = new Set();
  const evidence = Array.isArray(result?.evidence) ? result.evidence : [];
  const marks = evidence.map((item) => item?.message_index).filter((i) => validIndex(i, count));
  if (marks.length > 0) {
    for (const i of marks) {
      for (let k = i - CONTEXT_LINES; k <= i + CONTEXT_LINES; k += 1) if (validIndex(k, count)) picked.add(k);
    }
  } else {
    const range = result?.checked_range;
    if (range && Number.isInteger(range.from) && Number.isInteger(range.to)) {
      const from = Math.max(0, Math.min(range.from, range.to));
      const to = Math.min(count - 1, Math.max(range.from, range.to));
      for (let k = from; k <= to; k += 1) picked.add(k);
    }
  }
  return [...picked].sort((a, b) => a - b);
}

/** The answers a criterion accepts, in display order: yes, no (or the scale's steps), then N/A. */
export function answerChoices(criterion) {
  const candidates = criterion?.answer_type === "scale" ? (criterion.scale_steps ?? []).map((step) => ({ step: step.value })) : ["yes", "no"];
  candidates.push("na");
  return candidates.filter((answer) => validateAnswer(criterion, answer) === null);
}

/** An answer as an <option> value: "yes" | "no" | "na" | "step:<value>". */
export const answerValue = (answer) => (typeof answer === "string" ? answer : `step:${answer.step}`);

/** The inverse of answerValue; null for anything else. */
export function parseAnswerValue(value) {
  if (value === "yes" || value === "no" || value === "na") return value;
  const match = /^step:(-?\d+(?:\.\d+)?)$/.exec(String(value ?? ""));
  return match ? { step: Number(match[1]) } : null;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const totalText = (value) => (value === null || value === undefined ? t("scorecard.totalNone") : fmt2(rat(value)));
const tag = (kind, text, props = {}) => h("span", { class: ["cqa-tag", `cqa-tag--${kind}`], text, data: props.data });

function stepLabel(criterion, answer) {
  const text = answerTag(criterion, answer).text;
  if (typeof answer !== "object") return text;
  const step = (criterion.scale_steps ?? []).find((s) => s.value === answer.step);
  return step?.label ? `${text} · ${step.label}` : text;
}

// ---- the panel --------------------------------------------------------------------------------

/**
 * @param {{get: Function, set: Function, subscribe: Function}} store
 * @param {object} api
 * @param {string} appealId
 * @param {{onDecided?: (appeal: object) => void}} [options]
 * @returns {{el: HTMLElement, destroy: () => void}}
 */
export function renderReviewPanel(store, api, appealId, { onDecided } = {}) {
  const el = h("section", { class: "cqa-rv", attrs: { "aria-label": t("review.label") }, data: { test: "review-panel" } });
  const view = { appeal: null, evaluation: null, version: null, conversation: null, outcome: null, answer: null, reason: "", busy: false, result: null };
  let destroyed = false;
  let pollTimer = null;
  const stops = [];

  const opinionBox = h("div", { class: "cqa-rv-opinion", attrs: { role: "status", "aria-live": "polite" }, data: { test: "second-opinion" } });
  const decisionBox = h("div", { class: "cqa-rv-decision", data: { test: "decision" } });

  const criterion = () => view.version?.criteria.find((c) => c.id === view.appeal.criterion_id) ?? null;
  const result = () => view.evaluation?.results.find((r) => r.criterion_id === view.appeal.criterion_id) ?? null;

  // ---- loading --------------------------------------------------------------------------------

  async function load() {
    clear(el).append(h("div", { class: "cqa-empty", attrs: { role: "status" }, data: { test: "review-loading" } }, h("b", { class: "cqa-empty-title", text: t("review.loading") })));
    try {
      const appeal = await api.getAppeal(appealId);
      const [evaluation, conversation] = await Promise.all([api.getEvaluation(appeal.evaluation_id), api.getConversation(appeal.conversation)]);
      const version = await api.getChecklistVersion(evaluation.checklist_id, evaluation.version);
      if (destroyed) return;
      Object.assign(view, { appeal, evaluation, version, conversation });
      draw();
      schedulePoll();
    } catch (error) {
      if (destroyed) return;
      clear(el).append(
        h(
          "div",
          { class: "cqa-empty", attrs: { role: "status" }, data: { test: "review-error" } },
          h("b", { class: "cqa-empty-title", text: t("review.loadFailed") }),
          h("p", { class: "cqa-empty-note", text: errorText(error) }),
          h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("review.retry"), on: { click: load } }),
        ),
      );
    }
  }

  // The second opinion is filled in after filing; ask again every POLL_MS while it is pending.
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (destroyed || view.appeal?.second_opinion_status !== "pending") return;
    pollTimer = setTimeout(async () => {
      try {
        const fresh = await api.getAppeal(appealId);
        if (destroyed) return;
        view.appeal = { ...view.appeal, second_opinion: fresh.second_opinion, second_opinion_status: fresh.second_opinion_status };
        paintOpinion();
      } catch {
        // a failed poll is tried again on the next tick
      }
      schedulePoll();
    }, POLL_MS);
  }

  // ---- drawing --------------------------------------------------------------------------------

  function draw() {
    const { appeal, conversation } = view;
    const c = criterion();
    const r = result();
    const open = appeal.status === "open";
    const conversationId = conversation?.conversation_id ?? appeal.conversation;

    const head = h(
      "div",
      { class: "cqa-rv-head" },
      h("h2", { class: "cqa-rv-title", text: t("review.title", { id: conversationId }) }),
      tag(open ? "mid" : "ok", t(open ? "appeals.status.open" : "appeals.status.decided"), { data: { test: "review-status" } }),
      h("a", { class: ["cqa-link", "cqa-rv-card"], attrs: { href: href("workspace", { id: appeal.conversation }) }, text: t("review.openCard"), data: { test: "review-card-link" } }),
    );

    const points =
      c?.kind === "gross_error"
        ? t("scorecard.grossNoScore")
        : r && typeof r.points === "number" && typeof r.effective_weight === "number"
          ? t("scorecard.points", { earned: fmt2(rat(r.points)), max: fmt2(rat(r.effective_weight)) })
          : "—";
    const disputed = h(
      "div",
      { class: "cqa-rv-crit", data: { test: "review-criterion" } },
      h("p", { class: "cqa-rv-label", text: t("review.criterion") }),
      h(
        "div",
        { class: "cqa-sc-r1" },
        h("b", { class: "cqa-sc-crit-title", text: c?.title ?? appeal.criterion_id }),
        r && c ? tag(answerTag(c, r.answer).kind, answerTag(c, r.answer).text, { data: { test: "review-answer" } }) : null,
        // after a decision the points follow the new answer, so show it next to the model's
        r && c && r.final_answer !== undefined && r.final_answer !== null && !same(r.final_answer, r.answer)
          ? h("span", { class: "cqa-rv-then" }, h("span", { text: "→", attrs: { "aria-hidden": "true" } }), tag(answerTag(c, r.final_answer).kind, answerTag(c, r.final_answer).text, { data: { test: "review-final-answer" } }))
          : null,
        h("span", { class: ["cqa-sc-pts", "num"], text: points, data: { test: "review-points" } }),
      ),
      r?.explanation ? h("p", { class: "cqa-sc-why", text: r.explanation }) : null,
      r?.answer === "na" && r.na_reason ? h("p", { class: "cqa-sc-na", text: r.na_reason }) : null,
    );

    const comment = h(
      "div",
      { class: "cqa-rv-comment" },
      h("p", { class: "cqa-rv-label", text: t("review.comment") }),
      h("p", { class: "cqa-rv-quote", text: appeal.comment, data: { test: "review-comment" } }),
    );

    clear(el).append(head, disputed, comment, buildFragment(r), opinionBox, decisionBox);
    paintOpinion();
    paintDecision();
  }

  function buildFragment(r) {
    const lines = Array.isArray(view.conversation?.transcript) ? view.conversation.transcript : [];
    const picked = fragmentIndexes(r, lines.length);
    const marked = new Set((r?.evidence ?? []).map((item) => item?.message_index));
    const at = offsets(lines);
    const items = [];
    picked.forEach((index, n) => {
      if (n > 0 && index !== picked[n - 1] + 1) items.push(h("li", { class: "cqa-rv-gap", text: "…", attrs: { "aria-hidden": "true" } }));
      const message = lines[index];
      const kind = speakerKind(message?.speaker);
      const clock = formatOffset(at[index]) || (typeof message?.timestamp === "string" ? message.timestamp : "");
      items.push(
        h(
          "li",
          { class: ["cqa-rv-msg", `cqa-rv-msg--${kind}`, marked.has(index) && "is-evidence"], data: { test: "fragment-msg", index } },
          h("span", { class: "cqa-rv-msg-meta", text: [t("scorecard.evidenceLine", { n: index + 1 }), kind === "system" ? null : t(`transcript.speaker.${kind}`), clock].filter(Boolean).join(" · ") }),
          h("p", { class: "cqa-rv-msg-text", text: typeof message?.text === "string" ? message.text : "" }),
        ),
      );
    });
    return h(
      "div",
      { class: "cqa-rv-fragment", data: { test: "review-fragment" } },
      h("p", { class: "cqa-rv-label", text: t("review.fragment") }),
      items.length > 0 ? h("ol", { class: "cqa-rv-msgs" }, items) : h("p", { class: "cqa-rv-none", text: t("review.noFragment") }),
    );
  }

  function paintOpinion() {
    const { second_opinion: opinion, second_opinion_status: status } = view.appeal;
    const c = criterion();
    opinionBox.setAttribute("data-state", status ?? "unavailable");
    clear(opinionBox).append(h("p", { class: "cqa-rv-label", text: t("review.opinion") }));
    if (status === "pending") opinionBox.append(h("p", { class: "cqa-rv-note", text: t("review.opinionPending") }));
    else if (status === "done" && opinion) {
      opinionBox.append(
        h(
          "div",
          { class: "cqa-rv-opinion-body" },
          c && opinion.answer !== undefined && opinion.answer !== null ? tag(answerTag(c, opinion.answer).kind, t("review.opinionAnswer", { answer: answerTag(c, opinion.answer).text })) : null,
          opinion.reasoning ? h("p", { class: "cqa-rv-note", text: opinion.reasoning }) : null,
          h("p", { class: "cqa-rv-hint", text: t("review.opinionAdvice") }),
        ),
      );
    } else opinionBox.append(h("p", { class: "cqa-rv-note", text: t("review.opinionUnavailable") }));
  }

  function paintDecision() {
    clear(decisionBox).append(h("p", { class: "cqa-rv-label", text: t("review.decision") }));
    const { appeal } = view;
    if (appeal.status !== "open") {
      decisionBox.append(decidedView());
      return;
    }
    if (store.get().role !== "reviewer") {
      decisionBox.append(h("p", { class: "cqa-rv-note", text: t("review.readOnly"), data: { test: "decision-readonly" } }));
      return;
    }
    decisionBox.append(decisionForm());
  }

  function decidedView() {
    const { decision } = view.appeal;
    const c = criterion();
    const box = h("div", { class: "cqa-rv-decided", data: { test: "decision-done" } });
    if (decision) {
      const what = decision.outcome === "changed" && c ? t("review.decidedChanged", { answer: answerTag(c, decision.answer).text }) : t("review.decidedConfirmed");
      box.append(h("b", { class: "cqa-rv-decided-what", text: what }), decision.reason ? h("p", { class: "cqa-rv-note", text: decision.reason }) : null);
    }
    if (view.result) {
      box.append(h("p", { class: "cqa-rv-result", text: t("review.result", { from: totalText(view.result.before), to: totalText(view.result.after) }), data: { test: "decision-result" } }));
    }
    return box;
  }

  function decisionForm() {
    const c = criterion();
    const r = result();
    const current = r ? (r.final_answer ?? r.answer) : null;
    const choices = c ? answerChoices(c) : [];
    if (view.answer === null || !choices.some((a) => same(a, view.answer))) view.answer = choices.find((a) => !same(a, current)) ?? choices[0] ?? null;

    const submit = h("button", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { type: "submit" }, text: t("review.submit"), data: { test: "decision-submit" } });
    const paintSubmit = () => {
      submit.disabled = view.busy || view.outcome === null || view.reason.trim() === "" || (view.outcome === "changed" && view.answer === null);
    };

    const outcomeButton = (outcome, test) =>
      h("button", {
        class: ["cqa-rv-choice", view.outcome === outcome && "is-on"],
        attrs: { type: "button", "aria-pressed": String(view.outcome === outcome) },
        text: t(`review.${outcome}`),
        data: { test },
        on: {
          click: () => {
            view.outcome = outcome;
            paintDecision();
          },
        },
      });

    let picker = null;
    if (view.outcome === "changed") {
      const select = h(
        "select",
        {
          class: "cqa-sc-select",
          attrs: { "aria-label": t("review.newAnswer") },
          data: { test: "decision-answer" },
          on: {
            change: () => {
              view.answer = parseAnswerValue(select.value);
              paintSubmit();
            },
          },
        },
        choices.map((answer) => h("option", { attrs: { value: answerValue(answer) }, text: stepLabel(c, answer) })),
      );
      if (view.answer !== null) select.value = answerValue(view.answer);
      picker = h("label", { class: "cqa-rv-field" }, h("span", { class: "cqa-rv-label", text: t("review.newAnswer") }), select);
    }

    const reason = h("textarea", {
      class: "cqa-rv-text",
      attrs: { rows: "3", "aria-label": t("review.reason"), placeholder: t("review.reasonPlaceholder") },
      data: { test: "decision-reason" },
      on: {
        input: () => {
          view.reason = reason.value;
          paintSubmit();
        },
      },
    });
    reason.value = view.reason;
    paintSubmit();

    return h(
      "form",
      {
        class: "cqa-rv-form",
        data: { test: "decision-form" },
        on: {
          submit: (event) => {
            event.preventDefault();
            decide();
          },
        },
      },
      h("div", { class: "cqa-rv-choices", attrs: { role: "group", "aria-label": t("review.decision") } }, outcomeButton("confirmed", "decision-confirm"), outcomeButton("changed", "decision-change")),
      picker,
      h("label", { class: "cqa-rv-field" }, h("span", { class: "cqa-rv-label", text: t("review.reason") }), reason),
      h("div", { class: "cqa-rv-acts" }, submit),
    );
  }

  async function decide() {
    if (view.busy || view.outcome === null || view.reason.trim() === "") return;
    view.busy = true;
    paintDecision();
    const before = view.evaluation.final_total;
    try {
      const body = { outcome: view.outcome, reason: view.reason.trim() };
      if (view.outcome === "changed") body.answer = view.answer;
      const evaluation = await api.decideAppeal(appealId, body);
      const appeal = await api.getAppeal(appealId);
      if (destroyed) return;
      view.evaluation = evaluation?.results ? evaluation : await api.getEvaluation(view.appeal.evaluation_id);
      view.appeal = appeal;
      view.result = { before, after: view.evaluation.final_total };
      view.busy = false;
      store.set((state) => ({ queueRefresh: (state.queueRefresh ?? 0) + 1 }));
      draw();
      onDecided?.(appeal);
    } catch (error) {
      if (destroyed) return;
      view.busy = false;
      paintDecision();
      toastError(store, error, { retry: decide });
    }
  }

  // ---- wiring ---------------------------------------------------------------------------------

  stops.push(
    watch(store, (state) => state.role, () => {
      if (view.appeal && !destroyed) paintDecision();
    }),
  );
  load();

  return {
    el,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(pollTimer);
      stops.forEach((stop) => stop());
    },
  };
}
