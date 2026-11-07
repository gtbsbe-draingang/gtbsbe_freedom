import { setLocalizedText, setLocalizedAttribute } from "../i18n/dom.js";
// The scorecard pane: the checklist picker and the run buttons, the brand panel with the total, the
// sections and the gross-error flag, one card per criterion, and the info that does not count.
//
//   createScorecard(store, api, {id}?) -> { el, destroy }     what the shell mounts (panes.scorecard)
//
// Data: api.getConfig, listChecklists, getChecklistVersion, listEvaluations (the newest finished
// evaluation of this dialogue for the picked checklist version), listAppeals (open ones disable
// «Оспорить»), getConversation (info and facts). A run is startEvaluations + polling getJob; when it
// ends, `queueRefresh` is bumped so the queue reloads its totals, even if the pane was closed in
// the meantime. The picked checklist version lives in store state `checklistSel`, so it survives a
// change of dialogue. The transcript is a sibling pane: it is read from `store.get().transcript`
// at click time (highlight, focusMessage).
import { ApiError } from "../api/errors.js";
import { finalAnswers, score } from "../domain/scoring.js";
import { fmt2, rat } from "../domain/rational.js";
import { formatOffset } from "../domain/time.js";
import { t, grossKindsText } from "../i18n/ru.js";
import { watch } from "../state/store.js";
import { openAppealDrawer } from "./appeal-drawer.js";
import { clear, h } from "./dom.js";
import { dropdown } from "./dropdown.js";
import { href } from "./router.js";
import { toastError } from "./toast.js";
import { renderVoiceMeasurements } from "./voice-measurements.js";
import { latestVersion, versionNumbers } from "../domain/checklist-versions.js";

export const POLL_MS = 500;
export const JOB_TIMEOUT_MS = 15 * 60 * 1000;
// The checklist's threshold for the first reaction after the handover (extra B).
export const FIRST_REACTION_LIMIT_S = 180;

const ACTIVE = new Set(["queued", "running", "pending", "started"]);
const EVIDENCE_QUOTE_MAX = 160;

// ---- pure helpers -----------------------------------------------------------------------------

const money = (value) => fmt2(rat(value));
const isStep = (answer) => answer !== null && typeof answer === "object" && Object.hasOwn(answer, "step");

/** Elapsed run time as m:ss (0:07, 1:42, 12:05). */
export function elapsedText(ms) {
  const seconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// The sections that hold at least one scored criterion, in checklist order (the brand panel's rows).
const scoredSections = (version) => {
  const scored = new Set(version.criteria.filter((c) => c.kind !== "gross_error").map((c) => c.section_id));
  return [...version.sections].sort((a, b) => a.order - b.order).filter((section) => scored.has(section.id));
};

/** The tag of an answer: its kind (ok, mid, bad, na) and its text. A gross-error "yes" is bad. */
export function answerTag(criterion, answer) {
  const gross = criterion?.kind === "gross_error";
  if (answer === "na") return { kind: "na", text: t("scorecard.answer.na") };
  if (answer === "yes") return { kind: gross ? "bad" : "ok", text: t("scorecard.answer.yes") };
  if (answer === "no") return { kind: gross ? "ok" : "bad", text: t("scorecard.answer.no") };
  if (isStep(answer)) {
    const values = (criterion?.scale_steps ?? []).map((step) => step.value).filter((value) => typeof value === "number");
    const top = values.length > 0 ? Math.max(...values) : null;
    const low = values.length > 0 ? Math.min(...values) : null;
    const kind = top === null ? "mid" : answer.step >= top ? "ok" : answer.step <= low ? "bad" : "mid";
    return { kind, text: t("scorecard.answer.step", { value: answer.step }) };
  }
  return { kind: "na", text: "—" };
}

/** "ok" within the 3-minute threshold, "over" beyond it, null when the time is unknown. */
export function thresholdCheck(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  return seconds <= FIRST_REACTION_LIMIT_S ? "ok" : "over";
}

// A job is over when it left the active states or every item has an outcome.
export function jobSettled(job) {
  if (!job) return true;
  return !ACTIVE.has(job.status) || (job.total > 0 && job.done + job.failed >= job.total);
}

const byFiling = (a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));

/**
 * The appeals that concern the evaluation on screen. `evaluations` are this dialogue's evaluations
 * of the same checklist (any version); only those made before the one on screen count as earlier.
 *   own          appeals on this evaluation
 *   earlierOpen  open appeals on an earlier evaluation (still undecided: the card must not hide them)
 *   notCarried   decided appeals on an earlier evaluation that no result's carried_decision names,
 *                as {appeal, when}: "before" = decided before this evaluation was made (the
 *                criterion or the dialogue changed since), "after" = decided later (a new run
 *                would apply it)
 * Each list is in filing order.
 */
