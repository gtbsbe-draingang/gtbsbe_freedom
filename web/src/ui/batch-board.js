// The batch board: the dialogues of the last batch run, as cards in the middle pane of the
// workspace while no dialogue is open (R9).
//
//   trackBatch(store) -> stop
//     Called once by the app. Mirrors the batch job slot (store `jobs.batch`, job-runner.js) into
//     store `lastBatch` (see mergeBatch) and keeps it when the slot is forgotten (a new selection
//     resets the slot), until the next batch starts.
//
//   mergeBatch(previous, slot) -> lastBatch
//     lastBatch = { key, dialogues: [{id, name, language, channel}], label, lock, ignore,
//                   items: {id: {status, evaluation_id, error}} }
//     `key` and the dialogues come from the slot's meta (the batch bar's runBatch). Items from
//     every job of the batch (the run, then «Повторить неудачные») are merged by dialogue. The job
//     already in the slot when a new batch starts is the previous batch's: `ignore` holds its id.
//
//   createBatchBoard(store, api) -> { el, card, shown, destroy }
//     «Выберите диалог в очереди» until a batch has run; then the progress and a card per dialogue:
//     shimmering while it waits or runs, then its final total (api.getEvaluation) and a gross-error
//     tag; a failed one says so. Each card is a link that opens its dialogue.
//     The board is rebuilt each time it comes back (closing a dialogue): the totals it fetched and
//     its scroll position are kept per store, so it comes back as it was left; the totals are
//     fetched again behind the scenes (an appeal may have changed one).
//     Under the progress, the batch's own actions (the selection bar hides once a batch starts):
//     «Продолжить следить» after a lost connection, «Повторить неудачные» when some failed (both on
//     the batch job slot, job-runner.js) and «Выбрать снова», which ticks the same dialogues in the
//     queue again (the bar comes back, e.g. to run them on another checklist).
//     card(id): the card of that dialogue while at least half of it is in view, else null (the
//     card the shell's motion grows into the scorecard panel, and back);
//     shown(): called by the shell once the board is laid out, to restore the scroll.
import { setLocalizedText } from "../i18n/dom.js";
import { fmt2, rat } from "../domain/rational.js";
import { t } from "../i18n/ru.js";
import { watch } from "../state/store.js";
import { clear, h, placeChildren } from "./dom.js";
import { jobSlot } from "./job-runner.js";
import { BATCH_SLOT } from "./loader.js";
import { href } from "./router.js";

const FETCH_SLOTS = 4;

// per store: { totals: Map(evaluation id -> {total, gross}), scroll: {key, top} | null }
const memories = new WeakMap();
function memoryOf(store) {
  if (!memories.has(store)) memories.set(store, { totals: new Map(), scroll: null });
  return memories.get(store);
}

export function mergeBatch(previous, slot) {
  const meta = slot?.meta;
  if (!meta?.key || !Array.isArray(meta.dialogues)) return previous ?? null;
  const same = previous?.key === meta.key;
  const ignore = same ? previous.ignore : (slot.job?.id ?? null);
  const items = same ? { ...previous.items } : {};
  if (slot.job && slot.job.id !== ignore) {
    for (const item of slot.job.items ?? []) items[item.conversation] = { status: item.status, evaluation_id: item.evaluation_id ?? null, error: item.error ?? null };
  }
  return { key: meta.key, dialogues: meta.dialogues, label: meta.label ?? "", lock: slot.lock ?? null, ignore, items };
}

// The state of one dialogue's card: "starting" before the job exists, then the job's own status.
export function cardState(batch, id) {
  const status = batch.items[id]?.status;
  if (status === "done" || status === "failed" || status === "running" || status === "queued") return status;
  return batch.lock === "starting" || batch.lock === "watching" || batch.lock === "resuming" ? "queued" : "unknown";
}

export function trackBatch(store) {
  return watch(store, (state) => state.jobs?.batch ?? null, (slot) => {
    if (!slot) return; // forgotten: the board keeps showing the last batch
    const next = mergeBatch(store.get().lastBatch ?? null, slot);
    if (next !== (store.get().lastBatch ?? null)) store.set({ lastBatch: next });
  });
}

