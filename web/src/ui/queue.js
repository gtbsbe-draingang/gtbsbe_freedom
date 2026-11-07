import { setLocalizedText } from "../i18n/dom.js";
// The workspace queue: search, filter pills, a language filter and one row per conversation.
//
//   createQueue(store, api) -> { el, destroy }   what the shell mounts (panes.queue)
//   renderQueue(store, api) -> HTMLElement        the same element, for a caller that never tears it down
//
// The list comes from api.listConversations() once and is filtered here, so the pill counts and
// the "shown" line always agree with the rows. Text search also asks the server (`q`), which sees
// transcripts; those hits are added to the ones found locally. A queue item carries no transcript,
// so a row without info.topic shows the first client line, fetched with getConversation() only for
// rows that scroll into view (a few at a time).
//
// Store state used: `selection` (Set of ids, replaced on every change), `route` (the open row),
// `queueOpen` (closed again after a click, for the narrow drawer) and `queueRefresh` (any number
// that changes: the queue reloads; other views bump it after an import or an evaluation). The
// loader is opened with openImport (loader.js), which also bumps `importRefresh`.
import { t } from "../i18n/ru.js";
import { watch } from "../state/store.js";
import { clear, h } from "./dom.js";
import { icon } from "./icons.js";
import { createBatchBar, openImport } from "./loader.js";
import { href } from "./router.js";
import { errorText, toastError } from "./toast.js";

const IMPORT_ON_EMPTY = "DEV";
const TOPIC_MAX = 80;
const FETCH_SLOTS = 4;
const SERVER_SEARCH_MS = 300;
const SERVER_SEARCH_MIN = 2;

export const FILTERS = ["all", "chats", "calls", "disputed", "new"];
const MATCHES = {
  all: () => true,
  chats: (item) => item.channel === "agent chat",
  calls: (item) => item.channel === "voice call",
  disputed: (item) => item.status === "disputed",
  new: (item) => item.status === "new",
};

// ---- text helpers -----------------------------------------------------------------------------

// One line of at most TOPIC_MAX characters, cut with an ellipsis.
export function clip(text) {
  const line = String(text ?? "").trim().replace(/\s+/g, " ");
  return line.length > TOPIC_MAX ? `${line.slice(0, TOPIC_MAX - 1).trimEnd()}…` : line;
}

// The first non-empty client line of a conversation, or "".
export function firstClientLine(conversation) {
  const lines = Array.isArray(conversation?.transcript) ? conversation.transcript : [];
  const line = lines.find((m) => m?.speaker === "client" && typeof m.text === "string" && m.text.trim() !== "");
  return line ? clip(line.text) : "";
}

const topicOf = (item) => (typeof item.info?.topic === "string" ? item.info.topic.trim() : "");

// The score as shown in a row: the total with a decimal comma, «—» when there is none.
export function scoreText(final) {
  const total = final?.total;
  return typeof total === "number" && Number.isFinite(total) ? String(total).replace(".", ",") : "—";
}

const tag = (kind, text, extra = {}) => h("span", { class: ["cqa-tag", `cqa-tag--${kind}`], text, ...extra });

// ---- the queue --------------------------------------------------------------------------------

/**
 * @param {{get: Function, set: Function, subscribe: Function}} store
 * @param {object} api  the adapter (listConversations, importDataset, getConversation)
 * @returns {{el: HTMLElement, destroy: () => void}}
 */
