import { setLocalizedText } from "../i18n/dom.js";
// Loading data and batch runs (R3, R9, control check 1).
//
//   openLoader({host, store, api, onImported?, group?}) -> { el, close }
//     The loader drawer: «Загрузить группу» by group_id (api.importDataset) and «Загрузить файл»
//     (read with FileReader, checked with parseUpload first, so a bad file gets a precise message
//     by code; then api.uploadConversations with the file's JSON as it is). Each import shows the
//     summary «Всего N · новых I · обновлено U · без изменений K» and calls onImported(summary).
//     `group` fills in the group_id field.
//
//   openImport(store, api, host, {group}?) -> { el, close }
//     openLoader with what every import does to the store: the dataset badge and the queue's group
//     filter follow the imported group (`groupId`, `queueGroup`), the queue reloads (`queueRefresh`)
//     and the open transcript checks its dialogue (`importRefresh`). The queue's «Загрузить» and
//     the call player's «Загрузить группу» both open it.
//
//   createBatchBar(store, api, {describe}?) -> { el, destroy }
//     Shown while dialogues are selected in the queue (store `selection`) or a batch runs. Its
//     «Выбрано: N» opens the basket: one row per selected dialogue in the order picked, with a link
//     to it and a button that takes it out of the selection (`describe(id)` gives the row's queue
//     item, for its group, language and channel). A press anywhere but its rows and the toggle
//     closes it, including the empty parts of the basket and the bar. Then the
//     checklist (store `checklistSel`, shared with the scorecard), the dry-run estimate
//     «N диалогов · M вызовов модели · K из кэша», «Оценить выбранные», then the job's progress
//     with «Повторить неудачные». The job is in the "batch" slot of job-runner.js (store `jobs`),
//     so a bar rebuilt after leaving the workspace shows the same job and cannot start another.
//     A finished batch bumps `queueRefresh`.
import { parseUpload, UploadError } from "../domain/normalize.js";
import { t, tp } from "../i18n/ru.js";
import { watch } from "../state/store.js";
import { clear, h, placeChildren, svg } from "./dom.js";
import { icon } from "./icons.js";
import { jobSlot } from "./job-runner.js";
import { href } from "./router.js";
import { pickSelection } from "./scorecard.js";
import { errorText, toastError } from "./toast.js";
import { versionNumbers } from "../domain/checklist-versions.js";

export const ESTIMATE_DELAY_MS = 250;
export const BATCH_SLOT = "batch";

// ---- pure helpers -----------------------------------------------------------------------------

/** The message for an UploadError code ("not_json", "no_records", "bad_record:<index>"). */
export function uploadErrorText(code) {
  const match = /^bad_record:(\d+)$/.exec(String(code ?? ""));
  if (match) return t("loader.error.bad_record", { n: Number(match[1]) + 1 });
  if (code === "not_json" || code === "no_records") return t(`loader.error.${code}`);
  return t("loader.error.read");
}

/** «N диалогов · M вызовов модели · K из кэша» from a dry-run answer. */
export function estimateText(dry) {
  return t("batch.estimate", { dialogs: tp("batch.dialogs", dry.total), calls: tp("batch.calls", dry.model_calls), cached: dry.reused });
}

const summaryText = (summary) => t("loader.summary", { total: summary.total, imported: summary.imported, updated: summary.updated, unchanged: summary.unchanged });

function readText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsText(file);
  });
}

// ---- the loader drawer ------------------------------------------------------------------------

