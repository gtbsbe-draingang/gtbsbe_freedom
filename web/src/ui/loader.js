// Loading data and batch runs (R3, R9, control check 1).
//
//   openLoader({host, store, api, onImported?}) -> { el, close }
//     The loader drawer: «Загрузить группу» by group_id (api.importDataset) and «Загрузить файл»
//     (read with FileReader, checked with parseUpload first, so a bad file gets a precise message
//     by code; then api.uploadConversations with the file's JSON as it is). Each import shows the
//     summary «Всего N · новых I · обновлено U · без изменений K» and calls onImported(summary).
//
//   createBatchBar(store, api) -> { el, destroy }
//     Shown while dialogues are selected in the queue (store `selection`) or a batch runs: the
//     checklist (store `checklistSel`, shared with the scorecard), the dry-run estimate
//     «N диалогов · M вызовов модели · K из кэша», «Оценить выбранные», then the job's progress
//     with «Повторить неудачные». A finished batch bumps `queueRefresh`.
import { parseUpload, UploadError } from "../domain/normalize.js";
import { t, tp } from "../i18n/ru.js";
import { watch } from "../state/store.js";
import { clear, h } from "./dom.js";
import { jobSettled, pickSelection } from "./scorecard.js";
import { errorText, toastError } from "./toast.js";

export const POLL_MS = 500;
export const ESTIMATE_DELAY_MS = 250;

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

/**
 * Polls a job until it is over, calling onTick(job, running) after every answer (and once at the
 * start). It does not stop when the caller's view is gone: results must still refresh.
 * @returns {Promise<object>} the settled job
 */
export async function followJob(api, first, onTick) {
  let job = first;
  onTick(job, !jobSettled(job));
  while (!jobSettled(job)) {
    await sleep(POLL_MS);
    job = await api.getJob(job.id);
    onTick(job, !jobSettled(job));
  }
  return job;
}

const summaryText = (summary) => t("loader.summary", { total: summary.total, imported: summary.imported, updated: summary.updated, unchanged: summary.unchanged });
const bump = (store) => store.set((state) => ({ queueRefresh: (state.queueRefresh ?? 0) + 1 }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsText(file);
  });
}

// ---- the loader drawer ------------------------------------------------------------------------

