import { setLocalizedText, setLocalizedAttribute } from "../i18n/dom.js";
// The app shell: header, the route outlet and the toasts. Views plug in through two registries,
// so the pages that come later change one entry each instead of this file's structure:
//
//   panes  { queue(store, api), transcript(store, api, {id}), scorecard(store, api, {id}),
//            board(store, api) } the panes of the workspace route; `board` takes the
//          transcript's place while no dialogue is open;
//   views  { <routeName>(store, api, route) } every other route.
//
// A pane or view returns an HTMLElement or { el, update?(route), destroy?() }. Each falls back to
// a placeholder until its page exists.
import { t, currentLanguage, setLanguage } from "../i18n/ru.js";
import { isCompact, watch } from "../state/store.js";
import { clear, h } from "./dom.js";
import { dropdown } from "./dropdown.js";
import { icon } from "./icons.js";
import { logoMark, logoWord } from "./logo.js";
import { href, navFor } from "./router.js";
import { renderToasts } from "./toast.js";

const NAV = ["workspace", "checklists", "appeals", "analytics"];
const ROLES = ["controller", "reviewer"];

const normalise = (made) => (made instanceof Node ? { el: made } : made);

function placeholder(title, note) {
  return h("div", { class: "cqa-empty" }, h("b", { class: "cqa-empty-title", text: title }), note ? h("p", { class: "cqa-empty-note", text: note }) : null);
}

// ---- header -----------------------------------------------------------------------------------

function roleSwitch(store, track) {
  const label = h("span", { class: "cqa-role-label", data: { test: "role-label" } });
  const button = h(
    "button",
    { class: "cqa-role-btn", attrs: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false" }, data: { test: "role-switch" } },
    h("span", { class: "cqa-role-avatar" }, icon("user", { size: 14 })),
    label,
    icon("chevron", { size: 14 }),
  );
  const items = ROLES.map((role) =>
    h(
      "button",
      {
        class: "cqa-menu-item",
        attrs: { type: "button", role: "menuitemradio", "aria-checked": "false" },
        data: { test: `role-option-${role}`, role },
        on: {
          click: () => {
            store.set({ role });
            close();
            button.focus();
          },
        },
      },
      h("span", { text: t(`role.${role}`) }),
      icon("check", { size: 14 }),
    ),
  );
  const menu = h("div", { class: "cqa-menu", attrs: { role: "menu", "aria-label": t("role.label") }, data: { test: "role-menu" } }, items);
  menu.hidden = true;
  const wrap = h("div", { class: "cqa-role" }, button, menu);

  function open() {
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0]).focus();
  }
  function close() {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }
  button.addEventListener("click", () => (menu.hidden ? open() : close()));
  wrap.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      event.stopPropagation();
      close();
      button.focus();
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !menu.hidden) {
      event.preventDefault();
      const at = items.indexOf(document.activeElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(at + step + items.length) % items.length].focus();
    }
  });
  const onOutside = (event) => {
    if (!wrap.contains(event.target)) close();
  };
  document.addEventListener("pointerdown", onOutside);
  track(() => document.removeEventListener("pointerdown", onOutside));

  const paint = (role) => {
    setLocalizedText(label, t(`role.${role}`));
    setLocalizedAttribute(button, "aria-label", t("role.current", { role: t(`role.${role}`) }));
    for (const item of items) item.setAttribute("aria-checked", String(item.getAttribute("data-role") === role));
  };
  paint(store.get().role);
  track(watch(store, (state) => state.role, paint));
  return wrap;
}

function themeToggle(store, track) {
  const sun = h("span", { class: "cqa-theme-opt" }, icon("sun", { size: 16 }));
  const moon = h("span", { class: "cqa-theme-opt" }, icon("moon", { size: 16 }));
  const button = h(
    "button",
    {
      class: "cqa-theme",
      attrs: { type: "button", role: "switch", "aria-label": t("theme.toggle"), "aria-checked": "false" },
      data: { test: "theme-toggle" },
      on: { click: () => store.set({ theme: store.get().theme === "dark" ? "light" : "dark" }) },
    },
    sun,
    moon,
  );
  const paint = (theme) => {
    button.setAttribute("aria-checked", String(theme === "dark"));
    sun.classList.toggle("is-on", theme !== "dark");
    moon.classList.toggle("is-on", theme === "dark");
  };
  paint(store.get().theme);
  track(watch(store, (state) => state.theme, paint));
  return button;
}

