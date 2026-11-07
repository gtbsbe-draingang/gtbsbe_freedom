import { version } from "../package.json";
import { mount as mountApp } from "./app.js";
import { extractConversationId } from "./context.js";
import { t } from "./i18n/ru.js";

// The host-facing API: window.CQA = { mount, setClientApiContext, version }.
//
// Context (conversation, role, language, Xrm/formContext) comes from outside. A Dynamics form
// script reaches this page through getContentWindow() and calls setClientApiContext(Xrm,
// formContext); nothing here reads parent.Xrm.
let current = null; // { app, el, config }: the app that setClientApiContext talks to
let pending = null; // a hand-over that arrived before any mount

// Kept for an adapter that will call Xrm.WebApi; today the app reads only the conversation id.
let clientApiContext = null;

// The field name comes from the config the app was mounted with (the same one app.js resolves).
function handOver({ app, config }, formContext) {
  const id = extractConversationId(formContext, config);
  if (id) app.open(id);
}

function mount(el, options) {
  if (current && current.el === el) current.app.destroy();
  const app = mountApp(el, options);
  current = { app, el, config: options?.config ?? window.CQA_CONFIG ?? {} };
  if (pending) {
    const { formContext } = pending;
    pending = null;
    handOver(current, formContext);
  }
  return app;
}

function setClientApiContext(xrm, formContext) {
  clientApiContext = { xrm, formContext };
  if (current) handOver(current, formContext);
  else pending = clientApiContext;
}

window.CQA = { mount, setClientApiContext, version };

function autostart() {
  const root = document.getElementById("cqa-root");
  if (!root || !root.hasAttribute("data-autostart")) return;
  document.title = t("app.title");
  mount(root);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autostart);
else autostart();