export function openLoader({ host, store, api, onImported }) {
  let closed = false;
  let busy = false;

  const status = h("p", { class: "cqa-ld-status", attrs: { role: "status", "aria-live": "polite" } });
  const result = h("div", { class: "cqa-ld-result" });

  const groupInput = h("input", {
    class: "cqa-sc-select",
    attrs: { type: "text", autocomplete: "off", spellcheck: "false", placeholder: t("loader.groupPlaceholder"), "aria-label": t("loader.group") },
    data: { test: "group-id" },
    on: { input: () => paint() },
  });
  const importButton = h("button", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { type: "submit" }, text: t("loader.import"), data: { test: "import-group" } });
  const fileInput = h("input", {
    class: "cqa-ld-file",
    attrs: { type: "file", accept: ".json,application/json", "aria-label": t("loader.file") },
    data: { test: "upload-file" },
    on: { change: () => upload() },
  });
  const closeButton = h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("loader.close"), data: { test: "loader-close" }, on: { click: () => close() } });

  function paint() {
    importButton.disabled = busy || groupInput.value.trim() === "";
    groupInput.disabled = busy;
    fileInput.disabled = busy;
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
    status.textContent = label;
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
      status.textContent = "";
      if (!closed) paint();
    }
  }

  function importGroup() {
    const group = groupInput.value.trim();
    if (group === "") return;
    run(t("loader.importing", { group }), () => api.importDataset(group));
  }

  function upload() {
    const file = fileInput.files?.[0];
    if (!file) return;
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

  const panel = h(
    "aside",
    { class: "cqa-drawer", attrs: { role: "dialog", "aria-modal": "true", "aria-label": t("loader.title") } },
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
      h("label", { class: "cqa-rv-field" }, h("span", { class: "cqa-rv-label", text: t("loader.file") }), fileInput),
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

// ---- the batch bar ----------------------------------------------------------------------------

const versionsOf = (row) => (Array.isArray(row.versions) && row.versions.length > 0 ? row.versions.map((v) => v.version) : [row.version]);

export function createBatchBar(store, api) {
  const view = {
    ready: false, // config and checklists loaded
    server: null,
    options: [], // [{checklist_id, version, label}]
    estimate: null, // the dry-run answer for the current selection and checklist
    estimating: false,
    job: null, // null | {id, done, total, failed, running}
  };
  let destroyed = false;
  let estimateTimer = null;
  let estimateRun = 0;
  let booting = null;
  const stops = [];

  const host = h("div", { class: "cqa-batch-host" });
  const count = h("b", { class: "cqa-batch-count" });
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
      count,
      h("button", { class: ["cqa-link", "cqa-batch-clear"], attrs: { type: "button" }, text: t("batch.clear"), data: { test: "batch-clear" }, on: { click: () => store.set({ selection: new Set() }) } }),
    ),
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
    const active = view.job?.running === true;
    const show = picked.size > 0 || active;
    if (!show) {
      host.replaceChildren();
      return;
    }
    if (!bar.isConnected) host.replaceChildren(bar);
    count.textContent = t("batch.selected", { n: picked.size });

    const sel = current();
    const at = view.options.findIndex((o) => o.checklist_id === sel?.checklist_id && o.version === sel?.version);
    if (at >= 0) select.value = String(at);
    select.disabled = active || view.options.length === 0;

    if (view.estimate) estimate.textContent = estimateText(view.estimate);
    else estimate.textContent = view.estimating || !view.ready ? t("batch.estimating") : "";
    const keyMissing = view.server?.model_key_configured === false && (view.estimate?.model_calls ?? 0) > 0;
    hint.hidden = !keyMissing;
    runButton.disabled = active || picked.size === 0 || !view.estimate || view.estimating || keyMissing || sel === null;

    clear(progress);
    const job = view.job;
    if (job) {
      progress.append(t(job.running ? "batch.progress" : "batch.done", { done: job.done, total: job.total }));
      if (job.failed > 0) {
        progress.append(
          h("span", { class: "cqa-sc-failed", text: t("batch.failed", { n: job.failed }) }),
          job.running ? "" : h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("batch.retry"), data: { test: "batch-retry" }, on: { click: () => retry() } }),
        );
      }
    }
  }

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

  // Polls the job to the end. It keeps going if the queue is closed: the totals must still refresh.
  async function follow(first) {
    await followJob(api, first, (job, running) => {
      view.job = { id: job.id, done: job.done, total: job.total, failed: job.failed ?? 0, running };
      paint();
    });
    bump(store);
    scheduleEstimate(); // what is cached now
  }

  async function runBatch() {
    const sel = current();
    const picked = [...selection()];
    if (!sel || picked.length === 0 || view.job?.running) return;
    try {
      await follow(await api.startEvaluations({ conversations: picked, checklist_id: sel.checklist_id, version: sel.version, mode: "reuse" }));
    } catch (error) {
      if (view.job) view.job.running = false;
      paint();
      toastError(store, error, { retry: runBatch });
    }
  }

  async function retry() {
    const id = view.job?.id;
    if (!id || view.job.running) return;
    try {
      await follow(await api.retryJob(id));
    } catch (error) {
      if (view.job) view.job.running = false;
      paint();
      toastError(store, error, { retry });
    }
  }

  stops.push(
    watch(store, (state) => state.selection, (next) => {
      if (!view.job?.running) view.job = null; // a new selection starts a new batch
      if ((next?.size ?? 0) > 0) boot();
      scheduleEstimate();
    }),
    watch(store, (state) => state.checklistSel, () => scheduleEstimate()),
  );
  if (selection().size > 0) boot();
  paint();

  return {
    el: host,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(estimateTimer);
      stops.forEach((stop) => stop());
    },
  };
}
