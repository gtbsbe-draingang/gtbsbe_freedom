// The before/after comparison (extra 1, protected; R10 and the guide's demo step 4 end here).
//
//   createComparePage(store, api, route) -> { el, update(route), destroy }
//     route: #/compare?from_checklist&from_version&to_checklist&to_version&group_id
//
// What is compared («Было» / «Стало», two checklist versions, and the group) can be changed on the
// page; each change is a new route. api.getComparison gives the summary
// («12 из 40 диалогов изменились, в среднем −3.50») and one row per dialogue, shown as a table that
// sorts by any column (by Δ, ascending, at first). Picking a row shows both evaluations of that
// dialogue side by side, criterion by criterion: the changed criteria only, until «Показать все
// критерии». The totals are final on both sides, with the reviewers' decisions, and the page says so.
// The evaluations are the newest done ones of each version (api.listEvaluations, newest first),
// the same ones the comparison uses.
import { canonicalJson } from "../domain/fingerprint.js";
import { fmt2, rat } from "../domain/rational.js";
import { t, tp } from "../i18n/ru.js";
import { clear, h } from "./dom.js";
import { href } from "./router.js";
import { answerTag } from "./scorecard.js";
import { errorText, toastError } from "./toast.js";

export const DEFAULT_SORT = { key: "delta", dir: "asc" };
const COLUMNS = ["id", "group", "old", "new", "delta"];

// ---- pure helpers -----------------------------------------------------------------------------

const money = (value) => (typeof value === "number" && Number.isFinite(value) ? fmt2(rat(value)) : "—");

/** A delta with two decimals and its sign: «−3.50», «+7.00», «0.00»; «—» when there is none. */
export function signedText(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const text = fmt2(rat(value));
  if (text === "0.00") return text;
  return text.startsWith("-") ? `−${text.slice(1)}` : `+${text}`;
}

/** «12 из 40 диалогов изменились, в среднем −3.50». */
export function summaryText(summary) {
  return t("compare.summary", {
    changed: summary.changed,
    of: tp("compare.ofDialogs", summary.total),
    verb: tp("compare.changedVerb", summary.changed),
    avg: signedText(summary.avg_delta),
  });
}

const VALUE = {
  id: (row) => String(row.conversation_id ?? row.conversation ?? ""),
  group: (row) => String(row.group_id ?? ""),
  old: (row) => row.old_total,
  new: (row) => row.new_total,
  delta: (row) => row.delta,
};
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * The rows in the order of one column, ascending or descending. A missing number stays last either
 * way; ties keep the dialogue id order. A new array; the input is left as it is.
 * @param {object[]} rows  comparison rows
 * @param {{key: "id" | "group" | "old" | "new" | "delta", dir: "asc" | "desc"}} sort
 */
export function sortRows(rows, { key, dir }) {
  const value = VALUE[key] ?? VALUE.delta;
  const sign = dir === "desc" ? -1 : 1;
  const byId = (a, b) => VALUE.id(a).localeCompare(VALUE.id(b), "ru", { numeric: true });
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (key === "id" || key === "group") return sign * String(x).localeCompare(String(y), "ru", { numeric: true }) || byId(a, b);
    if (!isNumber(x) || !isNumber(y)) return (isNumber(x) ? 0 : 1) - (isNumber(y) ? 0 : 1) || byId(a, b);
    return sign * (x - y) || byId(a, b);
  });
}

/**
 * Both evaluations of one dialogue, criterion by criterion: the new version's criteria in their
 * order, then those only the old version has. A criterion is matched by id; `side` says where it
 * is ("both", "old" or "new"); `reworded` marks one whose content (fingerprint) changed under the
 * same id. `changed`: on one side only, reworded, or another final answer or other points.
 * @returns {{id, side, oldCriterion, newCriterion, oldResult, newResult, reworded, changed}[]}
 */
