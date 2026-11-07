// The appeals page (R7, R8), for both roles: the list with open / decided filters and, when an
// appeal is open (#/appeals/:id), its review panel beside the list. Below 900 px the panel takes
// the page and a link leads back to the list.
//
//   createAppealsPage(store, api, route) -> { el, update(route), destroy }   (routes appeals, appeal)
//
// Data: api.listAppeals; the criterion titles come from each appeal's evaluation and checklist
// version (getEvaluation, getChecklistVersion), fetched once per evaluation.
import { t } from "../i18n/ru.js";
import { clear, h } from "./dom.js";
import { renderReviewPanel } from "./review-panel.js";
import { href } from "./router.js";
import { errorText } from "./toast.js";

export const FILTERS = ["open", "decided", "all"];
const COMMENT_MAX = 120;

const clip = (text) => {
  const line = String(text ?? "").trim().replace(/\s+/g, " ");
  return line.length > COMMENT_MAX ? `${line.slice(0, COMMENT_MAX - 1).trimEnd()}…` : line;
};

// "DEV:p1-ru-001" -> { group: "DEV", conversation: "p1-ru-001" }
export function splitConversation(id) {
  const text = String(id ?? "");
  const at = text.indexOf(":");
  return at < 0 ? { group: "", conversation: text } : { group: text.slice(0, at), conversation: text.slice(at + 1) };
}

/**
 * @param {{get: Function, set: Function, subscribe: Function}} store
 * @param {object} api
 * @param {{name: string, params: object}} route
 */