// The mock Dynamics 365 form (dynamics-mock.html, next to index.html) that shows this UI embedded.
// Only on our own page: inside a host the link would open a form within the form.
function dynamicsLink() {
  const label = t("dynamics.open");
  return h("a", { class: "cqa-icon-link", attrs: { href: "dynamics-mock.html", title: label, "aria-label": label }, data: { test: "dynamics-link" } }, icon("frame", { size: 16 }));
}

function datasetBadge(store, track) {
  const value = h("b", { class: "cqa-badge-value", verbatim:true });
  const badge = h(
    "span",
    { class: "cqa-badge", attrs: { title: t("dataset.title") }, data: { test: "dataset-badge" } },
    h("span", { class: "cqa-badge-label", text: t("dataset.label") }),
    " ",
    value,
  );
  const paint = (groupId) => {
    setLocalizedText(value, groupId ?? "");
    setLocalizedAttribute(value, "title", groupId ?? ""); // the whole id when the badge cuts it
  };
  paint(store.get().groupId);
  track(watch(store, (state) => state.groupId, paint));
  return badge;
}

function buildHeader(store, compact, track) {
  const prod = h("span", { class: "cqa-prod", text: t("app.title") });
  const language = h("select", {
    class: "cqa-language", attrs: { "aria-label": t("language.label") }, data: { test: "ui-language" },
    on: { change: () => setLanguage(language.value) },
  }, [["kk", "Қазақша (KAZ)", "KAZ"], ["ru", "Русский (RU)", "RU"], ["en", "English (EN)", "EN"]].map(([value, label, short]) => h("option", { verbatim: true, attrs: { value }, data: { short }, text: label })));
  language.value = currentLanguage();
  const right = h("div", { class: "cqa-right" }, compact ? null : datasetBadge(store, track), dropdown(language, { variant: "pill", lead: "globe" }), roleSwitch(store, track), themeToggle(store, track), store.get().mode === "embedded" ? null : dynamicsLink());
  if (compact) return h("header", { class: ["cqa-top", "cqa-top--compact"] }, prod, right);

  const items = NAV.map((name) => h("a", { class: "cqa-nav-item", attrs: { href: href(name) }, data: { test: `nav-${name}` }, text: t(`nav.${name}`) }));
  const paint = (route) => {
    const active = navFor(route.name);
    NAV.forEach((name, i) => {
      if (name === active) items[i].setAttribute("aria-current", "page");
      else items[i].removeAttribute("aria-current");
    });
  };
  paint(store.get().route);
  track(watch(store, (state) => state.route, paint));

  return h(
    "header",
    { class: "cqa-top" },
    h("a", { class: "cqa-logo", attrs: { href: href("workspace"), "aria-label": t("brand.name") }, data: { test: "logo" } }, logoMark(), logoWord()),
    prod,
    h("nav", { class: "cqa-nav", attrs: { "aria-label": t("nav.label") } }, items),
    right,
  );
}

// ---- workspace --------------------------------------------------------------------------------

// Drag (or arrow-key) handles between the workspace panes, like VS Code's sidebars. The widths live as
// CSS variables on the workspace root and are remembered per browser; narrow layouts hide the handles.
const PANE_LIMITS = { left: [200, 520, 300], right: [300, 640, 390] };
const paneKey = (side) => `cqa-pane-${side}`;
function savedWidth(side) {
  try { const n = Number(globalThis.localStorage?.getItem(paneKey(side))); if (n) return n; } catch { /* default width */ }
  return PANE_LIMITS[side][2];
}
function paneResizer(root, side) {
  const [min, max, fallback] = PANE_LIMITS[side];
  let width = Math.min(max, Math.max(min, savedWidth(side)));
  const apply = () => root.style.setProperty(`--ws-${side}`, `${width}px`);
  let handle;
  const set = (next, save) => {
    width = Math.round(Math.min(max, Math.max(min, next)));
    apply();
    handle.setAttribute("aria-valuenow", String(width));
    if (save) { try { globalThis.localStorage?.setItem(paneKey(side), String(width)); } catch { /* not remembered */ } }
  };
  const sign = side === "left" ? 1 : -1;
  let start = null;
  handle = h("div", {
    class: ["cqa-resizer", `cqa-resizer--${side}`],
    attrs: { role: "separator", "aria-orientation": "vertical", tabindex: "0", "aria-label": t(`workspace.resize.${side}`), "aria-valuemin": String(min), "aria-valuemax": String(max), "aria-valuenow": String(width) },
    data: { test: `resize-${side}` },
    on: {
      pointerdown: (e) => { start = { x: e.clientX, width }; handle.setPointerCapture(e.pointerId); handle.classList.add("is-drag"); e.preventDefault(); },
      pointermove: (e) => { if (start) set(start.width + sign * (e.clientX - start.x), false); },
      pointerup: () => { if (start) { start = null; handle.classList.remove("is-drag"); set(width, true); } },
      dblclick: () => set(fallback, true),
      keydown: (e) => {
        const step = e.shiftKey ? 48 : 16;
        const move = { ArrowLeft: -step, ArrowRight: step }[e.key];
        if (move === undefined) return;
        e.preventDefault();
        set(width + sign * move, true);
      },
    },
  });
  apply();
  return handle;
}