export function createBatchBoard(store, api) {
  let destroyed = false;
  const memory = memoryOf(store);
  const slot = jobSlot(store, api, BATCH_SLOT);
  const evaluations = new Map(); // evaluation_id -> { total, gross } | "loading" | "failed"
  const waiting = [];
  let active = 0;
  const cards = new Map(); // dialogue id -> { el, paintedState, ... }
  let cardsKey = null;

  const title = h("h2", { class: "cqa-bb-title", text: t("board.label") });
  const checklist = h("span", { class: "cqa-bb-checklist", verbatim: true });
  const progress = h("p", { class: "cqa-bb-progress", attrs: { role: "status", "aria-live": "polite" }, data: { test: "board-progress" } });
  const hint = h("p", { class: "cqa-bb-hint", text: t("board.hint") });
  const actions = h("div", { class: "cqa-bb-actions", data: { test: "board-actions" } }); // outside the live region
  const grid = h("ul", { class: "cqa-bb-grid", attrs: { "aria-label": t("board.label") }, data: { test: "board-grid" } });
  // the cards scroll on their own; the head with the progress stays in view
  const scroller = h("div", { class: "cqa-bb-scroll", data: { test: "board-scroll" } }, grid);
  const board = h("div", { class: "cqa-bb-body" }, h("div", { class: "cqa-bb-head" }, title, checklist, progress, actions, hint), scroller);
  const empty = h(
    "div",
    { class: "cqa-empty", data: { test: "board-empty" } },
    h("b", { class: "cqa-empty-title", text: t("workspace.pick") }),
    h("p", { class: "cqa-empty-note", text: t("board.emptyNote") }),
  );
  const el = h("section", { class: "cqa-bb", attrs: { "aria-label": t("board.label") }, data: { test: "batch-board" } }, empty, board);

  // ---- evaluations of finished dialogues, a few requests at a time ----

  function want(evaluationId) {
    if (evaluations.has(evaluationId)) return;
    evaluations.set(evaluationId, "loading");
    waiting.push(evaluationId);
    pump();
  }
  function pump() {
    while (!destroyed && active < FETCH_SLOTS && waiting.length > 0) {
      const id = waiting.shift();
      active += 1;
      api
        .getEvaluation(id)
        .then(
          (evaluation) => {
            const found = { total: evaluation.final_total ?? null, gross: evaluation.gross_error?.flag === true };
            evaluations.set(id, found);
            memory.totals.set(id, found);
          },
          () => evaluations.set(id, "failed"),
        )
        .finally(() => {
          active -= 1;
          if (!destroyed) {
            paint();
            pump();
          }
        });
    }
  }

  // ---- cards ----

  function buildCard(dialogue) {
    const meta = h("span", { class: "cqa-bb-meta" });
    if (dialogue.language) meta.append(h("span", { verbatim: true, text: dialogue.language }));
    if (dialogue.language && dialogue.channel) meta.append(" · ");
    if (dialogue.channel) meta.append(h("span", { text: t(dialogue.channel === "voice call" ? "queue.channel.call" : "queue.channel.chat") }));
    const status = h("div", { class: "cqa-bb-status" });
    const el = h(
      "a",
      { class: "cqa-bb-card", attrs: { href: href("workspace", { id: dialogue.id }), "aria-label": t("board.open", { id: dialogue.name }) }, data: { test: "board-card", id: dialogue.id } },
      h("div", { class: "cqa-bb-top" }, h("b", { class: "cqa-bb-id", verbatim: true, text: dialogue.name }), meta),
      status,
    );
    return { li: h("li", { class: "cqa-bb-cell" }, el), el, status, painted: null };
  }

  function paintCard(card, batch, id) {
    const state = cardState(batch, id);
    const evaluationId = batch.items[id]?.evaluation_id ?? null;
    if (state === "done" && evaluationId) want(evaluationId);
    let found = evaluationId ? evaluations.get(evaluationId) : undefined;
    // known from an earlier visit: shown at once while it is fetched again
    if ((found === undefined || found === "loading") && memory.totals.has(evaluationId)) found = memory.totals.get(evaluationId);
    const shown = state === "done" ? (found === undefined || found === "loading" ? "loading" : found === "failed" ? "lost" : "done") : state;
    const key = shown === "done" ? `done:${found.total}:${found.gross}` : shown;
    if (card.painted === key) return;
    card.painted = key;
    card.el.setAttribute("data-state", shown);
    card.el.classList.toggle("is-busy", shown === "queued" || shown === "running" || shown === "loading");
    card.el.classList.toggle("is-failed", shown === "failed" || shown === "lost");
    if (shown === "queued" || shown === "running" || shown === "loading") card.el.setAttribute("aria-busy", "true");
    else card.el.removeAttribute("aria-busy");
    clear(card.status);
    const show = (...parts) => card.status.append(...parts.filter(Boolean)); // append(null) would print "null"
    if (shown === "done") {
      const none = found.total === null;
      show(
        h(
          "div",
          { class: "cqa-bb-total" },
          h("b", {
            class: ["cqa-bb-num", "num", none && "is-none"],
            text: none ? t("scorecard.totalNone") : fmt2(rat(found.total)),
            // 0..100 -> 0..1, as the scorecard's total: the CSS mixes red (0) into mint (100)
            style: none ? null : { "--score": Math.max(0, Math.min(100, found.total)) / 100 },
            data: { test: "board-total" },
          }),
          none ? null : h("span", { class: "cqa-bb-out", text: t("scorecard.outOf") }),
        ),
        found.gross ? h("span", { class: "cqa-bb-gross", text: t("queue.tag.grossError"), data: { test: "board-gross" } }) : null,
      );
    } else if (shown === "failed" || shown === "lost") {
      const error = shown === "failed" ? batch.items[id]?.error : null;
      show(
        h("span", { class: "cqa-bb-fail", text: t(shown === "failed" ? "board.failed" : "board.loadFailed") }),
        error ? h("span", { class: "cqa-bb-error", verbatim: true, text: error }) : null,
      );
    } else if (shown !== "unknown") {
      show(
        h("span", { class: "cqa-sc-running" }, h("i", { class: "cqa-sc-pulse", attrs: { "aria-hidden": "true" } }), t(shown === "running" || shown === "loading" ? "scorecard.evaluating" : "board.queued")),
        h("span", { class: ["cqa-sc-shimmer", "cqa-bb-shimmer"], attrs: { "aria-hidden": "true" } }),
      );
    }
  }

  function paint() {
    if (destroyed) return;
    const batch = store.get().lastBatch ?? null;
    empty.hidden = batch !== null;
    board.hidden = batch === null;
    if (!batch) return;

    if (cardsKey !== batch.key) {
      cardsKey = batch.key;
      cards.clear();
      clear(grid);
    }
    setLocalizedText(checklist, batch.label);
    checklist.hidden = !batch.label;
    // cards are kept per dialogue and stay in place, so focus and hover survive a progress tick
    const nodes = batch.dialogues.map((dialogue) => {
      let card = cards.get(dialogue.id);
      if (!card) cards.set(dialogue.id, (card = buildCard(dialogue)));
      paintCard(card, batch, dialogue.id);
      return card.li;
    });
    placeChildren(grid, nodes);

    const total = batch.dialogues.length;
    const states = batch.dialogues.map((d) => cardState(batch, d.id));
    const done = states.filter((s) => s === "done").length;
    const failed = states.filter((s) => s === "failed").length;
    const lost = batch.lock === "interrupted" || batch.lock === "resuming";
    const running = batch.lock !== null && !lost;
    clear(progress);
    clear(actions);
    if (lost) {
      progress.append(h("span", { class: "cqa-bb-fail", text: t("batch.interrupted", { done, total }) }));
      actions.append(button("batch.resume", "batch-resume", () => slot.resume(), { disabled: batch.lock === "resuming" }));
    } else {
      progress.append(h("span", { text: t(running ? "batch.progress" : "batch.done", { done, total }) }));
      if (failed > 0) progress.append(" · ", h("span", { class: "cqa-bb-fail", text: t("batch.failed", { n: failed }) }));
    }
    if (!running && !lost) {
      // the slot holds this batch's job until a new selection starts another batch
      const own = slot.state();
      if (own?.meta?.key === batch.key && (own.job?.failed ?? 0) > 0 && !slot.busy()) actions.append(button("batch.retry", "batch-retry", () => slot.retry()));
      actions.append(
        h("button", {
          class: ["cqa-link", "cqa-bb-reselect"],
          attrs: { type: "button", title: t("board.reselectTitle") },
          text: t("board.reselect"),
          data: { test: "board-reselect" },
          on: { click: () => store.set({ selection: new Set(batch.dialogues.map((d) => d.id)), queueOpen: true }) },
        }),
      );
    }
    actions.hidden = actions.childElementCount === 0;
  }

  function button(key, test, onClick, { disabled = false } = {}) {
    return h("button", { class: "cqa-sc-btn", attrs: { type: "button", disabled }, text: t(key), data: { test }, on: { click: onClick } });
  }

  const stop = watch(store, (state) => state.lastBatch ?? null, paint);
  const stopSlot = slot.watch(() => paint()); // retry is offered only while the slot holds the job
  paint();

  return {
    el,
    card(id) {
      const found = cards.get(id)?.el;
      if (!found || board.hidden) return null;
      const box = found.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      const seen = Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top);
      return box.height > 0 && seen >= box.height / 2 ? found : null;
    },
    shown() {
      if (cardsKey !== null && memory.scroll?.key === cardsKey) scroller.scrollTop = memory.scroll.top;
    },
    destroy() {
      if (cardsKey !== null) memory.scroll = { key: cardsKey, top: scroller.scrollTop };
      destroyed = true;
      stop();
      stopSlot();
    },
  };
}
