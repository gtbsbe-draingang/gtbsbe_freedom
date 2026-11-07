import { setLocalizedText } from "../i18n/dom.js";
// The checklist editor (R1, R2, R10; routes `checklist` and `editor`, and #/checklists/new/0/edit
// for a blank checklist). Sections and criteria with every field the contract has: title, wording,
// answer type, scale steps (value + label), weight, N/A allowed + condition, gross-error kind and
// its violation kinds, guidance and an optional model.
//
// Against the source (the version opened; for a copy of a locked checklist, the locked version it
// is based on) each criterion carries a badge «новый» / «изменён» / «только вес», and removed
// criteria are listed with a way back. validateChecklist() gives precise field errors (which block
// saving) and the weight-sum warning (which never does).
//
// Saving: a locked checklist → «Сохранить как новый чек-лист» (createChecklist with based_on); an
// unlocked one → «Сохранить версию» (saveChecklistVersion); a blank one → «Создать чек-лист».
// «Применить к диалогам» opens the apply dialog for the saved version.
//
//   createChecklistEditor(store, api, route) -> { el, update(route), destroy }
import { diffVersions } from "../domain/checklist-diff.js";
import { validateChecklist } from "../domain/checklist-validate.js";
import { t } from "../i18n/ru.js";
import { openApplyDialog } from "./apply-dialog.js";
import { NEW_ID } from "./checklists-page.js";
import { clear, h } from "./dom.js";
import { href } from "./router.js";
import { errorText, toastError } from "./toast.js";

const CHANNELS = ["any", "chat", "call"];

const keyOf = (route) => `${route.params.checklistId}@${route.params.version}`;