export function sideRows(fromVersion, toVersion, oldEvaluation, newEvaluation) {
  const resultsOf = (evaluation) => new Map((evaluation?.results ?? []).map((r) => [r.criterion_id, r]));
  const oldResults = resultsOf(oldEvaluation);
  const newResults = resultsOf(newEvaluation);
  const oldCriteria = new Map((fromVersion?.criteria ?? []).map((c) => [c.id, c]));
  const newIds = new Set((toVersion?.criteria ?? []).map((c) => c.id));
  const row = (id, oldCriterion, newCriterion) => {
    const side = oldCriterion && newCriterion ? "both" : oldCriterion ? "old" : "new";
    const oldResult = oldCriterion ? (oldResults.get(id) ?? null) : null;
    const newResult = newCriterion ? (newResults.get(id) ?? null) : null;
    const reworded = side === "both" && Boolean(oldCriterion.fingerprint && newCriterion.fingerprint) && oldCriterion.fingerprint !== newCriterion.fingerprint;
    const same =
      side === "both" &&
      !reworded &&
      oldResult !== null &&
      newResult !== null &&
      canonicalJson(oldResult.final_answer ?? null) === canonicalJson(newResult.final_answer ?? null) &&
      (oldResult.points ?? null) === (newResult.points ?? null);
    return { id, side, oldCriterion: oldCriterion ?? null, newCriterion: newCriterion ?? null, oldResult, newResult, reworded, changed: !same };
  };
  return [
    ...(toVersion?.criteria ?? []).map((c) => row(c.id, oldCriteria.get(c.id), c)),
    ...(fromVersion?.criteria ?? []).filter((c) => !newIds.has(c.id)).map((c) => row(c.id, c, null)),
  ];
}

// The newest done evaluation of a version among a dialogue's evaluations (newest first).
const pickEvaluation = (evaluations, ref) => evaluations.find((e) => e.status === "done" && e.checklist_id === ref.checklist_id && e.version === ref.version) ?? null;

const deltaKind = (delta) => (!isNumber(delta) || delta === 0 ? "na" : delta < 0 ? "bad" : "ok");
const versionsOf = (row) => (Array.isArray(row.versions) && row.versions.length > 0 ? row.versions.map((v) => v.version) : [row.version]);

// ---- the page ---------------------------------------------------------------------------------