export function openLoader({ host, store, api, onImported, group = "" }) {
  let closed = false;
  let busy = false;
  let dragDepth = 0;

  const status = h("p", { class: "cqa-ld-status", attrs: { role: "status", "aria-live": "polite" } });
  const result = h("div", { class: "cqa-ld-result" });

  const groupInput = h("input", {
    class: "cqa-sc-select",
    attrs: { type: "text", autocomplete: "off", spellcheck: "false", placeholder: t("loader.groupPlaceholder"), "aria-label": t("loader.group") },
    data: { test: "group-id" },
    on: { input: () => paint() },
  });
  groupInput.value = typeof group === "string" ? group : "";
  const importButton = h("button", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { type: "submit" }, text: t("loader.import"), data: { test: "import-group" } });
  const fileInput = h("input", {
    class: "cqa-ld-file",
    attrs: { type: "file", accept: ".json,application/json", hidden: true, tabindex: "-1", "aria-label": t("loader.file") },
    data: { test: "upload-file" },
    on: { change: () => uploadFiles(fileInput.files) },
  });
  const chooseFile = h("button", {
    class: "cqa-sc-btn", attrs: { type: "button" }, text: t("loader.chooseFile"),
    data: { test: "choose-upload-file" }, on: { click: () => fileInput.click() },
  });
  const fileName = h("span", { class: "cqa-ld-filename", text: t("loader.noFile"), data: { test: "upload-filename" }, attrs: { "aria-live": "polite" } });
  const dropTitle = h("b", { class: "cqa-ld-drop-title", text: t("loader.dropTitle") });
  const dropzone = h("div", {
    class: "cqa-ld-dropzone", attrs: { role: "group", "aria-label": t("loader.file"), "aria-disabled": "false" }, data: { test: "upload-dropzone" },
  }, svg("svg", { class: "cqa-ld-drop-icon", viewBox: "0 0 24 24", width: 24, height: 24, fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
    svg("path", { d: "M12 16V3m-5 5 5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" })),
    dropTitle, h("span", { class: "cqa-rv-hint", text: t("loader.dropHint") }), chooseFile, fileName, fileInput);
  const closeButton = h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("loader.close"), data: { test: "loader-close" }, on: { click: () => close() } });

  function paint() {
    importButton.disabled = busy || groupInput.value.trim() === "";
    groupInput.disabled = busy;
    fileInput.disabled = busy;
    chooseFile.disabled = busy;
    dropzone.setAttribute("aria-disabled", String(busy));
    dropzone.classList.toggle("is-busy", busy);
    if (busy) { dragDepth = 0; setDragging(false); }
  }

  function showError(text) {
    clear(result).append(h("p", { class: "cqa-ld-error", attrs: { role: "alert" }, text, data: { test: "loader-error" } }));
  }

  function showSummary(summary) {
    clear(result).append(
      h("p", { class: "cqa-ld-summary", text: summaryText(summary), data: { test: "import-summary" } }),
      summary.group_id ? h("p", { class: "cqa-rv-hint", text: t("loader.summaryGroup", { group: summary.group_id }), data: { test: "import-group-name" } }) : null,
    );
  }

  async function run(label, action) {
    if (busy || closed) return;
    busy = true;
    setLocalizedText(status, label);
    paint();
    try {
      const summary = await action();
      if (summary) {
        if (!closed) showSummary(summary);
        onImported?.(summary);
      }
    } catch (error) {
      if (!closed) showError(error instanceof UploadError ? uploadErrorText(error.code) : errorText(error));
    } finally {
      busy = false;
      setLocalizedText(status, "");
      if (!closed) paint();
    }
  }

  function importGroup() {
    const group = groupInput.value.trim();
    if (group === "") return;
    run(t("loader.importing", { group }), () => api.importDataset(group));
  }

  function uploadFiles(files) {
    if (busy || closed || !files?.length) return;
    if (files.length !== 1) {
      showError(t("loader.error.oneFile"));
      fileInput.value = "";
      return;
    }
    const file = files[0];
    // File-picker and drop paths share validation, locking, parsing and upload behavior.
    if (!/\.json$/i.test(file.name) && file.type !== "application/json") {
      showError(t("loader.error.fileType"));
      fileInput.value = "";
      return;
    }
    fileName.setAttribute("data-i18n-verbatim", "");
    fileName.replaceChildren(h("span", { text: file.name, verbatim: true }));
    clear(result);
    run(t("loader.uploading", { name: file.name }), async () => {
      try {
        const text = await readText(file);
        parseUpload(text); // a precise message for a bad file, before anything is sent
        return await api.uploadConversations(JSON.parse(text.replace(/^﻿/, "")));
      } finally {
        fileInput.value = ""; // the same file can be picked again
      }
    });
  }

  function setDragging(active) {
    active = active && !busy;
    if (dropzone.classList.contains("is-dragging") === active) return;
    dropzone.classList.toggle("is-dragging", active);
    setLocalizedText(dropTitle, t(active ? "loader.dropActive" : "loader.dropTitle"));
  }

  const hasFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

  const panel = h(
    "aside",
    { class: "cqa-drawer", attrs: { role: "dialog", "aria-modal": "true", "aria-label": t("loader.title") }, on: {
      dragenter: (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        dragDepth++;
        setDragging(true);
      },
      dragover: (event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = busy ? "none" : "copy";
      },
      dragleave: () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) setDragging(false);
      },
      drop: (event) => {
        if (!hasFiles(event) && !event.dataTransfer?.files?.length) return;
        event.preventDefault();
        dragDepth = 0;
        setDragging(false);
        uploadFiles(event.dataTransfer?.files);
      },
    } },
    h("div", { class: "cqa-drawer-head" }, h("h2", { class: "cqa-drawer-title", text: t("loader.title") })),
    h(
      "form",
      {
        class: "cqa-ap-form",
        on: {
          submit: (event) => {
            event.preventDefault();
            importGroup();
          },
        },
      },
      h("label", { class: "cqa-rv-field" }, h("span", { class: "cqa-rv-label", text: t("loader.group") }), groupInput),
      h("p", { class: "cqa-rv-hint", text: t("loader.groupHint") }),
      h("div", { class: "cqa-rv-acts" }, importButton),
    ),
    h(
      "div",
      { class: "cqa-ap-form" },
      h("div", { class: "cqa-rv-field" }, h("span", { class: "cqa-rv-label", text: t("loader.file") }), dropzone),
      h("p", { class: "cqa-rv-hint", text: t("loader.fileHint") }),
    ),
    status,
    result,
    h("div", { class: "cqa-rv-acts" }, closeButton),
  );
  const scrim = h("button", { class: "cqa-drawer-scrim", attrs: { type: "button", tabindex: "-1", "aria-label": t("loader.close") }, on: { click: () => close() } });
  const el = h(
    "div",
    {
      class: "cqa-drawer-wrap",
      data: { test: "loader" },
      on: {
        // Dropping outside the panel must not navigate the browser to the local file.
        dragover: (event) => { if (hasFiles(event)) event.preventDefault(); },
        drop: (event) => { if (hasFiles(event) || event.dataTransfer?.files?.length) event.preventDefault(); },
        keydown: (event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            close();
          }
        },
      },
    },
    scrim,
    panel,
  );

  function close() {
    if (closed) return;
    closed = true;
    el.remove();
  }

  paint();
  host.append(el);
  groupInput.focus();
  return { el, close };
}