export function createChecklistEditor(store, api, route) {
  const view = { route, source: null, draft: null, models: [], phase: "loading", error: null, saving: false, savedFor: null };
  let keySeq = 0;
  let destroyed = false;
  let apply = null;
  let loadRun = 0;
  let refs = null;
  const el = h("section", { class: ["cqa-view", "cqa-ed"], data: { test: "editor" } });

  const params = () => ({ id: view.route.params.checklistId, version: Number(view.route.params.version) });
  const isNew = () => params().id === NEW_ID;
  const withKey = (c) => ({ ...c, _key: `k${(keySeq += 1)}` });

  function newCriterion(sectionId) {
    return withKey({ id: undefined, section_id: sectionId, title: "", wording: "", answer_type: "yes_no", scale_steps: [], weight: 0, na_allowed: false, na_condition: null, kind: "scored", kinds: [], guidance: null });
  }

  function toDraft(source) {
    const draft = structuredClone(source);
    if (source.locked) draft.name = t("editor.copyName", { name: source.name });
    draft.criteria = draft.criteria.map(withKey);
    return draft;
  }

  function blankDraft() {
    return { name: t("editor.newName"), description: null, channel: "any", guidance: "", rounding: 2, sections: [{ id: "s1", title: t("editor.newSection"), order: 1 }], criteria: [newCriterion("s1")] };
  }

  // ---- loading --------------------------------------------------------------------------------

  async function load() {
    const mine = ++loadRun;
    view.phase = "loading";
    draw();
    try {
      const config = await api.getConfig().catch(() => null);
      const source = isNew() ? null : await api.getChecklistVersion(params().id, params().version);
      if (destroyed || mine !== loadRun) return;
      view.models = Array.isArray(config?.models) ? config.models : [];
      view.source = source;
      view.draft = source ? toDraft(source) : blankDraft();
      view.phase = "ready";
    } catch (error) {
      if (destroyed || mine !== loadRun) return;
      view.phase = "error";
      view.error = error;
    }
    draw();
  }

  // ---- structure edits (rebuild the form) ------------------------------------------------------

  const sections = () => [...view.draft.sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  function addCriterion(sectionId) {
    const list = view.draft.criteria;
    const last = list.map((c) => c.section_id).lastIndexOf(sectionId);
    const fresh = newCriterion(sectionId);
    list.splice(last < 0 ? list.length : last + 1, 0, fresh);
    draw();
    el.querySelector(`[data-key="${fresh._key}"] [data-test="crit-title"]`)?.focus();
  }

  function moveCriterion(c, sectionId) {
    const list = view.draft.criteria;
    list.splice(list.indexOf(c), 1);
    c.section_id = sectionId;
    const last = list.map((x) => x.section_id).lastIndexOf(sectionId);
    list.splice(last < 0 ? list.length : last + 1, 0, c);
    draw();
  }

  function addSection() {
    const ids = new Set(view.draft.sections.map((s) => s.id));
    let n = view.draft.sections.length + 1;
    while (ids.has(`s${n}`)) n += 1;
    const order = Math.max(0, ...view.draft.sections.map((s) => s.order ?? 0)) + 1;
    view.draft.sections.push({ id: `s${n}`, title: t("editor.newSection"), order });
    draw();
  }

  function restore(id) {
    const original = view.source?.criteria.find((c) => c.id === id);
    if (!original) return;
    if (!view.draft.sections.some((s) => s.id === original.section_id)) view.draft.sections.push(structuredClone(view.source.sections.find((s) => s.id === original.section_id)));
    view.draft.criteria.push(withKey(structuredClone(original)));
    draw();
  }

  // ---- drawing --------------------------------------------------------------------------------

  function field(labelKey, control, error) {
    return h("label", { class: "cqa-rv-field" }, h("span", { class: "cqa-rv-label", text: t(labelKey) }), control, error ?? null);
  }

  function errorEl() {
    const e = h("p", { class: "cqa-ed-err", attrs: { role: "alert" }, data: { test: "field-error" } });
    e.hidden = true;
    return e;
  }

  function input(value, test, onInput, attrs = {}) {
    const control = h("input", { class: "cqa-sc-select", attrs: { type: "text", autocomplete: "off", ...attrs }, data: { test }, on: { input: () => onInput(control.value) } });
    control.value = value === null || value === undefined ? "" : String(value);
    return control;
  }

  function textarea(value, test, onInput, rows = 2) {
    const control = h("textarea", { class: "cqa-ap-text", attrs: { rows: String(rows) }, data: { test }, on: { input: () => onInput(control.value) } });
    control.value = value ?? "";
    return control;
  }

  function select(value, test, options, onChange, label) {
    const control = h(
      "select",
      { class: "cqa-sc-select", attrs: { "aria-label": label }, data: { test }, on: { change: () => onChange(control.value) } },
      options.map(([v, text]) => h("option", { verbatim: test === "crit-section", attrs: { value: v }, text })),
    );
    control.value = value;
    return control;
  }

  function cardOf(c) {
    const errs = new Map();
    const err = (name) => {
      const e = errorEl();
      errs.set(name, e);
      return e;
    };
    const live = (name) => (value) => {
      c[name] = value;
      refresh();
    };
    const gross = c.kind === "gross_error";
    const badge = h("span", { class: "cqa-tag", data: { test: "criterion-badge" } });

    const steps =
      c.answer_type === "scale"
        ? h(
            "div",
            { class: "cqa-ed-steps", data: { test: "crit-steps" } },
            h("span", { class: "cqa-rv-label", text: t("editor.steps") }),
            ...c.scale_steps.map((step, i) =>
              h(
                "div",
                { class: "cqa-ed-step" },
                input(step.value, "step-value", (v) => ((step.value = v), refresh()), { inputmode: "decimal", "aria-label": t("editor.stepValue"), class: "cqa-sc-select cqa-ed-step-value" }),
                input(step.label, "step-label", (v) => ((step.label = v), refresh()), { "aria-label": t("editor.stepLabel") }),
                h("button", { class: "cqa-sc-btn", attrs: { type: "button", "aria-label": t("editor.removeStep") }, text: "✕", data: { test: "remove-step" }, on: { click: () => (c.scale_steps.splice(i, 1), draw()) } }),
              ),
            ),
            err("scale_steps"),
            h("button", { class: ["cqa-link", "cqa-ed-add"], attrs: { type: "button" }, text: t("editor.addStep"), data: { test: "add-step" }, on: { click: () => (c.scale_steps.push({ value: "", label: "" }), draw()) } }),
          )
        : null;

    const naBox = h("input", {
      class: "cqa-q-check",
      attrs: { type: "checkbox" },
      data: { test: "crit-na" },
      on: {
        change: () => {
          c.na_allowed = naBox.checked;
          draw();
        },
      },
    });
    naBox.checked = c.na_allowed === true;

    const card = h(
      "article",
      { class: "cqa-ed-crit", data: { test: "editor-criterion", id: c.id ?? "", key: c._key, new: c.id ? null : "true" } },
      h(
        "div",
        { class: "cqa-ed-crit-head" },
        badge,
        h("span", { class: "cqa-ed-crit-id", text: c.id ?? "" }),
        h("button", { class: ["cqa-sc-btn", "cqa-ed-remove"], attrs: { type: "button" }, text: t("editor.removeCriterion"), data: { test: "remove-criterion" }, on: { click: () => (view.draft.criteria.splice(view.draft.criteria.indexOf(c), 1), draw()) } }),
      ),
      field("editor.critTitle", input(c.title, "crit-title", live("title")), err("title")),
      field("editor.wording", textarea(c.wording, "crit-wording", live("wording"))),
      h(
        "div",
        { class: "cqa-ed-grid" },
        field(
          "editor.type",
          select(c.answer_type, "crit-type", [["yes_no", t("editor.type.yes_no")], ["scale", t("editor.type.scale")]], (v) => {
            c.answer_type = v;
            if (v === "scale" && c.scale_steps.length === 0) c.scale_steps = [{ value: 0, label: "" }, { value: 10, label: "" }];
            draw();
          }, t("editor.type")),
        ),
        field("editor.kind", select(c.kind, "crit-kind", [["scored", t("editor.kind.scored")], ["gross_error", t("editor.kind.gross_error")]], (v) => ((c.kind = v), draw()), t("editor.kind"))),
        gross ? null : field("editor.weight", input(c.weight, "crit-weight", live("weight"), { inputmode: "decimal" }), err("weight")),
        field("editor.section", select(c.section_id, "crit-section", sections().map((s) => [s.id, s.title || s.id]), (v) => moveCriterion(c, v), t("editor.section")), err("section_id")),
      ),
      steps,
      h("label", { class: "cqa-q-all" }, naBox, h("span", { text: t("editor.naAllowed") })),
      c.na_allowed ? field("editor.naCondition", input(c.na_condition, "crit-na-condition", live("na_condition")), err("na_condition")) : null,
      gross ? field("editor.kinds", input((c.kinds ?? []).join(", "), "crit-kinds", (v) => ((c.kinds = v.split(",")), refresh()))) : null,
      h(
        "details",
        { class: "cqa-ed-more" },
        h("summary", { text: t("editor.more") }),
        field("editor.guidance", textarea(c.guidance, "crit-guidance", live("guidance"), 3)),
        view.models.length > 0
          ? field("editor.model", select(c.model ?? "", "crit-model", [["", t("editor.modelDefault")], ...view.models.map((m) => [m, m])], (v) => ((c.model = v === "" ? undefined : v), refresh()), t("editor.model")))
          : null,
      ),
    );
    refs.cards.set(c._key, { badge, errs });
    return card;
  }

  function sectionOf(section, count) {
    const items = view.draft.criteria.filter((c) => c.section_id === section.id).map(cardOf);
    const title = input(section.title, "section-title", (v) => ((section.title = v), refresh()), { "aria-label": t("editor.sectionTitle"), class: "cqa-sc-select cqa-ed-section-title" });
    return h(
      "div",
      { class: "cqa-ed-section", data: { test: "editor-section", id: section.id } },
      h(
        "div",
        { class: "cqa-ed-section-head" },
        title,
        items.length === 0 && count > 1
          ? h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("editor.removeSection"), data: { test: "remove-section" }, on: { click: () => (view.draft.sections.splice(view.draft.sections.indexOf(section), 1), draw()) } })
          : null,
      ),
      ...items,
      h("button", { class: ["cqa-sc-btn", "cqa-ed-add"], attrs: { type: "button" }, text: t("editor.addCriterion"), data: { test: "add-criterion" }, on: { click: () => addCriterion(section.id) } }),
    );
  }

  function draw() {
    if (destroyed) return;
    clear(el);
    refs = { cards: new Map() };
    if (view.phase !== "ready") {
      el.append(
        h(
          "div",
          { class: "cqa-empty", attrs: { role: "status" } },
          h("b", { class: "cqa-empty-title", text: t(view.phase === "error" ? "editor.loadFailed" : "editor.loading") }),
          view.phase === "error" ? h("p", { class: "cqa-empty-note", text: errorText(view.error) }) : null,
        ),
      );
      return;
    }
    const { source, draft } = view;

    const head = h(
      "div",
      { class: "cqa-ck-head" },
      h("h1", { class: "cqa-view-title", verbatim: !isNew(), text: isNew() ? t("editor.titleNew") : source.name }),
      !isNew() ? h("button", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { type: "button" }, text: t("editor.apply"), data: { test: "open-apply" }, on: { click: () => openApply() } }) : null,
    );
    const meta = isNew()
      ? h("p", { class: "cqa-view-note", text: t("editor.newNote") })
      : h(
          "p",
          { class: "cqa-ed-meta" },
          h("span", { class: ["cqa-tag", "cqa-tag--out"], text: `v${source.version}` }),
          source.locked ? h("span", { class: ["cqa-tag", "cqa-tag--na"], text: t("checklists.locked") }) : null,
          h("span", { class: "cqa-rv-hint", text: source.locked ? t("editor.lockedNote") : t("editor.versionNote") }),
          h("a", { class: "cqa-link", attrs: { href: href("checklists") }, text: t("editor.back") }),
        );
    const saved = view.savedFor === keyOf(view.route) ? h("p", { class: "cqa-ld-summary", attrs: { role: "status" }, text: t("editor.saved", { name: source?.name ?? "", version: source?.version ?? "" }), data: { test: "editor-saved" } }) : null;

    refs.nameError = errorEl();
    refs.global = errorEl();
    const form = h(
      "div",
      { class: "cqa-ed-top" },
      field("editor.name", input(draft.name, "editor-name", (v) => ((draft.name = v), refresh())), refs.nameError),
      field("editor.channel", select(draft.channel ?? "any", "editor-channel", CHANNELS.map((c) => [c, t(`checklists.channel.${c}`)]), (v) => ((draft.channel = v), refresh()), t("editor.channel"))),
    );

    const list = sections();
    refs.removed = h("div", { class: "cqa-ed-removed-host" });
    refs.sum = h("div", { class: "cqa-ed-sum-host" });
    refs.diff = h("p", { class: "cqa-ed-diff", data: { test: "editor-diff" } });
    refs.count = h("p", { class: "cqa-ed-err" });
    refs.save = h("button", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { type: "button" }, data: { test: "editor-save" }, on: { click: () => save() } });

    el.append(
      head,
      meta,
      saved ?? "",
      form,
      ...list.map((s) => sectionOf(s, list.length)),
      h("button", { class: ["cqa-sc-btn", "cqa-ed-add"], attrs: { type: "button" }, text: t("editor.addSection"), data: { test: "add-section" } , on: { click: () => addSection() } }),
      refs.removed,
      refs.global,
      h("div", { class: "cqa-ed-foot" }, refs.sum, refs.diff, refs.count, refs.save),
    );
    refresh();
  }

  // ---- live state: badges, errors, the weight sum, the summary, the save button -----------------

  function refresh() {
    if (!refs || view.phase !== "ready") return;
    const { draft, source } = view;
    const { errors, warnings } = validateChecklist(draft);
    const diff = diffVersions(source, draft);
    const known = new Set((source?.criteria ?? []).map((c) => c.id));
    const reworded = new Set(diff.reworded);
    const weightOnly = new Set(diff.weightOnly);

    for (const c of draft.criteria) {
      const ref = refs.cards.get(c._key);
      if (!ref) continue;
      const kind = !c.id || !known.has(c.id) ? "new" : reworded.has(c.id) ? "reworded" : weightOnly.has(c.id) ? "weight" : null;
      ref.badge.hidden = kind === null;
      setLocalizedText(ref.badge, kind ? t(`editor.badge.${kind}`) : "");
      ref.badge.className = `cqa-tag ${kind === "new" ? "cqa-tag--ok" : kind === "reworded" ? "cqa-tag--mid" : "cqa-tag--out"}`;
      for (const e of ref.errs.values()) e.hidden = true;
    }
    refs.nameError.hidden = true;
    refs.global.hidden = true;
    for (const { path, code } of errors) {
      const message = t(`editor.error.${code}`);
      const match = /^criteria\.(\d+)\.(\w+)$/.exec(path);
      const target = match ? refs.cards.get(draft.criteria[Number(match[1])]?._key)?.errs.get(match[2]) : path === "name" ? refs.nameError : refs.global;
      if (!target) continue;
      setLocalizedText(target, message);
      target.hidden = false;
    }

    const sum = warnings.find((w) => w.code === "weight_sum");
    refs.sum.replaceChildren(sum ? h("p", { class: "cqa-ed-warn", attrs: { role: "status" }, text: t("editor.weightSum", { sum: String(sum.sum).replace(".", ",") }), data: { test: "weight-sum" } }) : "");

    const removed = diff.removed.map((id) => source.criteria.find((c) => c.id === id)).filter(Boolean);
    refs.removed.replaceChildren(
      removed.length > 0
        ? h(
            "div",
            { class: "cqa-ed-removed", data: { test: "removed-list" } },
            h("span", { class: "cqa-rv-label", text: t("editor.removed") }),
            ...removed.map((c) =>
              h(
                "span",
                { class: "cqa-ed-removed-item" },
                h("span", { class: ["cqa-tag", "cqa-tag--bad"], verbatim: true, text: c.title }),
                h("button", { class: ["cqa-link", "cqa-ed-add"], attrs: { type: "button" }, text: t("editor.restore"), data: { test: "restore-criterion" }, on: { click: () => restore(c.id) } }),
              ),
            ),
          )
        : "",
    );

    setLocalizedText(refs.diff, t("editor.diff", { added: diff.added.length, removed: diff.removed.length, reworded: diff.reworded.length, weight: diff.weightOnly.length }));
    setLocalizedText(refs.count, errors.length > 0 ? t("editor.errorCount", { n: errors.length }) : "");
    refs.count.hidden = errors.length === 0;
    setLocalizedText(refs.save, t(isNew() ? "editor.create" : source.locked ? "editor.saveAsNew" : "editor.saveVersion"));
    refs.save.disabled = view.saving || errors.length > 0;
  }

  // ---- saving and applying --------------------------------------------------------------------

  async function save() {
    const { value, errors } = validateChecklist(view.draft);
    if (errors.length > 0 || view.saving) return;
    view.saving = true;
    refresh();
    const body = {
      name: String(value.name).trim(),
      description: value.description ?? null,
      channel: value.channel ?? "any",
      guidance: typeof value.guidance === "string" ? value.guidance : "",
      rounding: Number.isInteger(value.rounding) ? value.rounding : 2,
      sections: value.sections.map((s) => ({ id: s.id, title: s.title, order: s.order })),
      criteria: value.criteria.map(({ _key, fingerprint, ...rest }, i) => ({ ...rest, order: i + 1 })),
    };
    try {
      const saved = isNew()
        ? await api.createChecklist(body)
        : view.source.locked
          ? await api.createChecklist({ ...body, based_on: { checklist_id: view.source.checklist_id, version: view.source.version } })
          : await api.saveChecklistVersion(view.source.checklist_id, body);
      if (destroyed) return;
      view.saving = false;
      view.savedFor = `${saved.checklist_id}@${saved.version}`;
      window.location.hash = href("editor", { checklistId: saved.checklist_id, version: saved.version });
    } catch (error) {
      if (destroyed) return;
      view.saving = false;
      refresh();
      toastError(store, error, { retry: save });
    }
  }

  function openApply() {
    if (!view.source) return;
    apply?.close();
    apply = openApplyDialog({ host: el.closest(".cqa") ?? el, store, api, version: view.source });
  }

  load();

  return {
    el,
    update(next) {
      if (keyOf(next) === keyOf(view.route) && next.name === view.route.name) return;
      const reload = keyOf(next) !== keyOf(view.route);
      view.route = next;
      if (reload) load();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      apply?.close();
    },
  };
}