export function createQueue(store, api) {
  const subs = [];
  let destroyed = false;

  const view = {
    items: [],
    phase: "loading", // "loading" | "importing" | "ready" | "error"
    error: null,
    query: "",
    filter: "all",
    language: "",
    remote: null, // { q, ids: Set } from the server's text search
    groups: false, // more than one group is loaded: rows then name theirs
    group: store.get().queueGroup ?? "", // "" = every group; store `queueGroup`, set by an import
  };
  const rows = new Map(); // id -> { el, topic, check, link, item }
  const firstLines = new Map(); // id -> first client line ("" when none), for rows without a topic

  // ---- controls -------------------------------------------------------------------------------

  const search = h("input", {
    class: "cqa-q-search-input",
    attrs: { type: "search", placeholder: t("queue.search"), "aria-label": t("queue.searchLabel"), autocomplete: "off", spellcheck: "false" },
    data: { test: "queue-search" },
  });
  const searchBox = h("div", { class: "cqa-q-search" }, icon("search", { size: 16 }), search);

  const pills = FILTERS.map((name) => {
    const count = h("span", { class: ["cqa-q-count", "num"] });
    const button = h(
      "button",
      { class: "cqa-q-pill", attrs: { type: "button", "aria-pressed": "false" }, data: { test: `queue-filter-${name}` }, on: { click: () => setFilter(name) } },
      h("span", { text: t(`queue.filter.${name}`) }),
      count,
    );
    return { name, button, count };
  });
  const pillBar = h("div", { class: "cqa-q-pills", attrs: { role: "group", "aria-label": t("queue.filters") } }, pills.map((pill) => pill.button));

  const language = h("select", {
    class: "cqa-q-select",
    attrs: { "aria-label": t("queue.language") },
    data: { test: "queue-language" },
    on: {
      change: () => {
        view.language = language.value;
        paint();
      },
    },
  });

  // The group filter: shown once more than one group is loaded; an import switches it to its group.
  const groupSelect = h("select", {
    class: "cqa-q-select",
    attrs: { "aria-label": t("queue.groupFilter") },
    data: { test: "queue-group-filter" },
    on: { change: () => store.set({ queueGroup: groupSelect.value }) },
  });

  // Select (or unselect) every row the filters show: the control set in one click.
  const selectAll = h("input", {
    class: "cqa-q-check",
    attrs: { type: "checkbox", "aria-label": t("queue.selectAll") },
    data: { test: "queue-select-all" },
    on: { change: () => toggleAllShown() },
  });

  const loadButton = h("button", {
    class: ["cqa-sc-btn", "cqa-q-load"],
    attrs: { type: "button", title: t("queue.loadTitle") },
    text: t("queue.load"),
    data: { test: "open-loader" },
    on: { click: () => openLoaderDrawer() },
  });

  const summary = h("p", { class: "cqa-q-summary", attrs: { "aria-live": "polite" }, data: { test: "queue-count" } });
  const exportLink = h("a", {
    class: "cqa-q-export",
    attrs: { href: "#", download: "cqa-all.csv", title: t("queue.export"), "aria-label": t("queue.export") },
    data: { test: "export-csv" },
    on: {
      click: (event) => {
        try {
          exportLink.href = api.exportCsvUrl(view.group);
          exportLink.download = `cqa-${view.group ? view.group.replace(/[^A-Za-z0-9._-]/g, "_") : "all"}.csv`;
        } catch (error) {
          event.preventDefault();
          toastError(store, error);
        }
      },
    },
  }, icon("download", { size: 16 }));
  const list = h("ul", { class: "cqa-q-list", attrs: { "aria-label": t("queue.list") }, data: { test: "queue-list" } });
  const stateBox = h("div", { class: "cqa-q-state", data: { test: "queue-state" } });
  const body = h("div", { class: "cqa-q-body" }, stateBox, list);
  const batch = createBatchBar(store, api);

  const controls = h(
    "div",
    { class: "cqa-q-controls" },
    pillBar,
    h("div", { class: "cqa-q-sub" }, groupSelect, language),
    h("div", { class: "cqa-q-sub" }, h("label", { class: "cqa-q-all" }, selectAll, summary), h("span", { data: { test: "queue-export" } }, exportLink)),
  );
  const top = h("div", { class: "cqa-q-top" }, searchBox, loadButton);
  const el = h("div", { class: "cqa-q", data: { test: "queue" } }, top, controls, body, batch.el);

  let loader = null;
  function openLoaderDrawer() {
    loader?.close();
    loader = openImport(store, api, el.closest(".cqa") ?? el);
  }

  const shownItems = () => view.items.filter((item) => (view.group === "" || item.group_id === view.group) && (view.language === "" || item.language === view.language) && matchesQuery(item, queryText()) && MATCHES[view.filter](item));

  function toggleAllShown() {
    const shown = shownItems().map((item) => item.id);
    const next = new Set(store.get().selection ?? []);
    const all = shown.length > 0 && shown.every((id) => next.has(id));
    for (const id of shown) {
      if (all) next.delete(id);
      else next.add(id);
    }
    store.set({ selection: next });
  }

  function paintSelectAll(shown) {
    const picked = store.get().selection ?? new Set();
    const on = shown.filter((item) => picked.has(item.id)).length;
    selectAll.checked = shown.length > 0 && on === shown.length;
    selectAll.indeterminate = on > 0 && on < shown.length;
    selectAll.disabled = shown.length === 0;
  }

  // The groups of the loaded items; an unknown chosen group falls back to every group, but only
  // once the list is fresh (an import sets the group before its rows arrive).
  function paintGroups() {
    const groups = [...new Set(view.items.map((item) => item.group_id).filter((g) => typeof g === "string" && g !== ""))].sort();
    if (view.group !== "" && !groups.includes(view.group)) {
      view.group = "";
      if ((store.get().queueGroup ?? "") !== "") store.set({ queueGroup: "" });
    }
    groupSelect.replaceChildren(h("option", { attrs: { value: "" }, text: t("queue.group.all") }), ...groups.map((g) => h("option", { attrs: { value: g }, verbatim:true, text: g })));
    groupSelect.value = view.group;
    groupSelect.hidden = groups.length < 2;
  }

  // ---- filtering ------------------------------------------------------------------------------

  const queryText = () => view.query.trim().toLowerCase();

  function matchesQuery(item, q) {
    if (q === "") return true;
    if (view.remote && view.remote.q === q && view.remote.ids.has(item.id)) return true;
    const haystack = [item.id, item.conversation_id, topicOf(item), firstLines.get(item.id) ?? ""];
    return haystack.some((text) => text.toLowerCase().includes(q));
  }

  function setFilter(name) {
    if (view.filter === name) return;
    view.filter = name;
    paint();
  }

  // Server-side text search: transcripts are not in the list, so the server looks in them. A
  // failure is not shown; the local matches stay.
  let searchTimer = null;
  let searchRun = 0;
  function scheduleServerSearch() {
    clearTimeout(searchTimer);
    searchRun += 1;
    const q = queryText();
    if (q.length < SERVER_SEARCH_MIN) {
      view.remote = null;
      return;
    }
    const run = searchRun;
    searchTimer = setTimeout(async () => {
      try {
        const found = await api.listConversations({ q: view.query.trim() });
        if (destroyed || run !== searchRun) return;
        view.remote = { q, ids: new Set(found.map((item) => item.id)) };
        paint();
      } catch {
        // keep the local matches
      }
    }, SERVER_SEARCH_MS);
  }
  search.addEventListener("input", () => {
    view.query = search.value;
    scheduleServerSearch();
    paint();
  });

  // ---- rows -----------------------------------------------------------------------------------

  const currentId = () => {
    const route = store.get().route;
    return route?.name === "workspace" ? (route.params?.id ?? null) : null;
  };

  // A route change closes the narrow drawer by itself; opening the conversation that is already
  // open changes no route, so the click closes it too.
  function closeDrawer() {
    if (store.get().queueOpen) store.set({ queueOpen: false });
  }

  function go(id) {
    closeDrawer();
    window.location.hash = href("workspace", { id });
  }

  function togglePick(id, on) {
    const next = new Set(store.get().selection ?? []);
    if (on) next.add(id);
    else next.delete(id);
    store.set({ selection: next });
  }

  function buildRow(item) {
    const flags = item.final;
    const tags = [];
    if (flags?.open_appeals > 0) tags.push(tag("mid", flags.open_appeals > 1 ? t("queue.tag.appeals", { n: flags.open_appeals }) : t("queue.tag.appeal"), { data: { test: "queue-tag-appeal" } }));
    if (flags?.gross_error) tags.push(tag("bad", t("queue.tag.grossError"), { data: { test: "queue-tag-gross" } }));
    if (flags?.needs_review) tags.push(tag("out", t("queue.tag.needsReview"), { attrs: { title: t("queue.tag.needsReviewTitle") }, data: { test: "queue-tag-review" } }));

    const scoreTitle = flags ? (typeof flags.total === "number" ? null : t("queue.score.notCalculated")) : t("queue.score.none");
    const topic = h("span", { class: "cqa-q-topic", verbatim:true, data: { test: "queue-topic" } });
    const check = h("input", {
      class: "cqa-q-check",
      attrs: { type: "checkbox", "aria-label": t("queue.select", { id: item.conversation_id }) },
      data: { test: "queue-select" },
      on: { change: () => togglePick(item.id, check.checked) },
    });
    const link = h(
      "a",
      { class: "cqa-q-link", attrs: { href: href("workspace", { id: item.id }) }, on: { click: closeDrawer } },
      h("b", { class: "cqa-q-id", verbatim:true, text: item.conversation_id }),
      h("span", { class: ["cqa-q-score", "num", flags && typeof flags.total === "number" ? "" : "is-none"], text: scoreText(flags), attrs: { title: scoreTitle }, data: { test: "queue-score" } }),
      topic,
      h(
        "span",
        { class: "cqa-q-meta" },
        view.groups ? tag("out", item.group_id, { verbatim:true, attrs: { title: t("queue.group", { group: item.group_id }) }, data: { test: "queue-group" } }) : null,
        tag("out", item.language, { verbatim:true, attrs: { title: t("queue.language.title") }, data: { test: "queue-language-tag" } }),
        h("span", { class: "cqa-q-channel", text: t(item.channel === "voice call" ? "queue.channel.call" : "queue.channel.chat") }),
        tags,
      ),
    );
    const li = h(
      "li",
      {
        class: "cqa-q-item",
        data: { test: "queue-item", id: item.id, channel: item.channel, status: item.status },
        on: {
          click: (event) => {
            if (event.target instanceof Element && event.target.closest("a, label, input")) return;
            go(item.id); // the padding around the link counts as the row
          },
        },
      },
      h("label", { class: "cqa-q-pick" }, check),
      link,
    );
    const row = { el: li, topic, check, link, item };
    paintTopic(row);
    paintCurrent(row);
    check.checked = Boolean(store.get().selection?.has(item.id));
    if (topicOf(item) === "") watchForTopic(row);
    return row;
  }

  function paintTopic(row) {
    const topic = topicOf(row.item);
    setLocalizedText(row.topic, topic !== "" ? topic : (firstLines.get(row.item.id) ?? ""));
  }

  function paintCurrent(row) {
    const on = row.item.id === currentId();
    row.el.classList.toggle("is-current", on);
    if (on) row.link.setAttribute("aria-current", "true");
    else row.link.removeAttribute("aria-current");
  }

  // ---- first client lines: only for rows in view, a few requests at a time ----------------------

  const visible = new Set();
  const waiting = [];
  const inflight = new Set();
  let active = 0;

  function pump() {
    while (!destroyed && active < FETCH_SLOTS && waiting.length > 0) {
      const id = waiting.shift();
      if (!visible.has(id) || firstLines.has(id) || inflight.has(id)) continue; // scrolled away: asked again if it returns
      active += 1;
      inflight.add(id);
      api
        .getConversation(id)
        .then(
          (conversation) => {
            if (destroyed) return;
            firstLines.set(id, firstClientLine(conversation));
            const row = rows.get(id);
            if (row) paintTopic(row);
            if (view.query.trim() !== "") paint(); // a text search now sees this line
          },
          () => {
            // The row simply has no topic line; it is tried again when it scrolls back into view.
          },
        )
        .finally(() => {
          active -= 1;
          inflight.delete(id);
          pump();
        });
    }
  }

  function want(id) {
    if (firstLines.has(id) || inflight.has(id) || waiting.includes(id)) return;
    waiting.push(id);
    pump();
  }

  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const id = entry.target.getAttribute("data-id");
              if (!id) continue;
              if (entry.isIntersecting) {
                visible.add(id);
                want(id);
              } else {
                visible.delete(id);
              }
            }
          },
          { rootMargin: "160px 0px" },
        )
      : null;

  function watchForTopic(row) {
    if (observer) {
      observer.observe(row.el);
    } else {
      visible.add(row.item.id); // no observer: fetch every row once
      want(row.item.id);
    }
  }

  function dropRows() {
    for (const row of rows.values()) observer?.unobserve(row.el);
    rows.clear();
    visible.clear();
    waiting.length = 0;
  }

  // ---- painting -------------------------------------------------------------------------------

  function paintState(kind) {
    clear(stateBox);
    stateBox.hidden = kind === null;
    if (kind === null) return;
    const notes = {
      loading: [t("queue.loading")],
      importing: [t("queue.importing", { group: IMPORT_ON_EMPTY })],
      error: [t("queue.loadFailed"), errorText(view.error)],
      empty: [t("queue.empty"), t("queue.emptyNote")],
      nomatch: [t("queue.noMatch"), t("queue.noMatchNote")],
    };
    const [title, note] = notes[kind];
    stateBox.append(
      h(
        "div",
        { class: "cqa-empty", data: { test: `queue-${kind}` } },
        h("b", { class: "cqa-empty-title", text: title }),
        note ? h("p", { class: "cqa-empty-note", text: note }) : null,
        kind === "error" ? h("button", { class: "cqa-q-retry", attrs: { type: "button" }, data: { test: "queue-retry" }, text: t("queue.retry"), on: { click: () => load() } }) : null,
      ),
    );
  }

  function paintLanguages() {
    const codes = [...new Set(view.items.map((item) => item.language).filter((code) => typeof code === "string" && code !== ""))].sort();
    if (view.language !== "" && !codes.includes(view.language)) view.language = "";
    language.replaceChildren(
      h("option", { attrs: { value: "" }, text: t("queue.language.all") }),
      ...codes.map((code) => h("option", { attrs: { value: code }, text: code })),
    );
    language.value = view.language;
  }

  function paint() {
    if (destroyed) return;
    const hasItems = view.items.length > 0;
    controls.hidden = !hasItems;
    list.hidden = !hasItems;

    let shown = [];
    if (hasItems) {
      const q = queryText();
      const base = view.items.filter((item) => (view.group === "" || item.group_id === view.group) && (view.language === "" || item.language === view.language) && matchesQuery(item, q));
      for (const pill of pills) {
        setLocalizedText(pill.count, String(base.filter(MATCHES[pill.name]).length));
        pill.button.setAttribute("aria-pressed", String(pill.name === view.filter));
        pill.button.classList.toggle("is-on", pill.name === view.filter);
      }
      shown = base.filter(MATCHES[view.filter]);
      list.replaceChildren(
        ...shown.map((item) => {
          let row = rows.get(item.id);
          if (!row) {
            row = buildRow(item);
            rows.set(item.id, row);
          }
          return row.el;
        }),
      );
      setLocalizedText(summary, t("queue.shown", { shown: shown.length, total: view.items.length }));
    } else {
      clear(list);
      setLocalizedText(summary, "");
    }
    paintSelectAll(shown);

    if (hasItems) paintState(shown.length === 0 ? "nomatch" : null);
    else paintState(view.phase === "ready" ? "empty" : view.phase);
  }

  // ---- loading --------------------------------------------------------------------------------

  let loadRun = 0;
  let imported = false; // DEV is imported once per queue, and only when the list is empty

  async function load() {
    const run = ++loadRun;
    const stale = () => destroyed || run !== loadRun;
    if (view.items.length === 0) {
      view.phase = "loading";
      paint();
    }
    try {
      let items = await api.listConversations();
      if (stale()) return;
      if (items.length === 0 && !imported) {
        view.phase = "importing";
        paint();
        await api.importDataset(IMPORT_ON_EMPTY);
        if (stale()) return;
        imported = true;
        items = await api.listConversations();
        if (stale()) return;
      }
      dropRows();
      firstLines.clear();
      view.items = items;
      view.groups = new Set(items.map((item) => item.group_id)).size > 1;
      view.phase = "ready";
      view.error = null;
      view.remote = null;
      paintLanguages();
      paintGroups();
      pruneSelection();
      if (queryText().length >= SERVER_SEARCH_MIN) scheduleServerSearch();
      paint();
    } catch (error) {
      if (stale()) return;
      if (view.items.length > 0) {
        // A refresh failed: keep the rows on screen and say so.
        toastError(store, error, { retry: () => load() });
      } else {
        view.phase = "error";
        view.error = error;
        paint();
      }
    }
  }

  function pruneSelection() {
    const selection = store.get().selection;
    if (!selection || selection.size === 0) return;
    const known = new Set(view.items.map((item) => item.id));
    const kept = [...selection].filter((id) => known.has(id));
    if (kept.length !== selection.size) store.set({ selection: new Set(kept) });
  }

  // ---- store ----------------------------------------------------------------------------------

  subs.push(
    watch(store, (state) => state.selection, (selection) => {
      for (const [id, row] of rows) row.check.checked = Boolean(selection?.has(id));
      paint(); // the select-all box
    }),
  );
  subs.push(watch(store, (state) => state.route, () => rows.forEach(paintCurrent)));
  subs.push(watch(store, (state) => state.queueRefresh, () => load()));
  subs.push(
    watch(store, (state) => state.queueGroup, (group) => {
      view.group = group ?? "";
      groupSelect.value = view.group;
      paint();
    }),
  );

  paint();
  load();

  return {
    el,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(searchTimer);
      subs.forEach((off) => off());
      batch.destroy();
      loader?.close();
      observer?.disconnect();
      rows.clear();
    },
  };
}

export function renderQueue(store, api) {
  return createQueue(store, api).el;
}
