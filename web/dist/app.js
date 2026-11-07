(() => {
  // package.json
  var version = "0.1.0";

  // src/i18n/ru.js
  var messages = {
    "app.title": "\u041A\u0430\u0447\u0435\u0441\u0442\u0432\u043E \u0434\u0438\u0430\u043B\u043E\u0433\u043E\u0432"
  };
  var has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  function format(template, params) {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (placeholder, name) => has(params, name) ? String(params[name]) : placeholder);
  }
  function t(key, params) {
    return has(messages, key) ? format(messages[key], params) : key;
  }

  // src/main.js
  var clientApiContext = null;
  function setClientApiContext(context) {
    clientApiContext = context ?? null;
  }
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
})();