export function openImport(store, api, host, { group } = {}) {
  return openLoader({
    host,
    store,
    api,
    group,
    onImported: (summary) => {
      const imported = summary?.group_id;
      store.set((state) => ({
        ...(imported ? { groupId: imported, queueGroup: imported } : {}),
        queueRefresh: (state.queueRefresh ?? 0) + 1,
        importRefresh: (state.importRefresh ?? 0) + 1, // the open dialogue may have new lines or a recording
      }));
    },
  });
}

// ---- the batch bar ----------------------------------------------------------------------------

const versionsOf = versionNumbers;
let basketUid = 0; // element ids stay unique if a host mounts the UI twice

export function createBatchBar(store, api, { describe = () => null } = {}) {
  const view = {
    ready: false, // config and checklists loaded
    server: null,
    options: [], // [{checklist_id, version, label}]
    estimate: null, // the dry-run answer for the current selection and checklist
    estimating: false,
  };
  const slot = jobSlot(store, api, BATCH_SLOT); // the job and its lock: they outlive this bar
  const busy = () => slot.busy();
  let destroyed = false;
  let estimateTimer = null;
  let estimateRun = 0;
  let booting = null;
  const stops = [];

  const host = h("div", { class: "cqa-batch-host" });
  const basketId = `cqa-basket-${++basketUid}`;
  const count = h("b", { class: "cqa-batch-count" });
  const basketButton = h(
    "button",
    {
      class: "cqa-basket-btn",
      attrs: { type: "button", "aria-expanded": "false", "aria-controls": basketId, title: t("batch.basket.toggle") },
      data: { test: "batch-basket" },
      on: { click: () => (basket.hidden ? openBasket() : closeBasket()) },
    },
    count,
    icon("chevron", { size: 14 }),
  );
  const basketList = h("ul", { class: "cqa-basket-list", attrs: { "aria-label": t("batch.basket.label") }, data: { test: "batch-basket-list" } });
  const basket = h(
    "div",
    { class: ["cqa-menu", "cqa-basket"], attrs: { id: basketId }, data: { test: "batch-basket-panel" } },
    h("span", { class: "cqa-rv-label", text: t("batch.basket.label") }),
    basketList,
  );
  basket.hidden = true;
  const basketRows = new Map(); // id -> <li>, kept while the dialogue stays selected
  const select = h("select", {
    class: "cqa-sc-select",
    attrs: { "aria-label": t("batch.checklist") },
    data: { test: "batch-checklist" },
    on: {
      change: () => {
        const option = view.options[Number(select.value)];
        if (!option) return;
        store.set({ checklistSel: { checklist_id: option.checklist_id, version: option.version } });
      },
    },
  });
  const estimate = h("p", { class: "cqa-batch-estimate", attrs: { "aria-live": "polite" }, data: { test: "batch-estimate" } });
  const runButton = h("button", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { type: "button" }, text: t("batch.run"), data: { test: "batch-run" }, on: { click: () => runBatch() } });
  const hint = h("p", { class: "cqa-sc-hint", text: t("batch.keyMissing"), data: { test: "batch-key-hint" } });
  const progress = h("div", { class: "cqa-sc-status", attrs: { role: "status", "aria-live": "polite" }, data: { test: "batch-progress" } });
  const bar = h(
    "section",
    { class: "cqa-batch", attrs: { "aria-label": t("batch.label") }, data: { test: "batch-bar" } },
    h(
      "div",
      { class: "cqa-batch-row" },
      basketButton,
      h("button", { class: ["cqa-link", "cqa-batch-clear"], attrs: { type: "button" }, text: t("batch.clear"), data: { test: "batch-clear" }, on: { click: () => store.set({ selection: new Set() }) } }),
    ),
    basket,
    h("label", { class: "cqa-rv-field" }, h("span", { class: "cqa-rv-label", text: t("batch.checklist") }), select),
    estimate,
    hint,
    h("div", { class: "cqa-batch-row" }, runButton),
    progress,
  );

  let checklists = []; // the API's checklist rows, for pickSelection
  const selection = () => store.get().selection ?? new Set();
  const current = () => pickSelection(store.get().checklistSel, view.server, checklists);

  function paint() {
    if (destroyed) return;
    const picked = selection();
    const active = busy();
    const show = picked.size > 0 || active;
    if (!show) {
      closeBasket();
      host.replaceChildren();
      return;
    }
    if (!bar.isConnected) host.replaceChildren(bar);
    setLocalizedText(count, t("batch.selected", { n: picked.size }));
    paintBasket(picked);

    const sel = current();
    const at = view.options.findIndex((o) => o.checklist_id === sel?.checklist_id && o.version === sel?.version);
    if (at >= 0) select.value = String(at);
    select.disabled = active || view.options.length === 0;

    if (view.estimate) setLocalizedText(estimate, estimateText(view.estimate));
    else setLocalizedText(estimate, view.estimating || !view.ready ? t("batch.estimating") : "");
    const keyMissing = view.server?.model_key_configured === false && (view.estimate?.model_calls ?? 0) > 0;
    hint.hidden = !keyMissing;
    runButton.disabled = active || picked.size === 0 || !view.estimate || view.estimating || keyMissing || sel === null;

    clear(progress);
    const { lock = null, job = null } = slot.state() ?? {};
    if (lock === "starting") progress.append(h("span", {text: t("batch.starting")}));
    else if (job && (lock === "interrupted" || lock === "resuming")) {
      progress.append(
        h("span", { class: "cqa-sc-failed", text: t("batch.interrupted", { done: job.done, total: job.total }) }),
        h("button", { class: "cqa-sc-btn", attrs: { type: "button", disabled: lock === "resuming" }, text: t("batch.resume"), data: { test: "batch-resume" }, on: { click: () => slot.resume() } }),
      );
    } else if (job) {
      const running = lock === "watching";
      progress.append(h("span", {text: t(running ? "batch.progress" : "batch.done", { done: job.done, total: job.total })}));
      if (store.get().route?.params?.id) {
        progress.append(h("a", { class: ["cqa-link", "cqa-batch-results"], attrs: { href: href("workspace") }, text: t("batch.showResults"), data: { test: "batch-results" }, on: { click: () => store.set({ queueOpen: false, pane: "transcript" }) } }));
      }
      if (job.failed > 0) {
        progress.append(
          h("span", { class: "cqa-sc-failed", text: t("batch.failed", { n: job.failed }) }),
          running ? "" : h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("batch.retry"), data: { test: "batch-retry" }, on: { click: () => slot.retry() } }),
        );
      }
    }
  }

  // ---- the basket: the selected dialogues, each one removable ----

  function basketRow(id) {
    const item = describe(id);
    const name = item?.conversation_id ?? id.slice(id.indexOf(":") + 1);
    const group = item?.group_id ?? (id.includes(":") ? id.slice(0, id.indexOf(":")) : "");
    const meta = h("span", { class: "cqa-basket-meta" }, h("span", { verbatim: true, text: group }));
    if (item?.language) meta.append(" · ", h("span", { verbatim: true, text: item.language }));
    if (item?.channel) meta.append(" · ", h("span", { text: t(item.channel === "voice call" ? "queue.channel.call" : "queue.channel.chat") }));
    return h(
      "li",
      { class: "cqa-basket-item", data: { test: "batch-basket-item", id } },
      h("a", { class: "cqa-basket-link", attrs: { href: href("workspace", { id }) }, on: { click: () => closeBasket() } }, h("b", { class: "cqa-basket-id", verbatim: true, text: name }), meta),
      h(
        "button",
        { class: "cqa-basket-remove", attrs: { type: "button", "aria-label": t("batch.basket.remove", { id: name }), title: t("batch.basket.remove", { id: name }) }, data: { test: "batch-basket-remove" }, on: { click: () => unpick(id) } },
        icon("close", { size: 14 }),
      ),
    );
  }

  // Rows stay in place (placeChildren): a progress poll repaints the bar while the user tabs here.
  function paintBasket(picked) {
    for (const id of basketRows.keys()) if (!picked.has(id)) basketRows.delete(id);
    const nodes = [...picked].map((id) => {
      if (!basketRows.has(id)) basketRows.set(id, basketRow(id));
      return basketRows.get(id);
    });
    if (!basket.hidden) placeChildren(basketList, nodes);
    if (picked.size === 0) closeBasket();
  }

  // Takes one dialogue out of the selection; focus moves to the row that takes its place.
  function unpick(id) {
    const order = [...selection()];
    const at = order.indexOf(id);
    const next = new Set(order);
    next.delete(id);
    store.set({ selection: next }); // the queue unticks its row, the estimate is redone
    const rest = order.filter((other) => other !== id);
    const follow = rest[Math.min(at, rest.length - 1)];
    if (follow !== undefined) basketRows.get(follow)?.querySelector(".cqa-basket-remove")?.focus();
    else if (basketButton.isConnected) basketButton.focus();
  }

  // Any press closes the basket except one on its own rows (links, remove buttons, the list's
  // scrollbar) or on the toggle, whose click does the toggling. A press on an empty part of the
  // basket card or the bar closes it like a press anywhere else on the page.
  const onOutside = (event) => {
    const target = event.target;
    if (target instanceof Node && (basketList.contains(target) || basketButton.contains(target))) return;
    closeBasket();
  };
  function openBasket() {
    if (selection().size === 0) return;
    basket.hidden = false;
    basketButton.setAttribute("aria-expanded", "true");
    paintBasket(selection());
    document.addEventListener("pointerdown", onOutside);
  }
  function closeBasket() {
    if (basket.hidden) return;
    basket.hidden = true;
    basketButton.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside);
  }
  bar.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || basket.hidden) return;
    event.stopPropagation(); // closes the basket, not the queue drawer behind it
    closeBasket();
    basketButton.focus();
  });

  // Config and checklists, once; the picker follows store `checklistSel` like the scorecard's.
  function boot() {
    booting ??= Promise.all([api.getConfig(), api.listChecklists()]).then(
      ([server, rows]) => {
        if (destroyed) return;
        view.server = server;
        checklists = rows;
        view.options = rows.flatMap((row) =>
          [...versionsOf(row)].sort((a, b) => b - a).map((version) => ({ checklist_id: row.checklist_id, version, label: t("scorecard.checklistOption", { name: row.name ?? row.checklist_id, version }) })),
        );
        clear(select);
        view.options.forEach((option, index) => select.append(h("option", { text: option.label, attrs: { value: index } })));
        view.ready = true;
        scheduleEstimate();
      },
      (error) => {
        booting = null; // try again with the next selection
        if (!destroyed) toastError(store, error);
      },
    );
    return booting;
  }

  function scheduleEstimate() {
    clearTimeout(estimateTimer);
    estimateRun += 1;
    view.estimate = null;
    const picked = [...selection()];
    if (picked.length === 0 || !view.ready) {
      view.estimating = false;
      paint();
      return;
    }
    view.estimating = true;
    paint();
    const mine = estimateRun;
    estimateTimer = setTimeout(async () => {
      const sel = current();
      if (!sel) return;
      try {
        const dry = await api.startEvaluations({ conversations: picked, checklist_id: sel.checklist_id, version: sel.version, dry_run: true });
        if (destroyed || mine !== estimateRun) return;
        view.estimate = dry;
      } catch (error) {
        if (destroyed || mine !== estimateRun) return;
        toastError(store, error, { retry: scheduleEstimate });
      }
      view.estimating = false;
      paint();
    }, ESTIMATE_DELAY_MS);
  }

  // ---- running: one job at a time (job-runner.js holds the lock and polls) ----

  function runBatch() {
    const sel = current();
    const picked = [...selection()];
    if (busy() || !sel || picked.length === 0) return undefined;
    // What the batch board (batch-board.js) shows: these dialogues, under this checklist.
    const dialogues = picked.map((id) => {
      const item = describe(id);
      return { id, name: item?.conversation_id ?? id.slice(id.indexOf(":") + 1), language: item?.language ?? null, channel: item?.channel ?? null };
    });
    const label = view.options.find((o) => o.checklist_id === sel.checklist_id && o.version === sel.version)?.label ?? "";
    const started = slot.start(() => api.startEvaluations({ conversations: picked, checklist_id: sel.checklist_id, version: sel.version, mode: "reuse" }), {
      again: runBatch,
      meta: { key: `${Date.now()}:${picked.length}`, dialogues, label },
    });
    showBoard();
    return started;
  }

  // With no dialogue open the board is the middle pane: bring it into view (out of the narrow
  // drawer, onto the transcript tab). An open dialogue stays: its scorecard refreshes when the
  // batch ends, and «Результаты» in this bar leads to the board.
  function showBoard() {
    if (store.get().route?.params?.id) return;
    store.set({ queueOpen: false, pane: "transcript" });
  }

  stops.push(
    watch(store, (state) => state.selection, (next) => {
      slot.reset(); // a new selection starts a new batch (a running one is kept)
      if ((next?.size ?? 0) > 0) boot();
      scheduleEstimate();
    }),
    watch(store, (state) => state.checklistSel, () => scheduleEstimate()),
    watch(store, (state) => state.route, () => paint()), // «Результаты» shows only while a dialogue is open
    slot.watch((next, previous) => {
      // A batch that just ended changed what is cached: estimate again.
      if (previous?.lock === "watching" && (next?.lock ?? null) === null) scheduleEstimate();
      else paint();
    }),
  );
  if (selection().size > 0) boot();
  paint();

  return {
    el: host,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(estimateTimer);
      closeBasket();
      stops.forEach((stop) => stop());
    },
  };
}