// Returns { el, update(route), destroy() }. The queue is built once; the transcript and the
// scorecard are rebuilt only when the conversation changes.
function workspaceView(store, api, route, panes) {
  const compact = isCompact(store.get());
  const subs = [];
  const track = (fn) => subs.push(fn);

  const queueHost = compact ? null : h("aside", { class: ["cqa-pane", "cqa-pane-queue"], attrs: { id: "cqa-queue", "aria-label": t("workspace.queue") }, data: { test: "queue-pane" } });
  const transcriptHost = h("section", { class: ["cqa-pane", "cqa-pane-transcript"], data: { test: "transcript-pane" } });
  const scorecardHost = h("aside", { class: ["cqa-pane", "cqa-pane-scorecard"], data: { test: "scorecard-pane" } });

  const mounted = new Map(); // host -> handle of the pane inside it
  function fill(host, make, fallback) {
    mounted.get(host)?.destroy?.();
    mounted.delete(host);
    clear(host);
    const made = make ? normalise(make()) : null;
    if (made) {
      mounted.set(host, made);
      host.append(made.el);
    } else {
      host.append(fallback());
    }
  }

  let id = null;
  function fillConversation(next) {
    id = next;
    const args = { id };
    fill(
      transcriptHost,
      id ? (panes.transcript ? () => panes.transcript(store, api, args) : null) : panes.board ? () => panes.board(store, api) : null,
      () => placeholder(id ?? t("workspace.pick"), id ? t("view.soon") : null),
    );
    fill(
      scorecardHost,
      id && panes.scorecard ? () => panes.scorecard(store, api, args) : null,
      () => placeholder(t("workspace.scorecard"), id ? t("view.soon") : null),
    );
  }

  if (queueHost) fill(queueHost, panes.queue ? () => panes.queue(store, api) : null, () => placeholder(t("workspace.queue"), t("view.soon")));
  fillConversation(route.params.id ?? null);

  // Below 900 px the queue is a drawer; below 700 px the two panes are tabs.
  const toggle = compact
    ? null
    : h(
        "button",
        {
          class: "cqa-queue-toggle",
          attrs: { type: "button", "aria-controls": "cqa-queue", "aria-expanded": "false" },
          data: { test: "queue-toggle" },
          on: { click: () => store.set({ queueOpen: !store.get().queueOpen }) },
        },
        icon("list", { size: 16 }),
        h("span", { text: t("workspace.queue") }),
      );
  const tabs = ["transcript", "scorecard"].map((pane) =>
    h("button", { class: "cqa-tab", attrs: { type: "button", role: "tab", "aria-selected": "false" }, data: { test: `tab-${pane}` }, text: t(`workspace.tab.${pane}`), on: { click: () => store.set({ pane }) } }),
  );
  const bar = h("div", { class: "cqa-ws-bar" }, toggle, h("div", { class: "cqa-tabs", attrs: { role: "tablist" } }, tabs));
  const scrim = compact
    ? null
    : h("button", { class: "cqa-scrim", attrs: { type: "button", tabindex: "-1", "aria-label": t("workspace.queueClose") }, data: { test: "queue-scrim" }, on: { click: () => store.set({ queueOpen: false }) } });

  const grid = h("div", { class: "cqa-ws-grid" }, queueHost, transcriptHost, scorecardHost);
  const el = h(
    "div",
    {
      class: ["cqa-ws", compact && "cqa-ws--compact"],
      data: { test: "workspace" },
      on: {
        keydown: (event) => {
          if (event.key === "Escape" && store.get().queueOpen) {
            store.set({ queueOpen: false });
            toggle?.focus();
          }
        },
      },
    },
    bar,
    scrim,
    grid,
  );
  grid.append(...[queueHost ? paneResizer(el, "left") : null, paneResizer(el, "right")].filter(Boolean));

  const paint = () => {
    const { queueOpen, pane } = store.get();
    const open = Boolean(queueOpen) && !compact;
    el.classList.toggle("cqa-ws--queue-open", open);
    el.classList.toggle("cqa-ws--pane-scorecard", pane === "scorecard");
    // No dialogue open: the board has the scorecard's column too (no empty «Оценка диалога»).
    el.classList.toggle("cqa-ws--board", id === null && Boolean(panes.board));
    toggle?.setAttribute("aria-expanded", String(open));
    tabs.forEach((tab, i) => tab.setAttribute("aria-selected", String((i === 1) === (pane === "scorecard"))));
  };
  paint();
  track(watch(store, (state) => state.queueOpen, paint));
  track(watch(store, (state) => state.pane, paint));

  return {
    el,
    update(next) {
      const nextId = next.params.id ?? null;
      if (nextId !== id) {
        fillConversation(nextId);
        paint();
      }
    },
    destroy() {
      subs.forEach((off) => off());
      for (const handle of mounted.values()) handle.destroy?.();
      mounted.clear();
    },
  };
}

