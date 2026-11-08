// How the workspace moves between the batch board and an open dialogue (shell.js). The motion is
// decoration only: the DOM change is the same with or without it, and it never blocks the change.
//
//   motionMode({reduced, viewTransitions}) -> "fade" | "morph" | "slide"
//     "fade" when the user asks for reduced motion (a short fade of the new panes); "morph" when
//     the browser has view transitions with types (Chrome and Edge 125+, Safari 18.2+): the card
//     of the dialogue grows into the scorecard's brand panel; otherwise "slide" (CSS animations of
//     the new panes only).
//
//   createPaneMotion(root) -> { swapPanes, busy, skip, destroy }
//     root       the workspace element (.cqa-ws); the classes below go on it
//     busy()     true while a view transition runs; skip() ends it at once (its DOM change stays)
//
//   swapPanes({direction, swap, ready?, mark?}) -> ViewTransition | null
//     direction  "open" (board -> dialogue) or "close" (dialogue -> board): the transition type
//                cqa-open / cqa-close that motion.css keys on
//     swap()     changes the DOM, synchronously
//     ready()    a promise for the new panes' first content; the morph waits for it at most
//                READY_WAIT_MS, so the panel it lands on shows the total rather than «Загрузка»
//     mark(when) "old": before the snapshot of the old DOM; "new": right after swap(); "clear":
//                when the motion ends. Marks the card that morphs (.is-vt-hero).
//   Classes on root: cqa-ws--vt while a view transition runs (it names the elements that move),
//   cqa-ws--arrive (staggered rows) and cqa-ws--arrive-slide / cqa-ws--arrive-fade (the panes
//   themselves, without view transitions) for ARRIVE_MS after the swap.

export const READY_WAIT_MS = 300;
export const ARRIVE_MS = 900;

export function motionMode({ reduced, viewTransitions }) {
  if (reduced) return "fade";
  return viewTransitions ? "morph" : "slide";
}

function currentMode(doc) {
  const view = doc.defaultView ?? globalThis;
  const reduced = view.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  // types (cqa-open, cqa-close) keep motion.css from touching any other view transition
  const viewTransitions = typeof doc.startViewTransition === "function" && typeof view.ViewTransition === "function" && "types" in view.ViewTransition.prototype;
  return motionMode({ reduced, viewTransitions });
}

const settle = (promise, ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    Promise.resolve(promise)
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });

const quiet = (promise) => promise?.catch?.(() => {}); // a skipped transition rejects `ready`

export function createPaneMotion(root) {
  const doc = root.ownerDocument;
  let timer = null;
  let active = null;

  function arrive(classes) {
    clearTimeout(timer);
    root.classList.remove("cqa-ws--arrive", "cqa-ws--arrive-slide", "cqa-ws--arrive-fade");
    root.classList.add(...classes);
    timer = setTimeout(() => root.classList.remove(...classes), ARRIVE_MS);
  }

  function swapPanes({ direction, swap, ready = () => null, mark = () => {} }) {
    const mode = currentMode(doc);
    if (mode !== "morph") {
      swap();
      arrive(mode === "fade" ? ["cqa-ws--arrive-fade"] : ["cqa-ws--arrive", "cqa-ws--arrive-slide"]);
      return null;
    }
    mark("old");
    root.classList.add("cqa-ws--vt");
    const transition = doc.startViewTransition({
      update: async () => {
        swap();
        arrive(["cqa-ws--arrive"]);
        mark("new");
        await settle(ready(), READY_WAIT_MS);
      },
      types: [`cqa-${direction}`],
    });
    active = transition;
    quiet(transition.ready);
    quiet(transition.updateCallbackDone);
    quiet(transition.finished)?.finally(() => {
      if (active === transition) active = null;
      root.classList.remove("cqa-ws--vt");
      mark("clear");
    });
    return transition;
  }

  return {
    swapPanes,
    // A transition still running: the next change skips it (its DOM change still happens).
    busy: () => active !== null,
    skip() {
      active?.skipTransition();
    },
    destroy() {
      active?.skipTransition();
      clearTimeout(timer);
    },
  };
}
