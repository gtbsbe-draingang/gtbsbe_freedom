// Toasts live in store.toasts: [{id, kind: "error" | "info", text, retry}]. toast() adds one,
// renderToasts() draws them. Info toasts dismiss themselves; an error stays until closed.
import { t } from "../i18n/ru.js";
import { watch } from "../state/store.js";
import { clear, h } from "./dom.js";
import { icon } from "./icons.js";

const MAX_TOASTS = 4;
const INFO_MS = 5000;
const KINDS = ["error", "info"];
let nextId = 1;

// The Russian text for an error. Server and developer messages never reach the user.
// A code may carry a suffix after a colon (`bad_record:3`): the text is looked up by the part
// before it, and a numeric suffix on bad_record names the record (the server counts from 0).
export function errorText(error) {
  const full = typeof error?.code === "string" ? error.code : "";
  const colon = full.indexOf(":");
  const code = colon < 0 ? full : full.slice(0, colon);
  const suffix = colon < 0 ? "" : full.slice(colon + 1);
  if (code === "bad_record" && /^\d+$/.test(suffix)) return t("error.bad_record_at", { n: Number(suffix) + 1 });
  const key = `error.${code}`;
  const text = code ? t(key) : key;
  return text === key ? t("error.generic") : text;
}

export function dismissToast(store, id) {
  const toasts = store.get().toasts ?? [];
  if (!toasts.some((entry) => entry.id === id)) return;
  store.set({ toasts: toasts.filter((entry) => entry.id !== id) });
}

/**
 * @param {{get: Function, set: Function}} store
 * @param {{kind?: "error" | "info", text: string, retry?: () => void}} toast
 * @returns {number} the toast's id
 */
export function toast(store, { kind = "info", text, retry } = {}) {
  if (!KINDS.includes(kind)) throw new TypeError(`toast: kind must be "error" or "info", got ${JSON.stringify(kind)}`);
  if (typeof text !== "string" || text === "") throw new TypeError("toast: text is required");
  const id = nextId++;
  const entry = { id, kind, text, retry: typeof retry === "function" ? retry : null };
  // The same message again replaces the old one instead of stacking up.
  const rest = (store.get().toasts ?? []).filter((old) => !(old.kind === kind && old.text === text));
  store.set({ toasts: [...rest, entry].slice(-MAX_TOASTS) });
  if (kind === "info") {
    const timer = setTimeout(() => dismissToast(store, id), INFO_MS);
    timer.unref?.();
  }
  return id;
}

// An error toast from a thrown error. The retry button appears only when the error is retryable.
export function toastError(store, error, { retry } = {}) {
  const canRetry = typeof retry === "function" && (error?.retryable ?? true) === true;
  return toast(store, { kind: "error", text: errorText(error), retry: canRetry ? retry : undefined });
}

// Returns { el, destroy }: the container that shows store.toasts.
export function renderToasts(store) {
  const box = h("div", { class: "cqa-toasts", attrs: { "aria-live": "polite" }, data: { test: "toasts" } });

  const draw = () => {
    clear(box);
    for (const entry of store.get().toasts ?? []) {
      const actions = [];
      if (entry.retry) {
        actions.push(
          h("button", {
            class: "cqa-toast-btn",
            attrs: { type: "button" },
            data: { test: "toast-retry" },
            text: t("toast.retry"),
            on: {
              click: () => {
                dismissToast(store, entry.id);
                entry.retry();
              },
            },
          }),
        );
      }
      box.append(
        h(
          "div",
          { class: ["cqa-toast", `cqa-toast--${entry.kind}`], attrs: { role: entry.kind === "error" ? "alert" : "status" }, data: { test: "toast", kind: entry.kind } },
          icon(entry.kind === "error" ? "alert" : "info", { size: 18 }),
          h("span", { class: "cqa-toast-text", text: entry.text }),
          actions,
          h(
            "button",
            { class: "cqa-toast-close", attrs: { type: "button", "aria-label": t("toast.close") }, data: { test: "toast-close" }, on: { click: () => dismissToast(store, entry.id) } },
            icon("close", { size: 14 }),
          ),
        ),
      );
    }
  };

  const unwatch = watch(store, (state) => state.toasts, draw);
  draw();
  return { el: box, destroy: unwatch };
}
