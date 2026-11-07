// HTTP adapter: contract paths and methods (spec section 7), role on mutating bodies, id encoding,
// the error taxonomy (server codes plus network, timeout, bad_response) and audio URL resolution.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../../src/api/errors.js";
import { createHttpApi } from "../../src/api/http.js";
import { createApi } from "../../src/api/index.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A fake fetch that records every request and answers with `respond(request)`.
function recorder(respond = () => json({ ok: true })) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      signal: init.signal,
    };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetchImpl };
}

function make(options = {}) {
  const rec = recorder(options.respond);
  const api = createHttpApi({
    apiBase: options.apiBase ?? "api",
    role: options.role ?? (() => "reviewer"),
    fetchImpl: rec.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  return { api, calls: rec.calls };
}

const ID = "DEV:p1-ru-001";
const EID = "DEV:p1-ru-001";

// [method name, args, expected HTTP method, expected path (with query), expected body or undefined]
const TABLE = [
  ["getConfig", [], "GET", "api/config"],
  ["importDataset", ["DEV"], "GET", "api/datasets/DEV"],
  ["uploadConversations", [{ records: [{ conversation_id: "x" }] }], "POST", "api/conversations", { records: [{ conversation_id: "x" }], role: "reviewer" }],
  ["uploadConversations", [[{ conversation_id: "x" }]], "POST", "api/conversations", { records: [{ conversation_id: "x" }], role: "reviewer" }],
  ["listConversations", [], "GET", "api/conversations"],
  [
    "listConversations",
    [{ group_id: "DEV", status: "new", channel: "voice call", language: "ru", q: "карта" }],
    "GET",
    "api/conversations?group_id=DEV&status=new&channel=voice+call&language=ru&q=%D0%BA%D0%B0%D1%80%D1%82%D0%B0",
  ],
  ["listConversations", [{ group_id: "DEV", status: undefined, channel: null, q: "" }], "GET", "api/conversations?group_id=DEV"],
  ["getConversation", [ID], "GET", "api/conversations/DEV%3Ap1-ru-001"],
  ["getTranslation", [ID, "ru"], "GET", "api/conversations/DEV%3Ap1-ru-001/translation?to=ru"],
  ["listChecklists", [], "GET", "api/checklists"],
  ["getChecklistVersion", ["official-chat", 1], "GET", "api/checklists/official-chat/versions/1"],
  [
    "createChecklist",
    [{ name: "Copy", based_on: { checklist_id: "official-chat", version: 1 } }],
    "POST",
    "api/checklists",
    { checklist: { name: "Copy", based_on: { checklist_id: "official-chat", version: 1 } }, role: "reviewer" },
  ],
  [
    "saveChecklistVersion",
    ["my-list", { name: "v2", criteria: [] }],
    "POST",
    "api/checklists/my-list/versions",
    { checklist: { name: "v2", criteria: [] }, role: "reviewer" },
  ],
  [
    "startEvaluations",
    [{ conversations: [ID, "DEV:p1-ru-002"], checklist_id: "official-chat", version: 1 }],
    "POST",
    "api/evaluations",
    { conversations: [ID, "DEV:p1-ru-002"], checklist_id: "official-chat", version: 1, mode: "reuse", dry_run: false, role: "reviewer" },
  ],
  [
    "startEvaluations",
    [{ conversations: [ID], checklist_id: "c", version: 2, mode: "full", dry_run: true }],
    "POST",
    "api/evaluations",
    { conversations: [ID], checklist_id: "c", version: 2, mode: "full", dry_run: true, role: "reviewer" },
  ],
  ["getJob", ["job-1"], "GET", "api/jobs/job-1"],
  ["retryJob", ["job-1"], "POST", "api/jobs/job-1/retry", { role: "reviewer" }],
  ["listEvaluations", [{}], "GET", "api/evaluations"],
  ["listEvaluations", [{ conversation: ID, checklist_id: "official-chat" }], "GET", "api/evaluations?conversation=DEV%3Ap1-ru-001&checklist_id=official-chat"],
  ["getEvaluation", [EID + "#1"], "GET", "api/evaluations/DEV%3Ap1-ru-001%231"],
  [
    "fileAppeal",
    [{ evaluation_id: "ev-1", criterion_id: "c3", comment: "не согласен" }],
    "POST",
    "api/appeals",
    { evaluation_id: "ev-1", criterion_id: "c3", comment: "не согласен", role: "reviewer" },
  ],
  ["listAppeals", [], "GET", "api/appeals"],
  ["listAppeals", [{ status: "open" }], "GET", "api/appeals?status=open"],
  ["getAppeal", ["ap-1"], "GET", "api/appeals/ap-1"],
  [
    "decideAppeal",
    ["ap-1", { outcome: "changed", answer: { step: 15 }, reason: "есть доказательство" }],
    "POST",
    "api/appeals/ap-1/decision",
    { outcome: "changed", answer: { step: 15 }, reason: "есть доказательство", role: "reviewer" },
  ],
  [
    "getComparison",
    [{ from_checklist: "a", from_version: 1, to_checklist: "a", to_version: 2, group_id: "DEV" }],
    "GET",
    "api/comparisons?from_checklist=a&from_version=1&to_checklist=a&to_version=2&group_id=DEV",
  ],
  [
    "getComparison",
    [{ from_checklist: "a", from_version: 1, to_checklist: "b", to_version: 1, conversations: [ID, "DEV:p1-ru-002"] }],
    "GET",
    "api/comparisons?from_checklist=a&from_version=1&to_checklist=b&to_version=1&conversations=DEV%3Ap1-ru-001&conversations=DEV%3Ap1-ru-002",
  ],
  ["getAccuracy", [], "GET", "api/reports/accuracy"],
  ["getAnalytics", [], "GET", "api/analytics"],
];

describe("http adapter: contract paths, methods and bodies", () => {
  for (const [name, args, method, url, body] of TABLE) {
    test(`${name}(${JSON.stringify(args).slice(0, 60)}) -> ${method} ${url}`, async () => {
      const { api, calls } = make();
      await api[name](...args);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, method);
      assert.equal(calls[0].url, url);
      assert.deepEqual(calls[0].body, body);
    });
  }

  test("the table covers every async method of the interface", () => {
    const covered = new Set(TABLE.map(([name]) => name));
    const { api } = make();
    const sync = new Set(["audioUrl", "exportCsvUrl"]);
    for (const name of Object.keys(api)) if (!sync.has(name)) assert.ok(covered.has(name), `${name} not in the table`);
    for (const name of covered) assert.equal(typeof api[name], "function", name);
  });

  test("an absolute apiBase is used as given, trailing slashes dropped", async () => {
    const { api, calls } = make({ apiBase: "http://127.0.0.1:8000/api//" });
    await api.getConfig();
    await api.getJob("j1");
    assert.deepEqual(
      calls.map((c) => c.url),
      ["http://127.0.0.1:8000/api/config", "http://127.0.0.1:8000/api/jobs/j1"],
    );
  });

  test("GET sends Accept only; POST sends JSON content type", async () => {
    const { api, calls } = make();
    await api.getConfig();
    await api.retryJob("j1");
    assert.equal(calls[0].headers.Accept, "application/json");
    assert.equal(calls[0].headers["Content-Type"], undefined);
    assert.equal(calls[1].headers["Content-Type"], "application/json");
  });

  test("the response JSON is returned as is", async () => {
    const { api } = make({ respond: () => json({ id: "j1", status: "running" }) });
    assert.deepEqual(await api.getJob("j1"), { id: "j1", status: "running" });
  });

  test("missing path arguments are programming errors, not requests", async () => {
    const { api, calls } = make();
    await assert.rejects(() => api.getConversation(undefined), TypeError);
    await assert.rejects(() => api.getJob(""), TypeError);
    assert.equal(calls.length, 0);
  });
});

describe("http adapter: ids are encoded", () => {
  test('"DEV:p1-ru-001" -> DEV%3Ap1-ru-001 in every path position', async () => {
    const { api, calls } = make();
    await api.getConversation("DEV:p1-ru-001");
    await api.getTranslation("DEV:p1-ru-001", "ru");
    await api.getChecklistVersion("a/b c", "1");
    assert.equal(calls[0].url, "api/conversations/DEV%3Ap1-ru-001");
    assert.equal(calls[1].url, "api/conversations/DEV%3Ap1-ru-001/translation?to=ru");
    assert.equal(calls[2].url, "api/checklists/a%2Fb%20c/versions/1");
  });
});

describe("http adapter: role", () => {
  test("every mutating call carries the current role, read at call time", async () => {
    let role = "controller";
    const { api, calls } = make({ role: () => role });
    await api.retryJob("j1");
    role = "reviewer";
    await api.fileAppeal({ evaluation_id: "e", criterion_id: "c", comment: "x" });
    await api.decideAppeal("a1", { outcome: "confirmed", reason: "ok" });
    await api.createChecklist({ name: "n" });
    await api.saveChecklistVersion("c1", { name: "n" });
    await api.startEvaluations({ conversations: [ID], checklist_id: "c", version: 1 });
    await api.uploadConversations({ conversation_id: "x" });
    assert.deepEqual(
      calls.map((c) => c.body.role),
      ["controller", "reviewer", "reviewer", "reviewer", "reviewer", "reviewer", "reviewer"],
    );
  });

  test("the role wins over a role field smuggled into the payload", async () => {
    const { api, calls } = make({ role: () => "controller" });
    await api.createChecklist({ name: "n", role: "reviewer" });
    assert.equal(calls[0].body.role, "controller");
  });

  test("GET calls carry no body and no role", async () => {
    const { api, calls } = make();
    await api.getConfig();
    await api.listAppeals({ status: "open" });
    for (const c of calls) {
      assert.equal(c.body, undefined);
      assert.ok(!c.url.includes("role"));
    }
  });

  test("an unknown role is refused before any request is made", async () => {
    const { api, calls } = make({ role: () => "admin" });
    await assert.rejects(() => api.retryJob("j1"), TypeError);
    assert.equal(calls.length, 0);
  });
});

describe("http adapter: errors (Review Focus 3)", () => {
  test("409 model_key_missing -> ApiError, retryable false", async () => {
    const { api } = make({
      respond: () => json({ error: "model_key_missing", message: "No model key is configured" }, 409),
    });
    await assert.rejects(
      () => api.startEvaluations({ conversations: [ID], checklist_id: "c", version: 1 }),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.ok(err instanceof Error);
        assert.equal(err.name, "ApiError");
        assert.equal(err.code, "model_key_missing");
        assert.equal(err.status, 409);
        assert.equal(err.retryable, false);
        assert.equal(err.message, "No model key is configured");
        return true;
      },
    );
  });

  test("4xx other than the above stays non-retryable", async () => {
    const { api } = make({ respond: () => json({ error: "not_found", message: "no such job" }, 404) });
    await assert.rejects(() => api.getJob("zz"), { code: "not_found", status: 404, retryable: false });
  });

  test("500 -> retryable true, server code kept", async () => {
    const { api } = make({ respond: () => json({ error: "internal", message: "boom" }, 500) });
    await assert.rejects(() => api.getConfig(), { code: "internal", status: 500, retryable: true });
  });

  test("fetch rejects -> code network, retryable true, no status", async () => {
    const { api } = make({
      respond: () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await assert.rejects(
      () => api.getConfig(),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, "network");
        assert.equal(err.status, null);
        assert.equal(err.retryable, true);
        assert.match(err.message, /Failed to fetch/);
        return true;
      },
    );
  });

  test("abort after the timeout -> code timeout, retryable true", async () => {
    const respond = (call) =>
      new Promise((_, reject) => {
        call.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const { api } = make({ respond, timeoutMs: 20 });
    await assert.rejects(() => api.getConfig(), { code: "timeout", status: null, retryable: true });
  });

  test("a body that stalls past the timeout is a timeout too", async () => {
    const respond = (call) => ({
      ok: true,
      status: 200,
      text: () =>
        new Promise((_, reject) => {
          call.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    });
    const { api } = make({ respond, timeoutMs: 20 });
    await assert.rejects(() => api.getConfig(), { code: "timeout" });
  });

  test("non-JSON success body -> bad_response", async () => {
    const { api } = make({ respond: () => new Response("<!doctype html><title>x</title>", { status: 200 }) });
    await assert.rejects(() => api.getConfig(), { code: "bad_response", status: 200, retryable: false });
  });

  test("empty success body -> bad_response", async () => {
    const { api } = make({ respond: () => new Response("", { status: 200 }) });
    await assert.rejects(() => api.getConfig(), { code: "bad_response" });
  });

  test("non-JSON error body (proxy page) -> bad_response, retryable follows the 5xx status", async () => {
    const { api } = make({ respond: () => new Response("<html>Bad gateway</html>", { status: 502 }) });
    await assert.rejects(() => api.getConfig(), { code: "bad_response", status: 502, retryable: true });
  });

  test("an error status with JSON that is not {error, message} -> bad_response", async () => {
    const { api } = make({ respond: () => json({ detail: [{ msg: "field required" }] }, 422) });
    await assert.rejects(() => api.getConfig(), { code: "bad_response", status: 422, retryable: false });
  });

  test("a failed call does not leave a timer behind", async () => {
    // node:test would hang on a live timer, so completing this file proves the timers are cleared.
    const { api } = make({ respond: () => json({ error: "x", message: "y" }, 400), timeoutMs: 60000 });
    await assert.rejects(() => api.getConfig(), { code: "x" });
  });
});

describe("ApiError", () => {
  test("retryable defaults: network, timeout and 5xx are retryable, the rest are not", () => {
    assert.equal(new ApiError("network", "m").retryable, true);
    assert.equal(new ApiError("timeout", "m").retryable, true);
    assert.equal(new ApiError("anything", "m", { status: 503 }).retryable, true);
    assert.equal(new ApiError("anything", "m", { status: 499 }).retryable, false);
    assert.equal(new ApiError("bad_response", "m", { status: 200 }).retryable, false);
  });
});

describe("audio and export URLs", () => {
  const conversation = { id: ID, audio: "conversations/DEV%3Ap1-ru-001/audio" };

  test("audioUrl resolves relative to a relative apiBase", () => {
    const { api } = make({ apiBase: "api" });
    assert.equal(api.audioUrl(conversation), "api/conversations/DEV%3Ap1-ru-001/audio");
  });

  test("audioUrl resolves against an absolute apiBase + /", () => {
    const { api } = make({ apiBase: "http://127.0.0.1:8000/api" });
    assert.equal(api.audioUrl(conversation), "http://127.0.0.1:8000/api/conversations/DEV%3Ap1-ru-001/audio");
  });

  test("audioUrl is null when the conversation has no audio", () => {
    const { api } = make();
    assert.equal(api.audioUrl({ id: ID, audio: null, audio_unavailable_reason: "none" }), null);
    assert.equal(api.audioUrl({ id: ID }), null);
    assert.equal(api.audioUrl(null), null);
  });

  test("audioUrl never yields a non-http(s) absolute URL", () => {
    const { api } = make({ apiBase: "http://h/api" });
    assert.equal(api.audioUrl({ audio: "data:audio/wav;base64,AAAA" }), null);
    assert.equal(make().api.audioUrl({ audio: "data:audio/wav;base64,AAAA" }), null);
  });

  test("exportCsvUrl keeps the base style and encodes the group", () => {
    assert.equal(make({ apiBase: "api" }).api.exportCsvUrl("DEV"), "api/export.csv?group_id=DEV");
    assert.equal(
      make({ apiBase: "https://h.example/api/" }).api.exportCsvUrl("upload-2026 11"),
      "https://h.example/api/export.csv?group_id=upload-2026+11",
    );
  });

  test("neither URL helper makes a request", () => {
    const { api, calls } = make();
    api.audioUrl(conversation);
    api.exportCsvUrl("DEV");
    assert.equal(calls.length, 0);
  });
});

describe("createApi", () => {
  test('"http" returns the HTTP adapter wired to the options', async () => {
    const rec = recorder();
    const api = createApi({ api: "http", apiBase: "/x/api", role: () => "controller", fetchImpl: rec.fetchImpl });
    await api.retryJob("j9");
    assert.equal(rec.calls[0].url, "/x/api/jobs/j9/retry");
    assert.equal(rec.calls[0].body.role, "controller");
  });

  test("any other value throws a clear error", () => {
    assert.throws(() => createApi({ api: "ftp" }), /ftp/);
    assert.throws(() => createApi({}), /api/);
    assert.throws(() => createApi(), /api/);
  });
});