export function createComparePage(store, api, route) {
  let destroyed = false;
  let params = route?.params ?? {};
  const view = {
    options: null, // [{checklist_id, version, label}] once the checklists are loaded
    groups: [],
    phase: "loading", // "loading" | "pick" | "ready" | "error"
    error: null,
    data: null, // the comparison
    sort: { ...DEFAULT_SORT },
    open: null, // the conversation whose card is shown
    all: false, // every criterion on the card, not only the changed ones
    side: null, // { phase: "loading" | "ready" | "error", rows, error }
  };
  let loadRun = 0;
  let sideRun = 0;
  const versions = new Map(); // "id@version" -> checklist version, for the cards

  const ref = (prefix) => {
    const checklist_id = params[`${prefix}_checklist`];
    const version = Number(params[`${prefix}_version`]);
    return checklist_id && Number.isInteger(version) && version > 0 ? { checklist_id, version } : null;
  };

  // ---- the head: what is compared ----
  const fromSelect = h("select", { class: "cqa-sc-select", attrs: { "aria-label": t("compare.from") }, data: { test: "compare-from-select" }, on: { change: () => go() } });
  const toSelect = h("select", { class: "cqa-sc-select", attrs: { "aria-label": t("compare.to") }, data: { test: "compare-to-select" }, on: { change: () => go() } });
  const groupSelect = h("select", { class: "cqa-sc-select", attrs: { "aria-label": t("compare.group") }, data: { test: "compare-group" }, on: { change: () => go() } });
  const fromName = h("span", { class: "cqa-cmp-side-name", data: { test: "compare-from" } });
  const toName = h("span", { class: "cqa-cmp-side-name", data: { test: "compare-to" } });
  const summary = h("p", { class: "cqa-cmp-summary", attrs: { "aria-live": "polite" }, data: { test: "compare-summary" } });
  const state = h("div", { class: "cqa-cmp-state" });
  const table = h("div", { class: "cqa-cmp-table-wrap" });
  const card = h("div", { class: "cqa-cmp-card-host" });
  const field = (label, control) => h("label", { class: "cqa-rv-field" }, h("span", { class: "cqa-rv-label", text: label }), control);

  const el = h(
    "section",
    { class: ["cqa-view", "cqa-cmp"], data: { test: "compare-page" } },
    h("h1", { class: "cqa-view-title", text: t("compare.title") }),
    h("p", { class: "cqa-view-note", text: t("compare.note"), data: { test: "compare-note" } }),
    h("div", { class: "cqa-cmp-pick" }, field(t("compare.from"), fromSelect), field(t("compare.to"), toSelect), field(t("compare.group"), groupSelect)),
    h("p", { class: "cqa-cmp-sides" }, fromName, h("span", { class: "cqa-cmp-arrow", attrs: { "aria-hidden": "true" }, text: "→" }), toName),
    summary,
    state,
    h("div", { class: "cqa-cmp-grid" }, table, card),
  );

  function go() {
    const from = view.options?.[Number(fromSelect.value)];
    const to = view.options?.[Number(toSelect.value)];
    window.location.hash = href("compare", {
      from_checklist: from?.checklist_id,
      from_version: from?.version,
      to_checklist: to?.checklist_id,
      to_version: to?.version,
      group_id: groupSelect.value || undefined,
    });
  }

  function fillPickers() {
    const fill = (select, chosen) => {
      clear(select).append(h("option", { attrs: { value: "" }, text: t("compare.choose") }));
      view.options.forEach((o, i) => select.append(h("option", { attrs: { value: i }, text: o.label })));
      const at = chosen ? view.options.findIndex((o) => o.checklist_id === chosen.checklist_id && o.version === chosen.version) : -1;
      select.value = at >= 0 ? String(at) : "";
    };
    fill(fromSelect, ref("from"));
    fill(toSelect, ref("to"));
    const group = params.group_id ?? "";
    const groups = view.groups.includes(group) || group === "" ? view.groups : [...view.groups, group];
    clear(groupSelect).append(h("option", { attrs: { value: "" }, text: t("compare.group.all") }), ...groups.map((g) => h("option", { attrs: { value: g }, text: g })));
    groupSelect.value = group;
  }

  const sideLabel = (side) => {
    if (side && side.name !== undefined) return t("scorecard.checklistOption", { name: side.name || side.checklist_id, version: side.version });
    const option = view.options?.find((o) => o.checklist_id === side?.checklist_id && o.version === side?.version);
    return option?.label ?? "";
  };

  // ---- loading ----
  async function boot() {
    try {
      const [rows, items] = await Promise.all([api.listChecklists(), api.listConversations()]);
      if (destroyed) return;
      view.options = rows.flatMap((row) =>
        [...versionsOf(row)].sort((a, b) => b - a).map((version) => ({ checklist_id: row.checklist_id, version, label: t("scorecard.checklistOption", { name: row.name ?? row.checklist_id, version }) })),
      );
      view.groups = [...new Set(items.map((item) => item.group_id).filter((g) => typeof g === "string" && g !== ""))].sort();
      fillPickers();
      paintHead();
    } catch (error) {
      if (!destroyed) toastError(store, error, { retry: boot });
    }
  }

  async function load() {
    const mine = ++loadRun;
    const from = ref("from");
    const to = ref("to");
    view.data = null;
    view.open = null;
    view.side = null;
    if (!from || !to) {
      view.phase = "pick";
      paint();
      return;
    }
    view.phase = "loading";
    paint();
    try {
      const data = await api.getComparison({ from_checklist: from.checklist_id, from_version: from.version, to_checklist: to.checklist_id, to_version: to.version, group_id: params.group_id || undefined });
      if (destroyed || mine !== loadRun) return;
      view.data = data;
      view.phase = "ready";
      view.error = null;
    } catch (error) {
      if (destroyed || mine !== loadRun) return;
      view.phase = "error";
      view.error = error;
    }
    paint();
  }

  async function versionOf(side) {
    const key = `${side.checklist_id}@${side.version}`;
    if (!versions.has(key)) versions.set(key, api.getChecklistVersion(side.checklist_id, side.version));
    try {
      return await versions.get(key);
    } catch (error) {
      versions.delete(key); // asked again next time
      throw error;
    }
  }

  async function openRow(row) {
    const mine = ++sideRun;
    view.open = row.conversation;
    view.side = { phase: "loading", rows: [], error: null, row };
    paint();
    const from = ref("from");
    const to = ref("to");
    try {
      const [fromVersion, toVersion, fromEvals, toEvals] = await Promise.all([
        versionOf(from),
        versionOf(to),
        api.listEvaluations({ conversation: row.conversation, checklist_id: from.checklist_id }),
        from.checklist_id === to.checklist_id ? null : api.listEvaluations({ conversation: row.conversation, checklist_id: to.checklist_id }),
      ]);
      if (destroyed || mine !== sideRun) return;
      const rows = sideRows(fromVersion, toVersion, pickEvaluation(fromEvals, from), pickEvaluation(toEvals ?? fromEvals, to));
      view.side = { phase: "ready", rows, error: null, row };
    } catch (error) {
      if (destroyed || mine !== sideRun) return;
      view.side = { phase: "error", rows: [], error, row };
    }
    paintCard();
  }

  // ---- painting ----
  function paintHead() {
    const data = view.data;
    fromName.textContent = `${t("compare.from")}: ${data ? sideLabel(data.from) : sideLabel(ref("from"))}`;
    toName.textContent = `${t("compare.to")}: ${data ? sideLabel(data.to) : sideLabel(ref("to"))}`;
  }

  function stateBox(test, title, note, extra) {
    return h("div", { class: "cqa-empty", attrs: { role: "status" }, data: { test } }, h("b", { class: "cqa-empty-title", text: title }), note ? h("p", { class: "cqa-empty-note", text: note }) : null, extra);
  }

  function paint() {
    if (destroyed) return;
    paintHead();
    clear(state);
    clear(table);
    summary.textContent = "";
    if (view.phase === "pick") state.append(stateBox("compare-pick", t("compare.pickTitle"), t("compare.pickNote")));
    else if (view.phase === "loading") state.append(stateBox("compare-loading", t("compare.loading")));
    else if (view.phase === "error") {
      state.append(stateBox("compare-error", t("compare.loadFailed"), errorText(view.error), h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("compare.retry"), on: { click: () => load() } })));
    } else if (view.data.rows.length === 0) {
      state.append(stateBox("compare-empty", t("compare.empty"), t("compare.emptyNote")));
    } else {
      summary.textContent = summaryText(view.data.summary);
      table.append(buildTable());
    }
    paintCard();
  }

  function buildTable() {
    const head = h(
      "tr",
      {},
      COLUMNS.map((key) => {
        const on = view.sort.key === key;
        return h(
          "th",
          { class: ["cqa-cmp-th", `cqa-cmp-col--${key}`], attrs: { scope: "col", "aria-sort": on ? (view.sort.dir === "asc" ? "ascending" : "descending") : "none" } },
          h(
            "button",
            {
              class: ["cqa-cmp-sort", on && "is-on"],
              attrs: { type: "button", title: t("compare.sortBy", { column: t(`compare.col.${key}`) }) },
              data: { test: "compare-sort", key },
              on: { click: () => sortBy(key) },
            },
            h("span", { text: t(`compare.col.${key}`) }),
            h("span", { class: "cqa-cmp-sort-mark", attrs: { "aria-hidden": "true" }, text: on ? (view.sort.dir === "asc" ? "↑" : "↓") : "" }),
          ),
        );
      }),
    );
    const body = sortRows(view.data.rows, view.sort).map((row) => {
      const open = row.conversation === view.open;
      return h(
        "tr",
        {
          class: ["cqa-cmp-row", open && "is-open"],
          data: { test: "compare-row", id: row.conversation, delta: isNumber(row.delta) ? String(row.delta) : "" },
          on: {
            click: (event) => {
              if (event.target instanceof Element && event.target.closest("button, a")) return;
              openRow(row); // the rest of the row counts as the button
            },
          },
        },
        h(
          "td",
          { class: "cqa-cmp-col--id" },
          h("button", { class: "cqa-cmp-open", attrs: { type: "button", "aria-expanded": String(open), title: t("compare.openTitle") }, data: { test: "compare-open" }, on: { click: () => openRow(row) } }, h("b", { text: row.conversation_id ?? row.conversation, data: { test: "compare-id" } })),
        ),
        h("td", { class: "cqa-cmp-col--group", text: row.group_id ?? "" }),
        h("td", { class: ["cqa-cmp-col--old", "num"], text: money(row.old_total) }),
        h("td", { class: ["cqa-cmp-col--new", "num"], text: money(row.new_total) }),
        h("td", { class: ["cqa-cmp-col--delta", "num"] }, h("span", { class: ["cqa-tag", `cqa-tag--${deltaKind(row.delta)}`], text: signedText(row.delta), data: { test: "compare-delta" } })),
      );
    });
    return h("table", { class: "cqa-cmp-table", attrs: { "aria-label": t("compare.table") }, data: { test: "compare-table" } }, h("thead", {}, head), h("tbody", {}, body));
  }

  function sortBy(key) {
    view.sort = view.sort.key === key ? { key, dir: view.sort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
    clear(table).append(buildTable());
  }

  function cell(test, criterion, result, present) {
    if (!present) return h("div", { class: ["cqa-cmp-cell", "is-absent"], data: { test } }, h("span", { class: "cqa-cmp-absent", text: t("compare.side.absent") }));
    if (!result) return h("div", { class: "cqa-cmp-cell", data: { test } }, h("span", { class: "cqa-cmp-absent", text: t("compare.side.noResult") }));
    const tag = answerTag(criterion, result.final_answer ?? result.answer);
    return h(
      "div",
      { class: "cqa-cmp-cell", data: { test } },
      h("span", { class: ["cqa-tag", `cqa-tag--${tag.kind}`], text: tag.text, data: { test: "compare-answer" } }),
      criterion?.kind === "gross_error" ? null : h("span", { class: ["cqa-cmp-points", "num"], text: money(result.points) }),
    );
  }

  function paintCard() {
    clear(card);
    const side = view.side;
    if (!side || !view.data) return;
    const row = side.row;
    const toggle = h("input", { attrs: { type: "checkbox" }, data: { test: "compare-all" }, on: { change: () => { view.all = toggle.checked; paintCard(); } } });
    toggle.checked = view.all;
    const parts = [
      h(
        "div",
        { class: "cqa-cmp-card-head" },
        h("b", { class: "cqa-cmp-card-title", text: t("compare.side.title", { id: row.conversation_id ?? row.conversation }) }),
        h("a", { class: "cqa-link", attrs: { href: href("workspace", { id: row.conversation }) }, text: t("compare.side.open"), data: { test: "compare-link" } }),
      ),
      h("p", { class: ["cqa-cmp-card-totals", "num"], text: t("compare.side.totals", { old: money(row.old_total), new: money(row.new_total), delta: signedText(row.delta) }) }),
      h("label", { class: "cqa-cmp-all" }, toggle, h("span", { text: t("compare.side.all") })),
    ];
    if (side.phase === "loading") parts.push(stateBox("compare-side-loading", t("compare.side.loading")));
    else if (side.phase === "error") parts.push(stateBox("compare-side-error", t("compare.side.loadFailed"), errorText(side.error), h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("compare.retry"), on: { click: () => openRow(row) } })));
    else {
      const shown = side.rows.filter((r) => view.all || r.changed);
      if (shown.length === 0) parts.push(h("p", { class: "cqa-rv-note", text: t("compare.side.none"), data: { test: "compare-side-none" } }));
      else {
        parts.push(
          h("div", { class: ["cqa-cmp-crit", "cqa-cmp-crit--head"], attrs: { "aria-hidden": "true" } }, h("span", {}), h("span", { text: t("compare.from") }), h("span", { text: t("compare.to") })),
          h(
            "ul",
            { class: "cqa-cmp-crits", attrs: { "aria-label": t("compare.side.criteria") } },
            shown.map((r) => {
              const criterion = r.newCriterion ?? r.oldCriterion;
              return h(
                "li",
                { class: ["cqa-cmp-crit", r.changed && "is-changed"], data: { test: "compare-crit", id: r.id, side: r.side, changed: String(r.changed) } },
                h(
                  "div",
                  { class: "cqa-cmp-crit-name" },
                  h("span", { text: criterion.title ?? r.id }),
                  r.side === "old" ? h("span", { class: ["cqa-tag", "cqa-tag--out"], text: t("compare.side.onlyOld") }) : null,
                  r.side === "new" ? h("span", { class: ["cqa-tag", "cqa-tag--out"], text: t("compare.side.onlyNew") }) : null,
                  r.reworded ? h("span", { class: "cqa-cmp-reworded", text: t("compare.side.reworded", { title: r.oldCriterion.title ?? r.id }) }) : null,
                ),
                cell("compare-old", r.oldCriterion, r.oldResult, r.side !== "new"),
                cell("compare-new", r.newCriterion, r.newResult, r.side !== "old"),
              );
            }),
          ),
        );
      }
    }
    card.append(h("section", { class: "cqa-cmp-card", attrs: { "aria-label": t("compare.side.label") }, data: { test: "compare-side" } }, parts));
    // the open row is marked in the table
    for (const tr of table.querySelectorAll("tr[data-id]")) {
      const open = tr.getAttribute("data-id") === view.open;
      tr.classList.toggle("is-open", open);
      tr.querySelector("button")?.setAttribute("aria-expanded", String(open));
    }
  }

  boot();
  load();
  return {
    el,
    update(next) {
      params = next?.params ?? {};
      if (view.options) fillPickers();
      load();
    },
    destroy() {
      destroyed = true;
    },
  };
}
