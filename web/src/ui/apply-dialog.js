// «Применить к диалогам» (R2, R10, extra 1): apply a saved checklist version to a chosen set of
// dialogues — the control group (the current non-DEV group), DEV, or the queue's selection. There
// is deliberately no «все» target. Shows the dry-run estimate, runs the job with reuse (unchanged
// criteria keep their answers), then offers «Сравнить» with the version it came from.
//
//   openApplyDialog({host, store, api, version}) -> { el, close }
//     version: the saved checklist version {checklist_id, version, name, based_on}
import { t } from "../i18n/ru.js";
import { clear, h } from "./dom.js";
import { followJob } from "./job-runner.js";
import { estimateText } from "./loader.js";
import { href } from "./router.js";
import { errorText, toastError } from "./toast.js";

const DEV = "DEV";

/** The version a comparison starts from: what it was based on, else its previous version, else null. */
export function compareFrom(version) {
  if (version?.based_on?.checklist_id) return { checklist_id: version.based_on.checklist_id, version: version.based_on.version };
  if (Number.isInteger(version?.version) && version.version > 1) return { checklist_id: version.checklist_id, version: version.version - 1 };
  return null;
}

/** The control group among the loaded groups: the current group if it is not DEV, else the last other one. */
export function controlGroup(groups, current) {
  if (current && current !== DEV && groups.includes(current)) return current;
  const others = groups.filter((g) => g !== DEV).sort();
  return others.length > 0 ? others[others.length - 1] : null;
}

