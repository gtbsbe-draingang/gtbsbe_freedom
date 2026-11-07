// mount(el, options) builds the store and the API, renders the shell into `el` and returns the
// handle a host uses. Context comes from outside: mount options, URL parameters and the config
// (see context.js); nothing here reads parent.Xrm.
import { createApi } from "./api/index.js";
import { groupOf, readContext } from "./context.js";
import { createStore, isCompact, watch } from "./state/store.js";
import { createAppealsPage } from "./ui/appeals-page.js";
import { createChecklistEditor } from "./ui/checklist-editor.js";
import { createChecklistsPage } from "./ui/checklists-page.js";
import { createComparePage } from "./ui/compare-page.js";
import { href, parseRoute, sameRoute } from "./ui/router.js";
import { createQueue } from "./ui/queue.js";
import { createScorecard } from "./ui/scorecard.js";
import { createShell } from "./ui/shell.js";
import { renderTranscript } from "./ui/transcript.js";

const THEME_KEY = "cqa-theme";
const DEFAULT_GROUP = "DEV";

// Storage can be missing or throw (private windows, blocked site data, a host's sandbox).
function readStoredTheme() {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function storeTheme(theme) {
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // the choice then lasts until the page closes
  }
}

/**
 * @param {HTMLElement} el
 * @param {{api?: "http" | "mock", apiBase?: string, conversationId?: string, role?: string,
 *          theme?: string, mode?: "standalone" | "embedded", config?: object, search?: string,
 *          panes?: object, views?: object}} [options]
 *   `config` and `search` default to window.CQA_CONFIG and location.search (tests pass their own).
 * @returns {{open(conversationId: string): void, setRole(role: string): void, setTheme(theme: string): void, destroy(): void}}
 */
export function mount(el, options = {}) {
  const config = options.config ?? window.CQA_CONFIG ?? {};
  const ctx = readContext(options.search ?? window.location.search, config, options);

  // Theme: the host or the URL wins; otherwise the stored choice, except when embedded (a host
  // page is not the user's own browser tab); otherwise the config; otherwise light.
  const theme = ctx.themeExplicit || ctx.mode === "embedded" ? ctx.theme : (readStoredTheme() ?? ctx.theme);

  const compactRoute = (id) => ({ name: "workspace", params: { id } });

  const store = createStore({
    config,
    role: ctx.role,
    theme,
    mode: ctx.mode,
    conversationId: ctx.conversationId,
    groupId: groupOf(ctx.conversationId) ?? DEFAULT_GROUP,
    route: isCompact({ mode: ctx.mode, conversationId: ctx.conversationId }) ? compactRoute(ctx.conversationId) : parseRoute(window.location.hash),
    toasts: [],
    selection: new Set(), // ids ticked in the queue; always replaced, never mutated
    queueRefresh: 0, // any change reloads the queue (after an import or an evaluation)
    queueOpen: false, // the queue drawer below 900 px
    pane: "transcript", // the visible pane below 700 px: "transcript" | "scorecard"
    transcript: null, // handle of the open transcript pane: {highlight, focusMessage}; set by the pane itself
    checklistSel: null, // the checklist version picked in the scorecard: {checklist_id, version}; null = the default
  });
  const roleNow = () => store.get().role;
  const api = createApi(
    ctx.api === "mock"
      ? { api: "mock", role: roleNow, devDataUrl: ctx.devDataUrl ?? undefined, devAudioBase: ctx.devAudioBase ?? undefined, mockModelKey: ctx.mockModelKey, mockDelayMs: ctx.mockDelayMs, mockFault: ctx.mockFault }
      : { api: "http", apiBase: ctx.apiBase, role: roleNow },
  );

  el.classList.add("cqa");
  const stops = [];

  stops.push(watch(store, (state) => state.theme, (next) => el.classList.toggle("cqa--dark", next === "dark")));
  el.classList.toggle("cqa--dark", theme === "dark");
  // An embedded page neither reads nor writes the stored choice.
  if (ctx.mode !== "embedded") stops.push(watch(store, (state) => state.theme, storeTheme));
  stops.push(watch(store, isCompact, (next) => el.classList.toggle("cqa--compact", next)));
  el.classList.toggle("cqa--compact", isCompact(store.get()));

  // The route follows the hash; a compact page shows its one conversation whatever the hash says.
  // A new route closes the queue drawer and goes back to the transcript tab.
  const goTo = (route, extra = {}) => {
    if (sameRoute(route, store.get().route) && Object.keys(extra).length === 0) return;
    const id = route.name === "workspace" ? route.params.id : null;
    store.set({ ...extra, route, groupId: groupOf(id) ?? store.get().groupId, queueOpen: false, pane: "transcript" });
  };
  const onHashChange = () => {
    if (!isCompact(store.get())) goTo(parseRoute(window.location.hash));
  };
  window.addEventListener("hashchange", onHashChange);

  if (ctx.testHooks) window.__cqaTest = { api, store, transcript: null }; // `transcript` is filled by the transcript pane

  const shell = createShell(store, api, {
    panes: { queue: createQueue, transcript: renderTranscript, scorecard: createScorecard, ...options.panes },
    views: {
      appeals: createAppealsPage,
      appeal: createAppealsPage,
      checklists: createChecklistsPage,
      checklist: createChecklistEditor,
      editor: createChecklistEditor,
      compare: createComparePage,
      ...options.views,
    },
  });
  el.replaceChildren(shell.el);

  let destroyed = false;
  return {
    // Opens a conversation. Embedded: the page becomes the compact view of that record.
    // Standalone: navigates to it.
    open(conversationId) {
      if (destroyed || typeof conversationId !== "string" || conversationId.trim() === "") return;
      const id = conversationId.trim();
      if (store.get().mode === "embedded") {
        goTo(compactRoute(id), { conversationId: id });
      } else {
        window.location.hash = href("workspace", { id });
        goTo(parseRoute(window.location.hash)); // now, not on the hashchange event that follows
      }
    },
    setRole(role) {
      if (role === "controller" || role === "reviewer") store.set({ role });
    },
    setTheme(next) {
      if (next === "light" || next === "dark") store.set({ theme: next });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener("hashchange", onHashChange);
      stops.forEach((stop) => stop());
      shell.destroy();
      el.replaceChildren();
      el.classList.remove("cqa", "cqa--dark", "cqa--compact");
      if (window.__cqaTest?.store === store) delete window.__cqaTest;
    },
  };
}
