// The checklists page (R1): every checklist with its latest version, channel, criteria, weight
// sum, the locked tag and what it was based on; «Открыть» (the editor), «Копировать» (a new
// checklist based on it) and «Создать чек-лист» (a blank one). Both roles may do all of it.
//
//   createChecklistsPage(store, api, route) -> { el, destroy }
import { t, tp } from "../i18n/ru.js";
import { clear, h } from "./dom.js";
import { href } from "./router.js";
import { errorText, toastError } from "./toast.js";
import { versionNumbers } from "../domain/checklist-versions.js";

export const NEW_ID = "new"; // #/checklists/new/0/edit: a blank checklist, created on save

const versionsOf = versionNumbers;
const weightSum = (row) => (row.criteria ?? []).filter((c) => c.kind !== "gross_error").reduce((acc, c) => acc + (Number(c.weight) || 0), 0);

export function createChecklistsPage(store, api) {
  let destroyed = false;
  const list = h("ul", { class: "cqa-ck-list", attrs: { "aria-label": t("nav.checklists") }, data: { test: "checklists-list" } });
  const state = h("div", { class: "cqa-aps-state" });
  const el = h(
    "section",
    { class: ["cqa-view", "cqa-ck"], data: { test: "checklists-page" } },
    h(
      "div",
      { class: "cqa-ck-head" },
      h("h1", { class: "cqa-view-title", text: t("nav.checklists") }),
      h("a", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { href: href("editor", { checklistId: NEW_ID, version: 0 }) }, text: t("checklists.create"), data: { test: "checklist-create" } }),
    ),
    h("p", { class: "cqa-view-note", text: t("checklists.note") }),
    state,
    list,
  );

  async function copy(row, button) {
    button.disabled = true;
    try {
      const created = await api.createChecklist({ based_on: { checklist_id: row.checklist_id, version: row.version } });
      if (destroyed) return;
      window.location.hash = href("editor", { checklistId: created.checklist_id, version: created.version });
    } catch (error) {
      button.disabled = false;
      toastError(store, error);
    }
  }

  function rowOf(row, rows) {
    const source = row.based_on ? rows.find((r) => r.checklist_id === row.based_on.checklist_id) : null;
    const count = (row.criteria ?? []).length;
    const copyButton = h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("checklists.copy"), data: { test: "checklist-copy" } });
    copyButton.addEventListener("click", () => copy(row, copyButton));
    return h(
      "li",
      { class: "cqa-ck-row", data: { test: "checklist-row", id: row.checklist_id } },
      h(
        "div",
        { class: "cqa-ck-main" },
        h(
          "div",
          { class: "cqa-aps-row1" },
          h("b", { class: "cqa-ck-name", text: row.name ?? row.checklist_id }),
          h("span", { class: "cqa-ck-tags" }, row.locked ? h("span", { class: ["cqa-tag", "cqa-tag--na"], text: t("checklists.locked"), data: { test: "checklist-locked" } }) : null, h("span", { class: ["cqa-tag", "cqa-tag--out"], text: t(`checklists.channel.${row.channel ?? "any"}`) })),
        ),
        h("span", { class: "cqa-ck-meta", text: [t("checklists.version", { version: row.version, count: versionsOf(row).length }), tp("checklists.criteria", count), t("checklists.weights", { sum: weightSum(row) })].join(" · ") }),
        row.based_on
          ? h("span", { class: "cqa-ck-based", text: t("checklists.basedOn", { name: source?.name ?? row.based_on.checklist_id, version: row.based_on.version }), data: { test: "checklist-based-on" } })
          : null,
      ),
      h(
        "div",
        { class: "cqa-ck-acts" },
        h("a", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { href: href("editor", { checklistId: row.checklist_id, version: row.version }) }, text: t("checklists.open"), data: { test: "checklist-open" } }),
        copyButton,
      ),
    );
  }

  async function load() {
    clear(state).append(h("div", { class: "cqa-empty", attrs: { role: "status" } }, h("b", { class: "cqa-empty-title", text: t("checklists.loading") })));
    try {
      const rows = await api.listChecklists();
      if (destroyed) return;
      clear(state);
      list.replaceChildren(...rows.map((row) => rowOf(row, rows)));
    } catch (error) {
      if (destroyed) return;
      clear(state).append(
        h("div", { class: "cqa-empty", attrs: { role: "status" } }, h("b", { class: "cqa-empty-title", text: t("checklists.loadFailed") }), h("p", { class: "cqa-empty-note", text: errorText(error) })),
        h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("appeals.retry"), on: { click: load } }),
      );
    }
  }

  load();
  return {
    el,
    destroy() {
      destroyed = true;
    },
  };
}