export function openApplyDialog({ host, store, api, version }) {
  let closed = false;
  const view = { targets: null, target: null, estimate: null, estimating: false, job: null, lock: null, error: null, server: null };
  let estimateRun = 0;

  const body = h("div", { class: "cqa-ap-form" });
  const estimate = h("p", { class: "cqa-batch-estimate", attrs: { "aria-live": "polite" }, data: { test: "apply-estimate" } });
  const hint = h("p", { class: "cqa-sc-hint", text: t("batch.keyMissing") });
  const runButton = h("button", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { type: "button" }, text: t("apply.run"), data: { test: "apply-run" }, on: { click: () => run() } });
  const progress = h("div", { class: "cqa-sc-status", attrs: { role: "status", "aria-live": "polite" }, data: { test: "apply-progress" } });
  const closeButton = h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("apply.close"), data: { test: "apply-close" }, on: { click: () => close() } });

  function targetRow(key, label, count, disabled) {
    const input = h("input", {
      class: "cqa-ap-radio",
      attrs: { type: "radio", name: "cqa-apply-target", value: key, disabled: disabled || busy() ? true : null },
      data: { test: `apply-target-${key}` },
      on: { change: () => choose(key) },
    });
    input.checked = view.target === key;
    return h("label", { class: ["cqa-ap-target", disabled && "is-disabled"] }, input, h("span", { text: label }), h("span", { class: ["cqa-q-count", "num"], text: disabled && count === 0 ? "" : String(count) }));
  }

  function paint() {
    if (closed) return;
    clear(body);
    if (!view.targets) {
      body.append(h("p", { class: "cqa-rv-note", text: view.error ? errorText(view.error) : t("apply.loading") }));
      return;
    }
    const { control, dev, selected } = view.targets;
    body.append(
      h("p", { class: "cqa-rv-label", text: t("apply.targets") }),
      h(
        "div",
        { class: "cqa-ap-targets", attrs: { role: "radiogroup", "aria-label": t("apply.targets") } },
        targetRow("control", control.group ? t("apply.control", { group: control.group }) : t("apply.controlNone"), control.ids.length, control.ids.length === 0),
        targetRow("dev", t("apply.dev"), dev.ids.length, dev.ids.length === 0),
        targetRow("selected", t("apply.selected"), selected.ids.length, selected.ids.length === 0),
      ),
      h("p", { class: "cqa-rv-hint", text: t("apply.noAll") }),
    );
    estimate.textContent = view.estimate ? estimateText(view.estimate) : view.estimating ? t("batch.estimating") : "";
    const keyMissing = view.server?.model_key_configured === false && (view.estimate?.model_calls ?? 0) > 0;
    hint.hidden = !keyMissing;
    runButton.disabled = busy() || !view.estimate || view.estimating || keyMissing;

    clear(progress);
    const job = view.job;
    if (view.lock === "starting") progress.append(t("batch.starting"));
    else if (job && (view.lock === "interrupted" || view.lock === "resuming")) {
      progress.append(
        h("span", { class: "cqa-sc-failed", text: t("batch.interrupted", { done: job.done, total: job.total }) }),
        h("button", { class: "cqa-sc-btn", attrs: { type: "button", disabled: view.lock === "resuming" }, text: t("batch.resume"), data: { test: "apply-resume" }, on: { click: () => resume() } }),
      );
    } else if (job) {
      progress.append(t(job.running ? "batch.progress" : "batch.done", { done: job.done, total: job.total }));
      if (job.failed > 0) progress.append(h("span", { class: "cqa-sc-failed", text: t("batch.failed", { n: job.failed }) }));
      if (!job.running && job.failed > 0) progress.append(h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("batch.retry"), data: { test: "apply-retry" }, on: { click: () => retry() } }));
      const from = compareFrom(version);
      if (!job.running && from) {
        const group = view.target === "control" ? view.targets.control.group : view.target === "dev" ? DEV : null;
        const link = href("compare", { from_checklist: from.checklist_id, from_version: from.version, to_checklist: version.checklist_id, to_version: version.version, group_id: group });
        progress.append(h("a", { class: ["cqa-sc-btn", "cqa-sc-btn--cta", "cqa-ap-compare"], attrs: { href: link }, text: t("apply.compare"), data: { test: "apply-compare" }, on: { click: () => close() } }));
      }
    }
  }

  async function loadTargets() {
    try {
      const [items, server] = await Promise.all([api.listConversations(), api.getConfig()]);
      if (closed) return;
      const groups = [...new Set(items.map((item) => item.group_id))];
      const group = controlGroup(groups, store.get().groupId);
      const selection = [...(store.get().selection ?? [])].filter((id) => items.some((item) => item.id === id));
      view.server = server;
      view.targets = {
        control: { group, ids: group ? items.filter((item) => item.group_id === group).map((item) => item.id) : [] },
        dev: { ids: items.filter((item) => item.group_id === DEV).map((item) => item.id) },
        selected: { ids: selection },
      };
    } catch (error) {
      view.error = error;
    }
    paint();
  }

  async function choose(key) {
    if (busy()) return; // the targets are disabled while a job starts or runs
    view.target = key;
    view.estimate = null;
    view.job = null;
    view.estimating = true;
    paint();
    const mine = ++estimateRun;
    try {
      const dry = await api.startEvaluations({ conversations: view.targets[key].ids, checklist_id: version.checklist_id, version: version.version, dry_run: true });
      if (closed || mine !== estimateRun) return;
      view.estimate = dry;
    } catch (error) {
      if (closed || mine !== estimateRun) return;
      toastError(store, error, { retry: () => choose(key) });
    }
    view.estimating = false;
    paint();
  }

  // One job at a time, as in the batch bar: view.lock is taken before the first await
  // ("starting"), held while polling ("watching"), and kept after a failed poll ("interrupted",
  // then "resuming"), when recovery polls the same job id again and never starts another job.
  const busy = () => view.lock !== null;

  async function watchJob(first) {
    view.lock = "watching";
    try {
      const job = await followJob(api, first, (tick, running) => {
        view.job = { id: tick.id, done: tick.done, total: tick.total, failed: tick.failed ?? 0, running };
        paint();
      });
      view.job = { id: job.id, done: job.done, total: job.total, failed: job.failed ?? 0, running: false };
      view.lock = null;
      paint();
      store.set((state) => ({ queueRefresh: (state.queueRefresh ?? 0) + 1 }));
    } catch (error) {
      view.lock = "interrupted";
      paint();
      toastError(store, error, { retry: resume });
    }
  }

  async function resume() {
    const id = view.job?.id;
    if (!id || view.lock !== "interrupted") return;
    view.lock = "resuming";
    paint();
    let job;
    try {
      job = await api.getJob(id);
    } catch (error) {
      const gone = error?.code === "not_found";
      view.lock = gone ? null : "interrupted";
      if (gone) view.job = null;
      paint();
      toastError(store, error, { retry: gone ? undefined : resume });
      return;
    }
    await watchJob(job);
  }

  async function start(request, again) {
    if (busy()) return;
    view.lock = "starting";
    paint();
    let first;
    try {
      first = await request();
    } catch (error) {
      view.lock = null;
      paint();
      toastError(store, error, { retry: again });
      return;
    }
    await watchJob(first);
  }

  function run() {
    if (busy() || !view.target) return undefined;
    const ids = view.targets[view.target].ids;
    return start(() => api.startEvaluations({ conversations: ids, checklist_id: version.checklist_id, version: version.version, mode: "reuse" }), run);
  }

  function retry() {
    const id = view.job?.id;
    if (busy() || !id) return undefined;
    return start(() => api.retryJob(id), retry);
  }

  const panel = h(
    "aside",
    { class: "cqa-drawer", attrs: { role: "dialog", "aria-modal": "true", "aria-label": t("apply.title") } },
    h("div", { class: "cqa-drawer-head" }, h("h2", { class: "cqa-drawer-title", text: t("apply.title") }), h("p", { class: "cqa-rv-hint", text: t("apply.what", { name: version.name, version: version.version }) })),
    body,
    estimate,
    hint,
    h("div", { class: "cqa-rv-acts" }, closeButton, runButton),
    progress,
  );
  const scrim = h("button", { class: "cqa-drawer-scrim", attrs: { type: "button", tabindex: "-1", "aria-label": t("apply.close") }, on: { click: () => close() } });
  const el = h(
    "div",
    {
      class: "cqa-drawer-wrap",
      data: { test: "apply-dialog" },
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
  loadTargets();
  return { el, close };
}