export function createAppealsPage(store, api, route) {
  const view = { filter: "open", appeals: [], phase: "loading", error: null, titles: new Map() };
  let destroyed = false;
  let panel = null;
  let openId = route.name === "appeal" ? route.params.id : null;
  let run = 0;

  const pills = FILTERS.map((name) => {
    const count = h("span", { class: ["cqa-q-count", "num"] });
    const button = h(
      "button",
      { class: "cqa-q-pill", attrs: { type: "button", "aria-pressed": "false" }, data: { test: `appeals-filter-${name}` }, on: { click: () => setFilter(name) } },
      h("span", { text: t(`appeals.filter.${name}`) }),
      count,
    );
    return { name, button, count };
  });
  const list = h("ul", { class: "cqa-aps-list", attrs: { "aria-label": t("appeals.list") }, data: { test: "appeals-list" } });
  const state = h("div", { class: "cqa-aps-state" });
  const listCol = h("div", { class: "cqa-aps-col" }, h("div", { class: "cqa-q-pills", attrs: { role: "group", "aria-label": t("appeals.filters") } }, pills.map((p) => p.button)), state, list);
  const back = h("a", { class: ["cqa-link", "cqa-aps-back"], attrs: { href: href("appeals") }, text: t("appeals.back"), data: { test: "appeals-back" } });
  const panelCol = h("div", { class: "cqa-aps-panel" });
  const el = h(
    "section",
    { class: ["cqa-view", "cqa-aps"], data: { test: "appeals-page" } },
    h("h1", { class: "cqa-view-title", text: t("nav.appeals") }),
    h("div", { class: "cqa-aps-grid" }, listCol, h("div", { class: "cqa-aps-side" }, back, panelCol)),
  );

  function setFilter(name) {
    if (view.filter === name) return;
    view.filter = name;
    paint();
  }

  const matches = (appeal) => view.filter === "all" || appeal.status === view.filter;

  function row(appeal) {
    const { group, conversation } = splitConversation(appeal.conversation);
    const open = appeal.status === "open";
    const link = h(
      "a",
      { class: "cqa-aps-link", attrs: { href: href("appeal", { id: appeal.id }), "aria-current": appeal.id === openId ? "true" : null } },
      h("span", { class: "cqa-aps-row1" }, h("b", { class: "cqa-q-id", text: conversation }), h("span", { class: ["cqa-tag", open ? "cqa-tag--mid" : "cqa-tag--ok"], text: t(open ? "appeals.status.open" : "appeals.status.decided") })),
      h("span", { class: "cqa-aps-crit", text: view.titles.get(appeal.id) ?? appeal.criterion_id }),
      h("span", { class: "cqa-aps-comment", text: clip(appeal.comment) }),
      group ? h("span", { class: "cqa-q-meta" }, h("span", { class: ["cqa-tag", "cqa-tag--out"], text: group })) : null,
    );
    return h("li", { class: ["cqa-aps-item", appeal.id === openId && "is-current"], data: { test: "appeal-row", id: appeal.id, status: appeal.status } }, link);
  }

  function paint() {
    if (destroyed) return;
    for (const pill of pills) {
      pill.count.textContent = String(view.appeals.filter((a) => pill.name === "all" || a.status === pill.name).length);
      pill.button.setAttribute("aria-pressed", String(pill.name === view.filter));
      pill.button.classList.toggle("is-on", pill.name === view.filter);
    }
    const shown = view.appeals.filter(matches);
    list.replaceChildren(...shown.map(row));
    clear(state);
    const box = (test, title, note) => h("div", { class: "cqa-empty", attrs: { role: "status" }, data: { test } }, h("b", { class: "cqa-empty-title", text: title }), note ? h("p", { class: "cqa-empty-note", text: note }) : null);
    if (view.phase === "loading") state.append(box("appeals-loading", t("appeals.loading")));
    else if (view.phase === "error") {
      state.append(box("appeals-error", t("appeals.loadFailed"), errorText(view.error)));
      state.append(h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("appeals.retry"), on: { click: load } }));
    } else if (shown.length === 0) state.append(box("appeals-empty", t(view.appeals.length === 0 ? "appeals.empty" : "appeals.noMatch"), view.appeals.length === 0 ? t("appeals.emptyNote") : null));
    el.classList.toggle("has-panel", openId !== null);
  }

  // One evaluation and checklist version per appeal's evaluation, for the criterion titles.
  async function titlesFor(appeals) {
    const versions = new Map();
    const byEvaluation = new Map();
    for (const appeal of appeals) {
      if (view.titles.has(appeal.id)) continue;
      if (!byEvaluation.has(appeal.evaluation_id)) {
        byEvaluation.set(
          appeal.evaluation_id,
          api.getEvaluation(appeal.evaluation_id).then((ev) => {
            const key = `${ev.checklist_id}@${ev.version}`;
            if (!versions.has(key)) versions.set(key, api.getChecklistVersion(ev.checklist_id, ev.version));
            return versions.get(key);
          }),
        );
      }
      try {
        const version = await byEvaluation.get(appeal.evaluation_id);
        const criterion = version.criteria.find((c) => c.id === appeal.criterion_id);
        if (criterion) view.titles.set(appeal.id, criterion.title);
      } catch {
        // the row keeps the criterion id
      }
    }
  }

  async function load() {
    const mine = ++run;
    try {
      const appeals = await api.listAppeals();
      if (destroyed || mine !== run) return;
      view.appeals = appeals;
      view.phase = "ready";
      paint();
      await titlesFor(appeals);
      if (!destroyed && mine === run) paint();
    } catch (error) {
      if (destroyed || mine !== run) return;
      view.phase = "error";
      view.error = error;
      paint();
    }
  }

  function showPanel(id) {
    panel?.destroy();
    panel = null;
    clear(panelCol);
    openId = id;
    if (id === null) {
      panelCol.append(h("div", { class: "cqa-empty", data: { test: "appeals-pick" } }, h("b", { class: "cqa-empty-title", text: t("appeals.pick") })));
    } else {
      panel = renderReviewPanel(store, api, id, { onDecided: () => load() });
      panelCol.append(panel.el);
    }
    paint();
  }

  showPanel(openId);
  load();

  return {
    el,
    update(next) {
      const id = next.name === "appeal" ? next.params.id : null;
      if (id !== openId) showPanel(id);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      panel?.destroy();
    },
  };
}
