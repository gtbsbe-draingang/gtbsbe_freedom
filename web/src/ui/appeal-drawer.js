import { setLocalizedText } from "../i18n/dom.js";
// The appeal drawer (R7, «Контролёр»): the criterion, pre-filled with the one disputed and
// changeable; the controller's comment, required; «Подать апелляцию». It slides in over the app
// root, so it stays inside the component's scoped styles and works in a narrow frame.
//
//   openAppealDrawer({host, store, api, evaluationId, choices, criterionId, onFiled?, returnFocus?})
//     -> { el, close }
//
// `choices` is [{id, title, answer}] (answer: the current answer's text), the criteria that may be
// disputed. Esc, the scrim and «Отмена» close it; a filed appeal closes it and calls onFiled(appeal).
import { t } from "../i18n/ru.js";
import { h } from "./dom.js";
import { toastError } from "./toast.js";

export function openAppealDrawer({ host, store, api, evaluationId, choices, criterionId, onFiled, returnFocus }) {
  let closed = false;
  let busy = false;

  const current = h("p", { class: "cqa-ap-current", data: { test: "appeal-current" } });
  const select = h(
    "select",
    { class: ["cqa-sc-select", "cqa-ap-select"], attrs: { "aria-label": t("appeal.criterion") }, data: { test: "appeal-criterion" }, on: { change: () => paint() } },
    choices.map((choice) => h("option", { attrs: { value: choice.id }, verbatim:true, text: choice.title })),
  );
  if (choices.some((choice) => choice.id === criterionId)) select.value = criterionId;

  const comment = h("textarea", {
    class: "cqa-ap-text",
    attrs: { rows: "5", "aria-label": t("appeal.comment"), placeholder: t("appeal.commentPlaceholder") },
    data: { test: "appeal-comment" },
    on: { input: () => paint() },
  });
  const submit = h("button", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { type: "submit" }, text: t("appeal.submit"), data: { test: "appeal-submit" } });
  const cancel = h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("appeal.cancel"), data: { test: "appeal-cancel" }, on: { click: () => close() } });

  function paint() {
    const choice = choices.find((c) => c.id === select.value);
    setLocalizedText(current, choice ? t("appeal.current", { answer: choice.answer }) : "");
    submit.disabled = busy || comment.value.trim() === "";
    select.disabled = busy;
  }

  async function send() {
    const text = comment.value.trim();
    if (busy || closed || text === "") return;
    busy = true;
    paint();
    try {
      const appeal = await api.fileAppeal({ evaluation_id: evaluationId, criterion_id: select.value, comment: text });
      // No toast: the card itself confirms it (the open-appeal tag, the history), and a toast would
      // still cover the reviewer's buttons a few seconds later in a quick demo.
      close();
      onFiled?.(appeal);
    } catch (error) {
      busy = false;
      if (!closed) paint();
      toastError(store, error, { retry: send });
    }
  }

  const panel = h(
    "aside",
    { class: "cqa-drawer", attrs: { role: "dialog", "aria-modal": "true", "aria-label": t("appeal.title") } },
    h("div", { class: "cqa-drawer-head" }, h("h2", { class: "cqa-drawer-title", text: t("appeal.title") })),
    h(
      "form",
      {
        class: "cqa-ap-form",
        on: {
          submit: (event) => {
            event.preventDefault();
            send();
          },
        },
      },
      h("label", { class: "cqa-rv-field" }, h("span", { class: "cqa-rv-label", text: t("appeal.criterion") }), select),
      current,
      h("label", { class: "cqa-rv-field" }, h("span", { class: "cqa-rv-label", text: t("appeal.comment") }), comment),
      h("p", { class: "cqa-rv-hint", text: t("appeal.note") }),
      h("div", { class: "cqa-rv-acts" }, cancel, submit),
    ),
  );
  const scrim = h("button", { class: "cqa-drawer-scrim", attrs: { type: "button", tabindex: "-1", "aria-label": t("appeal.cancel") }, on: { click: () => close() } });
  const el = h(
    "div",
    {
      class: "cqa-drawer-wrap",
      data: { test: "appeal-drawer" },
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
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
  }

  paint();
  host.append(el);
  comment.focus();
  return { el, close };
}
