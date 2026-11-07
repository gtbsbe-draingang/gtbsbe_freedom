import { version } from "../package.json";
import { t } from "./i18n/ru.js";

// Context (dialogue, role, language, Xrm/formContext) comes from outside. A Dynamics form
// script hands it over through setClientApiContext(); nothing here reads parent.Xrm.
let clientApiContext = null;

function setClientApiContext(context) {
  clientApiContext = context ?? null;
}

// Renders the app into `root` and returns its .cqa element. Text goes in through textContent.
function mount(root) {
  const app = document.createElement("div");
  app.className = "cqa";
  const title = document.createElement("h1");
  title.className = "cqa-title";
  title.textContent = t("app.title");
  app.append(title);
  root.replaceChildren(app);
  return app;
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