export function cardAppeals(evaluation, appeals, evaluations) {
  const created = Date.parse(evaluation.created_at ?? "");
  const earlier = new Set(
    (evaluations ?? [])
      .filter((e) => e.id !== evaluation.id)
      .filter((e) => {
        const at = Date.parse(e.created_at ?? "");
        return !Number.isFinite(at) || !Number.isFinite(created) || at <= created;
      })
      .map((e) => e.id),
  );
  const carried = new Set(evaluation.results.map((r) => r.carried_decision?.appeal_id).filter(Boolean));
  const own = [];
  const earlierOpen = [];
  const notCarried = [];
  for (const appeal of [...(appeals ?? [])].sort(byFiling)) {
    if (appeal.evaluation_id === evaluation.id) own.push(appeal);
    else if (!earlier.has(appeal.evaluation_id)) continue;
    else if (appeal.status === "open") earlierOpen.push(appeal);
    else if (!carried.has(appeal.id)) {
      const decided = Date.parse(appeal.decision?.decided_at ?? "");
      notCarried.push({ appeal, when: Number.isFinite(decided) && Number.isFinite(created) && decided > created ? "after" : "before" });
    }
  }
  return { own, earlierOpen, notCarried };
}

const versionsOf = versionNumbers;
const latestOf = latestVersion;

/**
 * The checklist version to show: the stored choice, else the server's default, else the default
 * checklist's latest version, else the first checklist's latest. null when there are none.
 */
export function pickSelection(stored, server, checklists) {
  const has = (ref) => Boolean(ref) && checklists.some((row) => row.checklist_id === ref.checklist_id && versionsOf(row).includes(ref.version));
  if (has(stored)) return { checklist_id: stored.checklist_id, version: stored.version };
  const fallback = server?.default_checklist;
  if (has(fallback)) return { checklist_id: fallback.checklist_id, version: fallback.version };
  const row = checklists.find((r) => r.checklist_id === fallback?.checklist_id) ?? checklists[0];
  return row ? { checklist_id: row.checklist_id, version: latestOf(row) } : null;
}

// A label for an enum value; an unknown value shows as it is.
function labelled(prefix, value) {
  const key = `${prefix}.${value}`;
  const text = t(key);
  return text === key ? String(value) : text;
}