// ---- other routes -----------------------------------------------------------------------------

function pageView(title, note) {
  return h("section", { class: "cqa-view" }, h("h1", { class: "cqa-view-title", text: title }), note ? h("p", { class: "cqa-view-note", text: note }) : null);
}

function notFoundView() {
  return h(
    "section",
    { class: "cqa-view", data: { test: "notfound" } },
    h("h1", { class: "cqa-view-title", text: t("notfound.title") }),
    h("p", { class: "cqa-view-note" }, h("a", { class: "cqa-link", attrs: { href: href("workspace") }, text: t("notfound.home") })),
  );
}

function defaultView(route) {
  if (route.name === "notfound") return notFoundView();
  return pageView(t(`nav.${route.name === "compare" ? "compare" : navFor(route.name)}`), t("view.soon"));
}

// ---- the shell --------------------------------------------------------------------------------

/**
 * @param {{get: Function, set: Function, subscribe: Function}} store
 * @param {object} api
 * @param {{panes?: object, views?: object}} [registry]
 * @returns {{el: HTMLElement, destroy: () => void}}
 */
export function createShell(store, api, { panes = {}, views = {} } = {}) {
  const el = h("div", { class: "cqa-shell" });
  let teardown = [];
  const track = (fn) => teardown.push(fn);

  function build() {
    teardown.forEach((fn) => fn());
    teardown = [];
    const compact = isCompact(store.get());

    const main = h("div", { class: "cqa-main", attrs: { role: "region", "aria-label": t("app.title") }, data: { test: "main" } });
    let current = null; // { name, view }
    // A view whose factory also serves the new route (the appeals list and one appeal) is updated
    // in place, so its filters and scroll survive.
    const sameView = (route) => current.name === route.name || (Boolean(views[route.name]) && views[current.name] === views[route.name]);
    const show = (route) => {
      if (current && current.view.update && sameView(route)) {
        current.view.update(route);
        return;
      }
      current?.view.destroy?.();
      clear(main);
      const make = route.name === "workspace" ? null : views[route.name];
      const view = route.name === "workspace" ? workspaceView(store, api, route, panes) : normalise(make ? make(store, api, route) : defaultView(route));
      current = { name: route.name, view };
      main.append(view.el);
    };
    show(store.get().route);
    track(watch(store, (state) => state.route, show));
    track(() => current?.view.destroy?.());

    const toasts = renderToasts(store);
    track(toasts.destroy);
    el.replaceChildren(buildHeader(store, compact, track), main, toasts.el);
  }

  build();
  const stopCompact = watch(store, isCompact, build);
  return {
    el,
    destroy() {
      stopCompact();
      teardown.forEach((fn) => fn());
      teardown = [];
    },
  };
}
