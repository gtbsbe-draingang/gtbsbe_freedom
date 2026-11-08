// The way back from an open dialogue to the batch board: a small round arrow in the top-left corner
// of the dialogue (transcript.js) and, below 700 px where the dialogue and the scorecard are tabs,
// in the tab strip (shell.js), so it is reachable from both tabs.
//
//   createBackLink(store, {place}) -> { el, destroy }
//     place  "head" | "bar": a class the CSS uses to show one of the two copies per width
//   Shown while a dialogue is open and a batch has run (store `lastBatch`, batch-board.js); never in
//   the compact (embedded) view, which has no board. While the batch still runs, a «5/12» counter
//   rides on the arrow. The link goes to the board (#/); the workspace plays its board <-> dialogue
//   motion backwards (pane-motion.js): the scorecard panel shrinks into its card.
import { setLocalizedAttribute } from "../i18n/dom.js";
import { t } from "../i18n/ru.js";
import { isCompact, watch } from "../state/store.js";
import { cardState } from "./batch-board.js";
import { h } from "./dom.js";
import { icon } from "./icons.js";
import { href } from "./router.js";

// {done, total} while the batch runs, else null.
export function batchProgress(batch) {
  if (!batch || batch.lock === null || batch.lock === "interrupted") return null;
  const done = batch.dialogues.filter((d) => cardState(batch, d.id) === "done").length;
  return { done, total: batch.dialogues.length };
}

export function createBackLink(store, { place = "head" } = {}) {
  const count = h("span", { class: ["cqa-back-count", "num"], verbatim: true, data: { test: "board-back-count" } });
  const el = h(
    "a",
    {
      class: ["cqa-back", `cqa-back--${place}`],
      attrs: { href: href("workspace") },
      data: { test: place === "head" ? "board-back" : "board-back-bar" },
      // the board shows in the middle pane, not in the narrow drawer or on the scorecard tab
      on: { click: () => store.set({ queueOpen: false, pane: "transcript" }) },
    },
    icon("back", { size: 16 }),
    count,
  );

  const paint = () => {
    const state = store.get();
    const batch = state.lastBatch ?? null;
    el.hidden = isCompact(state) || !batch || !state.route?.params?.id;
    if (el.hidden) return;
    const progress = batchProgress(batch);
    count.hidden = progress === null;
    el.classList.toggle("is-running", progress !== null);
    if (progress) count.textContent = `${progress.done}/${progress.total}`;
    const label = progress ? t("board.backProgress", progress) : t("board.back");
    setLocalizedAttribute(el, "aria-label", label);
    setLocalizedAttribute(el, "title", label);
  };
  const stops = [watch(store, (state) => state.lastBatch ?? null, paint), watch(store, (state) => state.route, paint)];
  paint();

  return {
    el,
    destroy() {
      stops.forEach((stop) => stop());
    },
  };
}