const clip = (text, max) => {
  const line = String(text ?? "").trim().replace(/\s+/g, " ");
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tag = (kind, text, props = {}) => h("span", { class: ["cqa-tag", `cqa-tag--${kind}`, props.class], text, attrs: props.attrs, data: props.data });
// A tag that opens an appeal (#/appeals/:id).
const tagLink = (kind, text, appealId, { title, test } = {}) =>
  h("a", { class: ["cqa-tag", `cqa-tag--${kind}`, "cqa-tag--link"], text, attrs: { href: href("appeal", { id: appealId }), title: title ?? null }, data: { test } });

// ---- the pane ---------------------------------------------------------------------------------

function stateBox(test, title, note, extra) {
  return h("div", { class: "cqa-empty", attrs: { role: "status" }, data: { test } }, h("b", { class: "cqa-empty-title", text: title }), note ? h("p", { class: "cqa-empty-note", text: note }) : null, extra);
}

function openId(store, args) {
  if (typeof args?.id === "string" && args.id !== "") return args.id;
  const { route, conversationId } = store.get();
  return route?.name === "workspace" && route.params?.id ? route.params.id : (conversationId ?? null);
}

/**
 * @param {{get: Function, set: Function, subscribe: Function}} store
 * @param {object} api
 * @param {{id?: string}} [args]
 * @returns {{el: HTMLElement, destroy: () => void}}
 */
export function createScorecard(store, api, args = {}) {
  const id = openId(store, args);
  const dev = store.get().config?.testHooks === true || Boolean(window.__cqaTest);

  const view = {
    phase: "loading", // "loading" | "ready" | "error"
    error: null,
    server: null, // the API's config
    checklists: [],
    options: [], // [{checklist_id, version, label}] behind the picker
    sel: null, // {checklist_id, version}
    version: null, // the picked checklist version
    evaluation: null, // the newest finished evaluation of this dialogue for it
    evaluations: [], // all of this dialogue's evaluations for the picked checklist (for earlier appeals)
    conversation: null,
    appeals: [],
    busy: false,
    job: null, // null | {phase: "starting" | "running" | "failed", id, done, total}
    active: null, // the criterion id whose evidence is marked in the transcript
  };
  let destroyed = false;
  let pendingSel = null; // a shared checklist change that arrived during our own run
  let runStarted = 0; // Date.now() when the current run began (the loading card's clock)
  let clockTimer = null;
  const stopClock = () => {
    clearInterval(clockTimer);
    clockTimer = null;
  };
  // A run is going from the click until its result is loaded; a failed job is over.
  const isRunning = () => view.job !== null && view.job.phase !== "failed";

  // Shows the shared checklist reference `ref` here, unless it is already shown. A reference this
  // pane does not know (a checklist saved after it loaded) reloads the list first.
  function followShared(ref) {
    pendingSel = null;
    if (destroyed || !ref || id === null) return;
    if (view.sel && view.sel.checklist_id === ref.checklist_id && view.sel.version === ref.version) return;
    if (view.busy) {
      pendingSel = ref;
      return;
    }
    if (!view.options.some((o) => o.checklist_id === ref.checklist_id && o.version === ref.version)) {
      boot();
      return;
    }
    view.sel = { checklist_id: ref.checklist_id, version: ref.version };
    fillSelect();
    loadSelection();
  }
  let loadRun = 0;
  let drawer = null; // the open appeal drawer, if any
  const unwatch = [];

  // ---- toolbar (built once, repainted) --------------------------------------------------------

  const select = h("select", {
    class: "cqa-sc-select",
    attrs: { "aria-label": t("scorecard.checklist") },
    data: { test: "checklist-select" },
    on: {
      change: () => {
        const option = view.options[Number(select.value)];
        if (!option || view.busy) return;
        view.sel = { checklist_id: option.checklist_id, version: option.version };
        store.set({ checklistSel: view.sel });
        loadSelection();
      },
    },
  });
  const runButton = h("button", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { type: "button" }, data: { test: "run-eval" }, on: { click: () => run("reuse") } });
  const fullButton = h("button", {
    class: "cqa-sc-btn",
    text: t("scorecard.runFull"),
    attrs: { type: "button", title: t("scorecard.runFullTitle") },
    data: { test: "run-eval-full" },
    on: { click: () => run("full") },
  });
  const status = h("div", { class: "cqa-sc-status", attrs: { role: "status", "aria-live": "polite" }, data: { test: "job-progress" } });
  const hint = h("p", { class: "cqa-sc-hint", text: t("scorecard.keyMissing"), data: { test: "key-hint" } });
  hint.hidden = true;
  const bar = h(
    "div",
    { class: "cqa-sc-bar" },
    h("div", { class: "cqa-sc-pick" }, h("span", { class: "cqa-sc-pick-label", text: t("scorecard.checklist") }), dropdown(select)),
    h("div", { class: "cqa-sc-run" }, runButton, fullButton),
    hint,
    status,
  );
  const body = h("div", { class: "cqa-sc-body" });
  const el = h("div", { class: "cqa-sc", attrs: { role: "region", "aria-label": t("scorecard.label") }, data: { test: "scorecard" } }, bar, body);

  function fillSelect() {
    clear(select);
    view.options = view.checklists.flatMap((row) =>
      [...versionsOf(row)]
        .sort((a, b) => b - a)
        .map((version) => ({ checklist_id: row.checklist_id, version, label: t("scorecard.checklistOption", { name: row.name ?? row.checklist_id, version }) })),
    );
    view.options.forEach((option, index) => select.append(h("option", { text: option.label, attrs: { value: index } })));
    const at = view.options.findIndex((o) => o.checklist_id === view.sel?.checklist_id && o.version === view.sel?.version);
    if (at >= 0) select.value = String(at);
  }

  function paintBar() {
    if (destroyed) return;
    const keyMissing = view.server?.model_key_configured === false;
    const ready = view.phase === "ready" && view.sel !== null && view.version !== null;
    const off = view.busy || keyMissing || !ready;
    setLocalizedText(runButton, t(view.evaluation ? "scorecard.rerun" : "scorecard.run"));
    for (const button of [runButton, fullButton]) {
      button.disabled = off;
      if (keyMissing) setLocalizedAttribute(button, "title", t("scorecard.keyMissing"));
      else if (button === fullButton) setLocalizedAttribute(button, "title", t("scorecard.runFullTitle"));
      else button.removeAttribute("title");
    }
    hint.hidden = !keyMissing;
    select.disabled = view.busy || view.options.length === 0;

    clear(status);
    const job = view.job;
    if (job?.phase === "starting") status.append(t("scorecard.starting"));
    else if (job?.phase === "running") status.append(t("scorecard.progress", { done: job.done, total: job.total }));
    else if (job?.phase === "failed") {
      status.append(
        h("span", { class: "cqa-sc-failed", text: t("scorecard.jobFailed") }),
        h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("scorecard.retry"), data: { test: "job-retry" }, on: { click: () => retryFailed(job.id) } }),
      );
    }
  }

  // ---- loading --------------------------------------------------------------------------------

  const clearMarks = () => store.get().transcript?.highlight(null, [], null);

  // The newest finished evaluation of this dialogue for the picked version.
  const pickEvaluation = (evaluations, sel) => evaluations.find((e) => e.status === "done" && e.checklist_id === sel.checklist_id && e.version === sel.version) ?? null;

  async function boot() {
    const mine = ++loadRun;
    view.phase = "loading";
    drawBody();
    paintBar();
    try {
      const [server, checklists] = await Promise.all([api.getConfig(), api.listChecklists()]);
      if (destroyed || mine !== loadRun) return;
      view.server = server;
      view.checklists = checklists;
      view.sel = pickSelection(store.get().checklistSel, server, checklists);
      fillSelect();
      if (view.sel === null) {
        view.phase = "ready";
        drawBody();
        paintBar();
        return;
      }
      await loadSelection();
    } catch (error) {
      if (destroyed || mine !== loadRun) return;
      fail(error);
    }
  }

  function fail(error) {
    view.phase = "error";
    view.error = error;
    drawBody();
    paintBar();
  }

  // `quiet`: keep showing what is on screen while the new data comes (after a run).
  async function loadSelection({ quiet = false } = {}) {
    const mine = ++loadRun;
    const sel = view.sel;
    if (!quiet) {
      view.phase = "loading";
      drawBody();
      paintBar();
    }
    try {
      const [version, evaluations, appeals, conversation] = await Promise.all([
        api.getChecklistVersion(sel.checklist_id, sel.version),
        api.listEvaluations({ conversation: id, checklist_id: sel.checklist_id }),
        api.listAppeals(),
        api.getConversation(id),
      ]);
      if (destroyed || mine !== loadRun) return;
      view.version = version;
      view.evaluation = pickEvaluation(evaluations, sel);
      view.evaluations = evaluations;
      view.appeals = appeals;
      view.conversation = conversation;
      view.phase = "ready";
      view.active = null;
      clearMarks();
      checkTotal();
      drawBody();
      paintBar();
    } catch (error) {
      if (destroyed || mine !== loadRun) return;
      fail(error);
    }
  }

  // Development only: the shown total must equal what the exact scoring gives for the same answers.
  function checkTotal() {
    const { evaluation, version, appeals } = view;
    if (!dev || !evaluation || !version) return;
    try {
      const decided = appeals.filter((appeal) => appeal.status === "decided");
      const own = score(version, finalAnswers(evaluation, decided)).total;
      if (own !== evaluation.final_total) console.warn(`scorecard: score() gives ${own}, the server says final_total ${evaluation.final_total} (${evaluation.id})`);
    } catch (error) {
      console.warn("scorecard: the total could not be recomputed", error);
    }
  }

  // ---- running --------------------------------------------------------------------------------

  // Polls until the job is over. It does not stop when the pane is closed: the queue must still
  // hear that the totals changed.
  async function settle(first) {
    let job = first;
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    while (!jobSettled(job)) {
      if (Date.now() > deadline) throw new ApiError("timeout", "The evaluation did not finish in time");
      await sleep(POLL_MS);
      job = await api.getJob(job.id);
      if (!destroyed) {
        view.job = { phase: "running", id: job.id, done: job.done, total: job.total };
        paintBar();
      }
    }
    return job;
  }

  // `start` returns the job (a new one, a resumed one or a retried one); `again` repeats the whole
  // action from the error toast when no job exists yet.
  async function execute(start, again) {
    if (view.busy || destroyed) return;
    view.busy = true;
    view.job = { phase: "starting" };
    runStarted = Date.now();
    drawBody();
    paintBar();
    let jobId = null;
    try {
      const first = await start();
      jobId = first.id;
      if (!destroyed) {
        view.job = { phase: "running", id: first.id, done: first.done, total: first.total };
        paintBar();
      }
      const job = await settle(first);
      view.job = job.failed > 0 ? { phase: "failed", id: job.id, done: job.done, total: job.total } : null;
      store.set((state) => ({ queueRefresh: (state.queueRefresh ?? 0) + 1 }));
      if (!destroyed) await loadSelection({ quiet: true });
    } catch (error) {
      view.job = null;
      drawBody(); // the card shown before the run comes back
      const resume = jobId === null ? again : () => execute(() => api.getJob(jobId), again);
      toastError(store, error, { retry: destroyed ? undefined : resume });
    } finally {
      view.busy = false;
      paintBar();
      if (pendingSel) followShared(pendingSel);
    }
  }

  function run(mode) {
    if (!view.sel) return;
    const { checklist_id, version } = view.sel;
    const again = () => run(mode);
    return execute(() => api.startEvaluations({ conversations: [id], checklist_id, version, mode }), again);
  }

  function retryFailed(jobId) {
    return execute(() => api.retryJob(jobId), () => retryFailed(jobId));
  }

  // ---- drawing --------------------------------------------------------------------------------

  // The cards below a re-run's loading card: still there, dimmed, busy for assistive tech.
  function markStale(on) {
    body.classList.toggle("is-stale", on);
    if (on) body.setAttribute("aria-busy", "true");
    else body.removeAttribute("aria-busy");
  }

  function drawBody() {
    if (destroyed) return;
    stopClock();
    clear(body);
    markStale(false);
    if (view.phase === "loading") {
      body.append(stateBox("scorecard-loading", t("scorecard.loading")));
      return;
    }
    if (view.phase === "error") {
      body.append(
        stateBox(
          "scorecard-error",
          t("scorecard.loadFailed"),
          null,
          h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("scorecard.retry"), data: { test: "scorecard-retry" }, on: { click: boot } }),
        ),
      );
      return;
    }
    if (view.sel === null) {
      body.append(stateBox("scorecard-no-checklist", t("scorecard.noChecklist"), t("scorecard.noChecklistNote")));
      return;
    }
    const info = buildInfo(view.conversation);
    const running = isRunning() && view.version ? buildRunning(view.version) : null;
    if (!view.evaluation) {
      body.append(running ?? stateBox("scorecard-empty", t("scorecard.empty"), t("scorecard.emptyNote")), info);
      return;
    }
    if (running) markStale(true);
    body.append(...[running ?? buildHero(view.evaluation, view.version), buildHistory(view.evaluation, view.version), info, buildCards(view.evaluation, view.version)].filter(Boolean));
  }

  // The brand panel while the evaluator works: same frame as the result, a shimmer where the total
  // goes, an elapsed clock (the job only counts dialogues, so a percentage would be invented), and
  // one moving bar per section. The motion is decorative; the toolbar's status line announces.
  function buildRunning(version) {
    const clock = h("span", { class: ["cqa-sc-clock", "num"], text: elapsedText(Date.now() - runStarted), data: { test: "run-clock" } });
    clockTimer = setInterval(() => {
      clock.textContent = elapsedText(Date.now() - runStarted);
    }, 1000);
    const rows = scoredSections(version).map((section) =>
      h(
        "div",
        { class: "cqa-sc-sec", data: { test: "running-section", section: section.id } },
        h("span", { class: "cqa-sc-sec-name", verbatim: true, text: section.title }),
        h("div", { class: ["cqa-sc-sec-bar", "cqa-sc-sec-bar--busy"] }, h("i")),
      ),
    );
    return h(
      "div",
      { class: ["cqa-sc-hero", "cqa-sc-hero--running"], attrs: { "aria-busy": "true" }, data: { test: "hero-running" } },
      h(
        "div",
        { class: "cqa-sc-hero-top" },
        h("span", { class: "cqa-sc-hero-label" }, `${t("scorecard.totalLabel")} `, h("em", { text: `${version.name} v${version.version}` })),
        h("span", { class: "cqa-sc-running" }, h("i", { class: "cqa-sc-pulse", attrs: { "aria-hidden": "true" } }), t("scorecard.evaluating")),
      ),
      h("div", { class: "cqa-sc-tot" }, h("span", { class: "cqa-sc-shimmer", attrs: { "aria-hidden": "true" } }), clock),
      rows.length > 0 ? h("div", { class: "cqa-sc-secs" }, rows) : null,
      h("p", { class: "cqa-sc-model", text: t("scorecard.evaluatingNote") }),
    );
  }

  // The card history (R8): the original total, each appeal with its decision, the decisions carried
  // in from an earlier evaluation, and the final total. Shown once there is something to tell.
  function buildHistory(evaluation, version) {
    const { own, earlierOpen, notCarried } = cardAppeals(evaluation, view.appeals, view.evaluations);
    const carried = evaluation.results.filter((result) => result.carried_decision);
    if (own.length === 0 && earlierOpen.length === 0 && notCarried.length === 0 && carried.length === 0) return null;

    const criterionOf = (id) => version.criteria.find((c) => c.id === id) ?? { id, title: id };
    const resultOf = (id) => evaluation.results.find((r) => r.criterion_id === id) ?? null;
    const totalText = (value) => (value === null || value === undefined ? t("scorecard.totalNone") : money(value));
    const items = [];
    const item = (kind, what, note, appealId) =>
      items.push(
        h(
          "li",
          { class: ["cqa-sc-hist-item", `cqa-sc-hist-item--${kind}`], data: { test: "history-item", kind } },
          h("b", { class: "cqa-sc-hist-what", text: what }),
          appealId ? h("a", { class: ["cqa-link", "cqa-sc-hist-link"], attrs: { href: href("appeal", { id: appealId }) }, text: t("history.openAppeal") }) : null,
          note ? h("p", { class: "cqa-sc-hist-note", verbatim:true, text: note }) : null,
        ),
      );

    item("original", t("history.original", { total: totalText(evaluation.original_total) }));
    for (const appeal of own) {
      const criterion = criterionOf(appeal.criterion_id);
      const result = resultOf(appeal.criterion_id);
      item("appeal", t("history.appeal", { criterion: criterion.title, answer: result ? answerTag(criterion, result.answer).text : "—" }), appeal.comment, appeal.id);
      const decision = appeal.decision;
      if (decision) {
        const what = decision.outcome === "changed" ? t("history.changed", { answer: answerTag(criterion, decision.answer).text }) : t("history.confirmed");
        item("decision", what, decision.reason);
      } else item("pending", t("history.pending"));
    }
    // Appeals filed on an earlier evaluation of this dialogue: still open, or decided without
    // reaching this one (spec 6: say why instead of dropping them silently).
    for (const appeal of earlierOpen) {
      item("earlier-open", t("history.earlierOpen", { criterion: criterionOf(appeal.criterion_id).title }), appeal.comment, appeal.id);
    }
    for (const { appeal, when } of notCarried) {
      item("not-carried", t(when === "after" ? "history.decidedAfter" : "history.olderVersion", { criterion: criterionOf(appeal.criterion_id).title }), appeal.decision?.reason, appeal.id);
    }
    for (const result of carried) {
      const criterion = criterionOf(result.criterion_id);
      item("carried", t("history.carried", { criterion: criterion.title, answer: answerTag(criterion, result.final_answer ?? result.answer).text }), null, result.carried_decision.appeal_id);
    }
    item("final", t("history.final", { total: totalText(evaluation.final_total) }));

    return h(
      "section",
      { class: "cqa-sc-hist", attrs: { "aria-label": t("history.title") }, data: { test: "history" } },
      h("h3", { class: "cqa-sc-info-title", text: t("history.title") }),
      h("ol", { class: "cqa-sc-hist-list" }, items),
    );
  }

  // The one eligibility rule for «Оспорить» and the drawer: a criterion with an open appeal on this
  // evaluation, or on an earlier one of this dialogue, cannot be disputed again.
  function blockedCriteria(evaluation) {
    const { own, earlierOpen } = cardAppeals(evaluation, view.appeals, view.evaluations);
    return new Set([...own.filter((a) => a.status === "open"), ...earlierOpen].map((a) => a.criterion_id));
  }

  // «Оспорить» (R7): the drawer offers every criterion of this evaluation that blockedCriteria allows.
  function openDrawer(criterionId, button) {
    const { evaluation, version } = view;
    if (!evaluation || !version || destroyed) return;
    const open = blockedCriteria(evaluation);
    const byResult = new Map(evaluation.results.map((r) => [r.criterion_id, r]));
    const sections = new Map(version.sections.map((s) => [s.id, s.order ?? 0]));
    const choices = [...version.criteria]
      .sort((a, b) => (sections.get(a.section_id) ?? 0) - (sections.get(b.section_id) ?? 0) || (a.order ?? 0) - (b.order ?? 0))
      .filter((c) => byResult.has(c.id) && !open.has(c.id))
      .map((c) => {
        const result = byResult.get(c.id);
        return { id: c.id, title: c.title, answer: answerTag(c, result.final_answer ?? result.answer).text };
      });
    drawer?.close();
    drawer = openAppealDrawer({
      host: el.closest(".cqa") ?? el,
      store,
      api,
      evaluationId: evaluation.id,
      choices,
      criterionId,
      returnFocus: button,
      onFiled: () => {
        drawer = null;
        store.set((state) => ({ queueRefresh: (state.queueRefresh ?? 0) + 1 }));
        if (!destroyed) loadSelection({ quiet: true });
      },
    });
  }

  function buildHero(evaluation, version) {
    const none = evaluation.final_total === null || evaluation.final_total === undefined;
    const totalText = none ? t("scorecard.totalNone") : money(evaluation.final_total);
    const changed = evaluation.original_total !== evaluation.final_total;

    const gross = evaluation.gross_error;
    const grossText = gross?.flag ? (gross.kinds?.length > 0 ? t("scorecard.grossOnKinds", { kinds: grossKindsText(gross.kinds) }) : t("scorecard.grossOn")) : t("scorecard.grossOff");

    const rows = scoredSections(version).map((section) => {
      const row = evaluation.sections?.find((s) => s.section_id === section.id);
      const has = row && row.points !== null && row.points !== undefined && row.available !== null && row.available !== undefined;
      const percent = has && typeof row.percent === "number" ? Math.max(0, Math.min(100, row.percent)) : 0;
      return h(
        "div",
        { class: "cqa-sc-sec", data: { test: "section", section: section.id } },
        h("span", { class: "cqa-sc-sec-name", verbatim: true, text: section.title }),
        h("span", {
          class: ["cqa-sc-sec-score", "num"],
          text: has ? t("scorecard.sectionScore", { points: money(row.points), available: money(row.available), percent: money(row.percent ?? 0) }) : t("scorecard.sectionNone"),
          data: { test: "section-score" },
        }),
        h("div", { class: "cqa-sc-sec-bar" }, h("i", { style: { width: `${percent}%` } })),
      );
    });

    const model = [evaluation.model ? t("scorecard.model", { model: evaluation.model }) : null, typeof evaluation.cost_usd === "number" ? t("scorecard.cost", { cost: evaluation.cost_usd.toFixed(evaluation.cost_usd < 1 ? 4 : 2) }) : null].filter(Boolean);

    return h(
      "div",
      { class: "cqa-sc-hero", data: { test: "hero" } },
      h(
        "div",
        { class: "cqa-sc-hero-top" },
        h("span", { class: "cqa-sc-hero-label" }, `${t("scorecard.totalLabel")} `, h("em", { text: `${version.name} v${version.version}` })),
        evaluation.source === "mock" ? h("span", { class: "cqa-sc-demo", text: t("scorecard.demoBadge"), attrs: { title: t("scorecard.demoTitle") }, data: { test: "demo-badge" } }) : null,
      ),
      h(
        "div",
        { class: "cqa-sc-tot" },
        h("b", { class: ["cqa-sc-total", "num", none && "cqa-sc-total--none"], text: totalText, data: { test: "total" } }),
        none ? null : h("span", { class: "cqa-sc-outof", text: t("scorecard.outOf") }),
        changed
          ? h("s", {
              class: ["cqa-sc-was", "num"],
              text: evaluation.original_total === null || evaluation.original_total === undefined ? t("scorecard.totalNone") : money(evaluation.original_total),
              attrs: { title: t("scorecard.originalTitle") },
              data: { test: "total-original" },
            })
          : null,
      ),
      h("div", { class: ["cqa-sc-flag", gross?.flag && "cqa-sc-flag--on"], text: grossText, data: { test: "gross-flag", state: gross?.flag ? "on" : "off" } }),
      rows.length > 0 ? h("div", { class: "cqa-sc-secs", attrs: { role: "group", "aria-label": t("scorecard.sections") }, data: { test: "sections" } }, rows) : null,
      model.length > 0 ? h("p", { class: "cqa-sc-model", text: model.join(" · "), data: { test: "model" } }) : null,
    );
  }

  function buildInfo(conversation) {
    const info = conversation?.info ?? null;
    const facts = conversation?.facts ?? null;
    const rows = [];
    const row = (key, test, ...value) => rows.push(h("div", { class: "cqa-sc-info-row", data: { test } }, h("dt", { text: t(`scorecard.info.${key}`) }), h("dd", {verbatim:key === "topic" || key === "mood"}, ...value)));

    if (info?.topic) row("topic", "info-topic", info.topic);
    const mood = [info?.mood_start, info?.mood_end].filter(Boolean);
    if (mood.length > 0) row("mood", "info-mood", mood.join(" → "));
    if (info?.outcome) row("outcome", "info-outcome", labelled("scorecard.outcome", info.outcome));

    if (facts && typeof facts.first_reaction_seconds === "number") {
      const check = thresholdCheck(facts.first_reaction_seconds);
      row(
        "firstReaction",
        "info-first-reaction",
        formatOffset(facts.first_reaction_seconds),
        " ",
        tag(check === "ok" ? "ok" : "bad", t(check === "ok" ? "scorecard.info.thresholdOk" : "scorecard.info.thresholdOver"), { data: { test: "threshold", state: check } }),
      );
    }
    if (facts && typeof facts.longest_wait_seconds === "number") row("longestWait", "info-longest-wait", formatOffset(facts.longest_wait_seconds));
    if (facts?.ending) row("ending", "info-ending", labelled("scorecard.ending", facts.ending));

    const box = h("section", { class: "cqa-sc-info", attrs: { "aria-label": t("scorecard.info.title") }, data: { test: "info" } }, h("h3", { class: "cqa-sc-info-title", text: t("scorecard.info.title") }), h("dl", { class: "cqa-sc-info-list" }, rows));
    box.hidden = rows.length === 0;
    return box;
  }

  function buildCards(evaluation, version) {
    const byResult = new Map(evaluation.results.map((r) => [r.criterion_id, r]));
    const sections = [...version.sections].sort((a, b) => a.order - b.order);
    const groups = sections
      .map((section) => ({ section, criteria: version.criteria.filter((c) => c.section_id === section.id).sort((a, b) => a.order - b.order) }))
      .filter((group) => group.criteria.length > 0);

    const controller = store.get().role === "controller";
    const cards = new Map(); // criterion id -> card element

    const activate = (criterionId) => {
      view.active = criterionId;
      for (const [key, card] of cards) {
        card.classList.toggle("is-open", key === criterionId);
        card.setAttribute("aria-expanded", String(key === criterionId));
      }
    };
    // A click (or Enter/Space) on the card itself opens it, a second one closes it; buttons and
    // links inside keep their own action.
    const toggle = (criterionId, event) => {
      if (event.target.closest("button, a, input, select, textarea")) return;
      if (event.type === "keydown") {
        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
      }
      activate(view.active === criterionId ? null : criterionId);
    };

    const list = h("div", { class: "cqa-sc-crits", data: { test: "criteria" } });
    for (const { section, criteria } of groups) {
      const items = criteria.filter((c) => byResult.has(c.id)).map((c) => {
        const card = buildCard(c, byResult.get(c.id), { evaluation, controller, activate, toggle });
        cards.set(c.id, card);
        return card;
      });
      if (items.length === 0) continue;
      list.append(h("h3", { class: "cqa-sc-sec-title", verbatim: true, text: section.title }), ...items);
    }
    if (view.active && cards.has(view.active)) activate(view.active);
    return list;
  }

  function buildCard(criterion, result, { evaluation, controller, activate, toggle }) {
    const gross = criterion.kind === "gross_error";
    const shown = result.final_answer ?? result.answer;
    const answer = answerTag(criterion, shown);
    const changed = JSON.stringify(result.answer) !== JSON.stringify(shown);

    let points = "";
    let weight = null;
    if (gross) points = t("scorecard.grossNoScore");
    else if (shown === "na") points = t("scorecard.naWeight");
    else if (typeof result.points === "number" && typeof result.effective_weight === "number") {
      points = t("scorecard.points", { earned: money(result.points), max: money(result.effective_weight) });
      if (typeof criterion.weight === "number" && money(criterion.weight) !== money(result.effective_weight)) {
        weight = t("scorecard.weight", { from: String(criterion.weight), to: money(result.effective_weight) });
      }
    } else points = "—";

    // An open appeal on this evaluation, or on an earlier one of this dialogue (a re-run must not
    // hide it or allow a second appeal on the same criterion).
    const { own, earlierOpen } = cardAppeals(evaluation, view.appeals, view.evaluations);
    const ownOpen = own.find((a) => a.status === "open" && a.criterion_id === criterion.id) ?? null;
    const earlier = earlierOpen.find((a) => a.criterion_id === criterion.id) ?? null;
    const openAppeal = blockedCriteria(evaluation).has(criterion.id);

    const evidence = (result.evidence ?? []).map((item) => {
      const expected = item.role === "expected_here";
      return h(
        "li",
        { class: "cqa-sc-ev-item" },
        h(
          "button",
          {
            class: ["cqa-sc-ev", expected && "cqa-sc-ev--expected"],
            attrs: { type: "button", title: item.quote, "aria-label": t("scorecard.evidenceShow", { n: item.message_index + 1 }) },
            data: { test: "evidence-link", index: item.message_index, role: item.role },
            on: { click: () => jump(criterion, result, item, activate) },
          },
          h("span", { class: "cqa-sc-ev-n", text: `↳ ${t("scorecard.evidenceLine", { n: item.message_index + 1 })}${expected ? ` · ${t("transcript.expectedHere")}` : ""}` }),
          item.quote ? h("span", { class: "cqa-sc-ev-quote", verbatim: true, text: clip(item.quote, EVIDENCE_QUOTE_MAX) }) : null,
        ),
      );
    });

    const range = result.checked_range;
    const marks = [
      result.needs_review ? tag("mid", t("scorecard.needsReview"), { attrs: { title: t("scorecard.needsReviewTitle") }, data: { test: "needs-review" } }) : null,
      result.carried_decision?.appeal_id ? tagLink("out", t("scorecard.carried"), result.carried_decision.appeal_id, { title: t("scorecard.carriedTitle"), test: "carried" }) : null,
      ownOpen ? tagLink("mid", t("scorecard.disputeOpenTag"), ownOpen.id, { test: "appeal-open" }) : null,
      !ownOpen && earlier ? tagLink("mid", t("scorecard.disputeEarlierTag"), earlier.id, { title: t("scorecard.disputeEarlierTitle"), test: "appeal-open-earlier" }) : null,
      changed ? h("span", { class: "cqa-sc-note", text: t("scorecard.modelAnswer", { answer: answerTag(criterion, result.answer).text }), attrs: { title: t("scorecard.modelAnswerTitle") }, data: { test: "model-answer" } }) : null,
      weight ? h("span", { class: ["cqa-sc-note", "num"], text: weight, data: { test: "weight" } }) : null,
    ].filter(Boolean);

    return h(
      "article",
      {
        class: ["cqa-sc-crit", `cqa-sc-crit--${answer.kind}`],
        attrs: { tabindex: "0", "aria-expanded": "false" },
        data: { test: "crit", criterion: criterion.id, answer: typeof shown === "string" ? shown : "step" },
        on: { click: (event) => toggle(criterion.id, event), keydown: (event) => toggle(criterion.id, event) },
      },
      h(
        "div",
        { class: "cqa-sc-r1" },
        h("b", { class: "cqa-sc-crit-title", verbatim: true, text: criterion.title }),
        tag(answer.kind, answer.text, { data: { test: "answer" } }),
        h("span", { class: ["cqa-sc-pts", "num"], text: points, data: { test: "points" } }),
      ),
      marks.length > 0 ? h("div", { class: "cqa-sc-marks" }, marks) : null,
      result.explanation ? h("p", { class: "cqa-sc-why", verbatim: true, text: result.explanation, data: { test: "why" } }) : null,
      shown === "na" && result.na_reason ? h("p", { class: "cqa-sc-na", verbatim: true, text: result.na_reason, data: { test: "na-reason" } }) : null,
      evidence.length > 0 ? h("ul", { class: "cqa-sc-evs" }, evidence) : null,
      renderVoiceMeasurements(view.conversation, result, (measurement) => {
        store.set({ pane: "transcript" });
        const transcript = store.get().transcript;
        transcript?.focusMessage(measurement.message_index);
        transcript?.seekSeconds?.(measurement.from_seconds);
      }),
      range && Number.isInteger(range.from) && Number.isInteger(range.to)
        ? h("p", { class: ["cqa-sc-range", "num"], text: t("scorecard.checkedRange", { from: Math.min(range.from, range.to) + 1, to: Math.max(range.from, range.to) + 1 }), data: { test: "checked-range" } })
        : null,
      result.coaching ? h("div", { class: "cqa-sc-coach", data: { test: "coaching" } }, h("b", { class: "cqa-sc-coach-label", text: t("scorecard.coaching") }), h("p", { class: "cqa-sc-coach-text", verbatim: true, text: result.coaching })) : null,
      controller
        ? h(
            "div",
            { class: "cqa-sc-acts" },
            h("button", {
              class: "cqa-sc-btn",
              text: t("scorecard.dispute"),
              attrs: { type: "button", disabled: openAppeal, title: openAppeal ? t("scorecard.disputeOpenTitle") : null },
              data: { test: "dispute" },
              on: { click: (event) => openDrawer(criterion.id, event.currentTarget) },
            }),
          )
        : null,
    );
  }

  // Marks the criterion's lines in the transcript and scrolls to the clicked one. On a narrow
  // screen the transcript is another tab, so it is brought forward first.
  function jump(criterion, result, item, activate) {
    const transcript = store.get().transcript;
    activate(criterion.id);
    if (!transcript) return;
    store.set({ pane: "transcript" });
    transcript.highlight(criterion.id, result.evidence, result.checked_range, criterion.title);
    transcript.focusMessage(item.message_index);
  }

  // ---- wiring ---------------------------------------------------------------------------------

  // A batch run or an import elsewhere changed the results: show the fresh ones (not during our
  // own run, which reloads by itself).
  unwatch.push(
    watch(store, (state) => state.queueRefresh, () => {
      if (!view.busy && view.phase === "ready" && view.sel) loadSelection({ quiet: true });
    }),
  );

  // The checklist is shared (store `checklistSel`): when another picker (the batch bar) changes
  // it, show the same checklist here. Our own picker's change comes back equal and is ignored; a
  // change during our own run waits until the run is over.
  unwatch.push(watch(store, (state) => state.checklistSel, (ref) => followShared(ref)));

  unwatch.push(store.subscribe((state, previous) => {
    if (state.role === previous.role) return;
    if (state.role !== "controller") drawer?.close(); // only a controller files appeals
    if (view.phase === "ready") drawBody();
  }));

  if (id === null) body.append(stateBox("scorecard-empty", t("workspace.pick")));
  else boot();

  return {
    el,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopClock();
      drawer?.close();
      unwatch.forEach((stop) => stop());
    },
  };
}
