import {normalizeLanguage} from "./i18n/ru.js";
// Where the app's context comes from. Nothing here touches the DOM, window or parent.Xrm: the
// caller passes in the URL search string, the deployment config (window.CQA_CONFIG) and the
// options of mount(); a Dynamics form script hands over the form through setClientApiContext().

const ROLES = ["controller", "reviewer"];
const THEMES = ["light", "dark"];
const MODES = ["standalone", "embedded"];
const APIS = ["http", "mock"];

const METHOD = /^[A-Za-z][A-Za-z0-9_]*$/;
const CODE = /^[a-z][a-z0-9_]*$/;

const oneOf = (allowed, candidates) => candidates.find((value) => allowed.includes(value));
const firstText = (candidates) => {
  for (const value of candidates) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
};

// ["a:network", "b:timeout,c:locked"] -> { a: "network", b: "timeout", c: "locked" }. Pairs that
// are not `method:code` are dropped.
export function parseMockFault(values) {
  const faults = {};
  for (const value of values ?? []) {
    for (const pair of String(value).split(",")) {
      const colon = pair.indexOf(":");
      if (colon < 0) continue;
      const method = pair.slice(0, colon).trim();
      const code = pair.slice(colon + 1).trim();
      if (METHOD.test(method) && CODE.test(code)) faults[method] = code;
    }
  }
  return faults;
}

// The group of a conversation id: the part before the first colon (`DEV:p1-ru-001` -> `DEV`).
export function groupOf(conversationId) {
  if (typeof conversationId !== "string") return null;
  const colon = conversationId.indexOf(":");
  return colon > 0 ? conversationId.slice(0, colon) : null;
}

/**
 * @param {string} search   location.search
 * @param {object} config   window.CQA_CONFIG
 * @param {object} [options] mount() options; they beat the URL, which beats the config
 */
export function readContext(search, config, options) {
  const params = new URLSearchParams(typeof search === "string" ? search : "");
  const cfg = config && typeof config === "object" ? config : {};
  const opt = options && typeof options === "object" ? options : {};
  const urlValue = (key) => params.get(key) ?? undefined;
  const chain = (key) => [opt[key], urlValue(key), cfg[key]];

  const conversationId = firstText(chain("conversationId")) ?? null;
  const testHooks = cfg.testHooks === true;

  let mockModelKey = cfg.mockModelKey === undefined ? true : Boolean(cfg.mockModelKey);
  let mockFault = {};
  if (testHooks) {
    const key = urlValue("mockModelKey");
    if (key === "0") mockModelKey = false;
    else if (key === "1") mockModelKey = true;
    mockFault = parseMockFault(params.getAll("mockFault"));
  }
  const delay = Number(cfg.mockDelayMs);

  const mode = conversationId ? "embedded" : (oneOf(MODES, chain("mode")) ?? "standalone");

  return {
    api: oneOf(APIS, chain("api")) ?? "http",
    apiBase: firstText(chain("apiBase")) ?? "api",
    conversationId,
    language: [opt.language, opt.lang, urlValue("language"), urlValue("lang"), cfg.language, cfg.lang].map(normalizeLanguage).find(Boolean) ?? null,
    role: oneOf(ROLES, chain("role")) ?? "controller",
    // Dark by default on our own page; light when embedded in a Dynamics form.
    theme: oneOf(THEMES, chain("theme")) ?? (mode === "embedded" ? "light" : "dark"),
    // true when the host or the URL named the theme: only then does it beat a stored choice
    themeExplicit: oneOf(THEMES, [opt.theme, urlValue("theme")]) !== undefined,
    mode,
    devDataUrl: firstText([cfg.devDataUrl]) ?? null,
    devAudioBase: firstText([cfg.devAudioBase]) ?? null,
    mockModelKey,
    mockDelayMs: Number.isFinite(delay) && delay >= 0 ? delay : 600,
    mockFault,
    testHooks,
  };
}

// The conversation id a Dynamics form carries, read from formContext without any Xrm global.
// Returns null when the field is absent, empty or not text.
export function extractConversationId(formContext, config) {
  const field = firstText([config?.dynamicsConversationField]) ?? "cqa_conversationid";
  try {
    const value = formContext?.getAttribute?.(field)?.getValue?.();
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  } catch {
    return null;
  }
}
