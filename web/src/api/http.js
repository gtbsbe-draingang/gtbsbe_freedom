import { getAudioWaveform } from "./audio-waveform.js";
// HTTP adapter for the backend API (spec section 7). The only module family that may call fetch.
//
// Every method returns the parsed JSON of the response, or throws an ApiError:
//   - the server's {error, message} with a 4xx/5xx status  -> code = error, status kept;
//   - fetch itself rejected                                  -> code "network";
//   - the request outlived `timeoutMs` (headers or body)     -> code "timeout";
//   - a body that is not JSON, or an error that is not
//     {error, message}                                       -> code "bad_response".
// `retryable` is true for network, timeout and 5xx.
import { ApiError } from "./errors.js";

const ROLES = new Set(["controller", "reviewer"]);
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HTTP_URL = /^https?:\/\//i;

// One path segment. Ids contain ":" (`DEV:p1-ru-001`), so nothing goes into a path unencoded.
function seg(value, name = "path segment") {
  if (value === undefined || value === null || value === "") {
    throw new TypeError(`API call is missing ${name}`);
  }
  return encodeURIComponent(String(value));
}

// Query string from an ordered list of keys. undefined, null and "" are left out (an empty filter
// means "no filter", and an empty enum value would be rejected by the server); an array becomes
// repeated parameters.
function query(params, keys) {
  const search = new URLSearchParams();
  for (const key of keys) {
    const value = params?.[key];
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (v === undefined || v === null || v === "") continue;
      search.append(key, String(v));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/**
 * @param {object} options
 * @param {string} options.apiBase  "api" (relative to the page) or "http://host/api".
 * @param {() => "controller" | "reviewer"} options.role  Read at call time; added to every mutating body.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 */
export function createHttpApi({ apiBase, role, fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  if (typeof apiBase !== "string" || apiBase.trim() === "") {
    throw new TypeError("createHttpApi: apiBase is required");
  }
  if (typeof role !== "function") throw new TypeError("createHttpApi: role must be a function");
  if (typeof fetchImpl !== "function") throw new TypeError("createHttpApi: no fetch available");

  const base = apiBase.trim().replace(/\/+$/, "");
  const isAbsolute = HAS_SCHEME.test(base);

  const currentRole = () => {
    const value = role();
    if (!ROLES.has(value)) throw new TypeError(`createHttpApi: role() returned ${JSON.stringify(value)}`);
    return value;
  };

  async function request(method, path, body) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const init = { method, headers: { Accept: "application/json" }, signal: controller.signal };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response;
    let text;
    try {
      // A plain call, not a method call: browsers reject fetch with a foreign `this`.
      const doFetch = fetchImpl;
      response = await doFetch(`${base}/${path}`, init);
      text = await response.text();
    } catch (cause) {
      if (timedOut) throw new ApiError("timeout", `Request timed out after ${timeoutMs} ms`, { cause });
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new ApiError("network", `Network error: ${reason}`, { cause });
    } finally {
      clearTimeout(timer);
    }

    const status = response.status;
    let data;
    let parsed = false;
    try {
      data = JSON.parse(text);
      parsed = true;
    } catch {
      // handled below
    }

    if (!response.ok) {
      if (parsed && data !== null && typeof data === "object" && typeof data.error === "string") {
        throw new ApiError(data.error, typeof data.message === "string" ? data.message : data.error, { status });
      }
      throw new ApiError("bad_response", `HTTP ${status} without an {error, message} body`, { status });
    }
    if (!parsed) throw new ApiError("bad_response", "The response body is not JSON", { status });
    return data;
  }

  const get = (path) => request("GET", path);
  const post = (path, fields = {}) => request("POST", path, { ...fields, role: currentRole() });

  // The absolute-or-relative URL of `rel` under the API base, without a request.
  function resolve(rel) {
    if (isAbsolute) {
      const url = new URL(rel, `${base}/`);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    }
    if (HAS_SCHEME.test(rel)) return HTTP_URL.test(rel) ? rel : null;
    return rel.startsWith("/") ? rel : `${base}/${rel}`;
  }

  return {
    getAudioWaveform,
    getConfig: async () => get("config"),
    importDataset: async (groupId) => get(`datasets/${seg(groupId, "group_id")}`),
    uploadConversations: async (payload) => post("conversations", Array.isArray(payload) ? { records: payload } : payload),

    listConversations: async (filters = {}) =>
      get(`conversations${query(filters, ["group_id", "status", "channel", "language", "q"])}`),
    getConversation: async (id) => get(`conversations/${seg(id, "conversation id")}`),
    audioUrl: (conversation) => {
      const audio = conversation?.audio;
      return typeof audio === "string" && audio !== "" ? resolve(audio) : null;
    },
    getTranslation: async (id, to = "ru") => get(`conversations/${seg(id, "conversation id")}/translation${query({ to }, ["to"])}`),

    listChecklists: async () => get("checklists"),
    getChecklistVersion: async (checklistId, version) =>
      get(`checklists/${seg(checklistId, "checklist id")}/versions/${seg(version, "version")}`),
    createChecklist: async (checklist) => post("checklists", { checklist }),
    saveChecklistVersion: async (checklistId, checklist) =>
      post(`checklists/${seg(checklistId, "checklist id")}/versions`, { checklist }),

    startEvaluations: async ({ conversations, checklist_id, version, mode = "reuse", dry_run = false } = {}) =>
      post("evaluations", { conversations, checklist_id, version, mode, dry_run }),
    getJob: async (id) => get(`jobs/${seg(id, "job id")}`),
    retryJob: async (id) => post(`jobs/${seg(id, "job id")}/retry`),

    listEvaluations: async (filters = {}) => get(`evaluations${query(filters, ["conversation", "checklist_id"])}`),
    getEvaluation: async (id) => get(`evaluations/${seg(id, "evaluation id")}`),

    fileAppeal: async ({ evaluation_id, criterion_id, comment } = {}) =>
      post("appeals", { evaluation_id, criterion_id, comment }),
    listAppeals: async (filters = {}) => get(`appeals${query(filters, ["status"])}`),
    getAppeal: async (id) => get(`appeals/${seg(id, "appeal id")}`),
    decideAppeal: async (id, { outcome, answer, reason } = {}) =>
      post(`appeals/${seg(id, "appeal id")}/decision`, { outcome, answer, reason }),

    getComparison: async (params = {}) =>
      get(
        `comparisons${query(params, [
          "from_checklist",
          "from_version",
          "to_checklist",
          "to_version",
          "group_id",
          "conversations",
        ])}`,
      ),
    getAccuracy: async () => get("reports/accuracy"),
    getAnalytics: async () => get("analytics"),
    exportCsvUrl: (groupId) => `${base}/export.csv${query({ group_id: groupId }, ["group_id"])}`,
  };
}
