// Pure parts of the app shell: routing, context, store, toasts. The DOM parts are covered by the
// e2e scenarios 02-shell and 03-dynamics.
import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiError } from "../../src/api/errors.js";
import { extractConversationId, groupOf, parseMockFault, readContext } from "../../src/context.js";
import { t } from "../../src/i18n/ru.js";
import { createStore, isCompact, watch } from "../../src/state/store.js";
import { href, navFor, parseRoute, sameRoute } from "../../src/ui/router.js";
import { dismissToast, errorText, toast, toastError } from "../../src/ui/toast.js";

describe("router", () => {
  test("parses every route of the brief", () => {
    const cases = [
      ["", { name: "workspace", params: {} }],
      ["#", { name: "workspace", params: {} }],
      ["#/", { name: "workspace", params: {} }],
      ["#/c/DEV%3Ap1-ru-001", { name: "workspace", params: { id: "DEV:p1-ru-001" } }],
      ["#/checklists", { name: "checklists", params: {} }],
      ["#/checklists/chk-1/3", { name: "checklist", params: { checklistId: "chk-1", version: "3" } }],
      ["#/checklists/chk-1/3/edit", { name: "editor", params: { checklistId: "chk-1", version: "3" } }],
      ["#/appeals", { name: "appeals", params: {} }],
      ["#/appeals/ap-7", { name: "appeal", params: { id: "ap-7" } }],
      ["#/analytics", { name: "analytics", params: {} }],
      ["#/accuracy", { name: "accuracy", params: {} }],
    ];
    for (const [hash, expected] of cases) assert.deepEqual(parseRoute(hash), expected, hash);
  });

  test("tolerates a trailing slash and a missing leading one", () => {
    assert.deepEqual(parseRoute("#/checklists/"), { name: "checklists", params: {} });
    assert.deepEqual(parseRoute("#checklists"), { name: "checklists", params: {} });
    assert.deepEqual(parseRoute("appeals"), { name: "appeals", params: {} });
  });

  test("compare reads its query; unknown keys and empty values are left out", () => {
    const route = parseRoute("#/compare?from_checklist=a&from_version=1&to_checklist=b&to_version=2&group_id=DEV&x=1&to_version=");
    assert.equal(route.name, "compare");
    assert.deepEqual(route.params, { from_checklist: "a", from_version: "1", to_checklist: "b", to_version: "2", group_id: "DEV" });
    assert.deepEqual(parseRoute("#/compare"), { name: "compare", params: {} });
  });

  test("unknown or malformed hashes are notfound, never an exception", () => {
    for (const hash of ["#/nope", "#/c", "#/c//x", "#/c/%E0%A4%A", "#/checklists/x", "#/checklists/x/y", "#/checklists/x/1/oops", "#/appeals/a/b", "#/analytics/x"]) {
      assert.equal(parseRoute(hash).name, "notfound", hash);
    }
    assert.deepEqual(parseRoute(undefined), { name: "workspace", params: {} });
    assert.deepEqual(parseRoute(null), { name: "workspace", params: {} });
  });

  test("parseRoute and href round-trip with ids containing ':' and '/'", () => {
    const routes = [
      ["workspace", {}],
      ["workspace", { id: "DEV:p1-ru-001" }],
      ["workspace", { id: "GRP/1:conv/2 x?#%" }],
      ["checklists", {}],
      ["checklist", { checklistId: "a/b:c", version: "12" }],
      ["editor", { checklistId: "a/b:c", version: "1" }],
      ["appeals", {}],
      ["appeal", { id: "ap/1:2" }],
      ["compare", {}],
      ["compare", { from_checklist: "a/b", from_version: "1", to_checklist: "c:d", to_version: "2", group_id: "DEV" }],
      ["analytics", {}],
      ["accuracy", {}],
    ];
    for (const [name, params] of routes) {
      const link = href(name, params);
      assert.match(link, /^#\//, link);
      assert.ok(!link.slice(2).split("?")[0].includes(":"), `unencoded colon in ${link}`);
      assert.deepEqual(parseRoute(link), { name, params }, link);
    }
    assert.equal(href("workspace", { id: "DEV:p1" }), "#/c/DEV%3Ap1");
    assert.equal(href("workspace"), "#/");
  });

  test("href refuses an unknown route and a missing parameter", () => {
    assert.throws(() => href("nope"), TypeError);
    assert.throws(() => href("checklist", { checklistId: "a" }), TypeError);
    assert.throws(() => href("appeal", {}), TypeError);
  });

  test("navFor maps detail routes to their nav item; sameRoute compares name and params", () => {
    assert.equal(navFor("workspace"), "workspace");
    assert.equal(navFor("editor"), "checklists");
    assert.equal(navFor("compare"), "checklists");
    assert.equal(navFor("appeal"), "appeals");
    assert.equal(navFor("notfound"), null);
    assert.ok(sameRoute({ name: "workspace", params: { id: "a" } }, { name: "workspace", params: { id: "a" } }));
    assert.ok(!sameRoute({ name: "workspace", params: { id: "a" } }, { name: "workspace", params: { id: "b" } }));
    assert.ok(!sameRoute({ name: "appeals", params: {} }, { name: "analytics", params: {} }));
  });
});

describe("readContext", () => {
  test("embedded defaults to light, standalone to dark", () => {
    assert.equal(readContext("?conversationId=c1", {}).theme, "light");
    assert.equal(readContext("?mode=embedded", {}).theme, "light");
    assert.equal(readContext("", {}).theme, "dark");
    assert.equal(readContext("?theme=light", {}).theme, "light");
  });

  test("defaults: http api, dark, controller, standalone", () => {
    const ctx = readContext("", {});
    assert.equal(ctx.api, "http");
    assert.equal(ctx.apiBase, "api");
    assert.equal(ctx.role, "controller");
    assert.equal(ctx.theme, "dark");
    assert.equal(ctx.themeExplicit, false);
    assert.equal(ctx.mode, "standalone");
    assert.equal(ctx.conversationId, null);
    assert.equal(ctx.mockModelKey, true);
    assert.deepEqual(ctx.mockFault, {});
    assert.deepEqual(readContext(undefined, undefined), ctx);
  });

  test("URL parameters override the config", () => {
    const config = { api: "http", apiBase: "api", role: "controller", theme: "light", mode: "standalone" };
    const ctx = readContext("?api=mock&apiBase=https%3A%2F%2Fx.example%2Fapi&role=reviewer&theme=dark&mode=embedded", config);
    assert.equal(ctx.api, "mock");
    assert.equal(ctx.apiBase, "https://x.example/api");
    assert.equal(ctx.role, "reviewer");
    assert.equal(ctx.theme, "dark");
    assert.equal(ctx.themeExplicit, true);
    assert.equal(ctx.mode, "embedded");
  });

  test("the config applies where the URL is silent; bad values fall through", () => {
    const ctx = readContext("?role=admin&theme=blue&mode=popup&api=ftp", { api: "mock", role: "reviewer", theme: "dark", mode: "embedded" });
    assert.equal(ctx.api, "mock");
    assert.equal(ctx.role, "reviewer");
    assert.equal(ctx.theme, "dark");
    assert.equal(ctx.themeExplicit, false);
    assert.equal(ctx.mode, "embedded");
  });

  test("conversationId implies embedded, even against mode=standalone", () => {
    assert.equal(readContext("?conversationId=DEV%3Ap1-ru-001", {}).conversationId, "DEV:p1-ru-001");
    assert.equal(readContext("?conversationId=DEV%3Ap1-ru-001", {}).mode, "embedded");
    assert.equal(readContext("?conversationId=x&mode=standalone", {}).mode, "embedded");
    assert.equal(readContext("", { conversationId: "G:1" }).mode, "embedded");
    assert.equal(readContext("?conversationId=", {}).mode, "standalone");
  });

  test("mount options beat the URL, which beats the config", () => {
    const ctx = readContext("?role=reviewer&theme=dark", { role: "controller" }, { role: "controller", theme: "light" });
    assert.equal(ctx.role, "controller");
    assert.equal(ctx.theme, "light");
    assert.equal(ctx.themeExplicit, true);
  });

  test("dev settings come from the config only", () => {
    const ctx = readContext("?devDataUrl=evil&mockDelayMs=1", { devDataUrl: "data/dev.json", devAudioBase: "data/audio/", mockDelayMs: 250, mockModelKey: false });
    assert.equal(ctx.devDataUrl, "data/dev.json");
    assert.equal(ctx.devAudioBase, "data/audio/");
    assert.equal(ctx.mockDelayMs, 250);
    assert.equal(ctx.mockModelKey, false);
  });

  test("mockFault and mockModelKey in the URL are honoured only with testHooks", () => {
    const search = "?mockFault=startEvaluations:network&mockModelKey=0";
    const off = readContext(search, { mockModelKey: true });
    assert.deepEqual(off.mockFault, {});
    assert.equal(off.mockModelKey, true);
    for (const testHooks of [false, "true", 1, undefined]) {
      assert.deepEqual(readContext(search, { testHooks }).mockFault, {}, String(testHooks));
    }
    const on = readContext(search, { testHooks: true, mockModelKey: true });
    assert.deepEqual(on.mockFault, { startEvaluations: "network" });
    assert.equal(on.mockModelKey, false);
    assert.equal(readContext("?mockModelKey=1", { testHooks: true, mockModelKey: false }).mockModelKey, true);
    assert.equal(readContext("?mockModelKey=maybe", { testHooks: true, mockModelKey: false }).mockModelKey, false);
  });

  test("parseMockFault takes repeated and comma-separated method:code pairs", () => {
    assert.deepEqual(parseMockFault(["getConfig:timeout", "a:b,startEvaluations:model_key_missing"]), {
      getConfig: "timeout",
      a: "b",
      startEvaluations: "model_key_missing",
    });
    assert.deepEqual(parseMockFault(["", "nocolon", ":x", "y:", "1bad:x", "ok:Bad Code", "ok:fine"]), { ok: "fine" });
    assert.deepEqual(parseMockFault([]), {});
  });

  test("groupOf takes the part before the first colon", () => {
    assert.equal(groupOf("DEV:p1-ru-001"), "DEV");
    assert.equal(groupOf("G:a:b"), "G");
    assert.equal(groupOf("nocolon"), null);
    assert.equal(groupOf(":x"), null);
    assert.equal(groupOf(undefined), null);
  });
});

describe("extractConversationId (Dynamics hand-over)", () => {
  const form = (values) => ({ getAttribute: (name) => (name in values ? { getValue: () => values[name] } : null) });

  test("reads cqa_conversationid by default", () => {
    assert.equal(extractConversationId(form({ cqa_conversationid: "DEV:p1-ru-001" }), {}), "DEV:p1-ru-001");
    assert.equal(extractConversationId(form({ cqa_conversationid: "  DEV:p1  " }), undefined), "DEV:p1");
  });

  test("the field name comes from config.dynamicsConversationField", () => {
    const formContext = form({ new_dialog: "G:1", cqa_conversationid: "WRONG" });
    assert.equal(extractConversationId(formContext, { dynamicsConversationField: "new_dialog" }), "G:1");
  });

  test("a missing attribute, an empty value or a broken form context gives null", () => {
    assert.equal(extractConversationId(form({}), {}), null);
    assert.equal(extractConversationId(form({ cqa_conversationid: null }), {}), null);
    assert.equal(extractConversationId(form({ cqa_conversationid: "  " }), {}), null);
    assert.equal(extractConversationId(form({ cqa_conversationid: 42 }), {}), null);
    assert.equal(extractConversationId(null, {}), null);
    assert.equal(extractConversationId({}, {}), null);
    assert.equal(extractConversationId({ getAttribute() { throw new Error("boom"); } }, {}), null);
  });
});

describe("store", () => {
  test("notifies subscribers once per set, with the new and the previous state", () => {
    const store = createStore({ a: 1, b: 1 });
    const calls = [];
    store.subscribe((state, previous) => calls.push([state.a, state.b, previous.a, previous.b]));
    store.set({ a: 2, b: 3 });
    assert.deepEqual(calls, [[2, 3, 1, 1]]);
    store.set({ a: 4 });
    assert.deepEqual(calls, [[2, 3, 1, 1], [4, 3, 2, 3]]);
    assert.deepEqual(store.get(), { a: 4, b: 3 });
  });

  test("unsubscribe stops notifications; a subscriber may unsubscribe itself", () => {
    const store = createStore({ n: 0 });
    let first = 0;
    let second = 0;
    const off = store.subscribe(() => first++);
    const offSelf = store.subscribe(() => {
      second++;
      offSelf();
    });
    store.set({ n: 1 });
    store.set({ n: 2 });
    off();
    store.set({ n: 3 });
    assert.equal(first, 2);
    assert.equal(second, 1);
  });

  test("get returns a new object after a set and never exposes the initial object", () => {
    const initial = { x: 1 };
    const store = createStore(initial);
    const before = store.get();
    store.set({ x: 2 });
    assert.notEqual(store.get(), before);
    assert.equal(before.x, 1);
    assert.equal(initial.x, 1);
  });

  test("set accepts an updater function", () => {
    const store = createStore({ n: 1 });
    store.set((state) => ({ n: state.n + 1 }));
    assert.equal(store.get().n, 2);
  });

  test("a throwing subscriber does not stop the others", () => {
    const store = createStore({ n: 0 });
    const errors = mock.method(console, "error", () => {});
    try {
      let reached = false;
      store.subscribe(() => {
        throw new Error("boom");
      });
      store.subscribe(() => {
        reached = true;
      });
      store.set({ n: 1 });
      assert.ok(reached);
      assert.equal(errors.mock.callCount(), 1);
    } finally {
      errors.mock.restore();
    }
  });

  test("watch fires only when the selected value changes", () => {
    const store = createStore({ theme: "light", other: 0 });
    const seen = [];
    const off = watch(store, (state) => state.theme, (next, previous) => seen.push([next, previous]));
    store.set({ other: 1 });
    store.set({ theme: "dark" });
    store.set({ theme: "dark", other: 2 });
    store.set({ theme: "light" });
    off();
    store.set({ theme: "dark" });
    assert.deepEqual(seen, [["dark", "light"], ["light", "dark"]]);
  });

  test("isCompact needs embedded mode and a conversation", () => {
    assert.equal(isCompact({ mode: "embedded", conversationId: "G:1" }), true);
    assert.equal(isCompact({ mode: "embedded", conversationId: null }), false);
    assert.equal(isCompact({ mode: "standalone", conversationId: "G:1" }), false);
  });
});

// Every code the backend can return (agreed 2026-11-07), plus the three the client raises itself.
const BACKEND_CODES = [
  "invalid_request", "na_not_allowed", "step_not_in_scale", "bad_answer", "reason_required", "invalid_checklist",
  "appeal_already_decided", "appeal_already_open", "checklist_locked", "model_key_missing", "organizer_url_missing",
  "role_not_allowed", "not_found", "organizer_error", "no_records", "bad_record", "internal_error",
];
const CLIENT_CODES = ["network", "timeout", "bad_response"];

// The coordinator's list lives in the (untracked) SDD folder; when it is there, read the codes
// from it so a code added later cannot slip past this test.
function codesFromErrorList() {
  const file = fileURLToPath(new URL("../../../.superpowers/sdd/2026-11-07-cqa-frontend/error-codes.md", import.meta.url));
  if (!existsSync(file)) return [];
  const codes = new Set();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.startsWith("- ") || line.includes("warnings")) continue;
    for (const [code] of line.split(" — ")[0].matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) codes.add(code);
  }
  return [...codes];
}

describe("toast", () => {
  const fresh = () => createStore({ toasts: [] });

  test("every backend and client error code has its own Russian text", () => {
    const listed = codesFromErrorList();
    for (const code of listed) assert.ok(BACKEND_CODES.includes(code), `error-codes.md lists ${code}; add it to BACKEND_CODES and ru.js`);
    const all = [...new Set([...BACKEND_CODES, ...CLIENT_CODES, ...listed])];
    const generic = t("error.generic");
    const seen = new Map();
    for (const code of all) {
      const text = errorText(new ApiError(code, "dev message"));
      assert.match(text, /[А-Яа-я]/, code);
      assert.notEqual(text, generic, `${code} falls back to the generic text`);
      assert.ok(!seen.has(text), `${code} and ${seen.get(text)} share a text`);
      seen.set(text, code);
    }
  });

  test("a code suffix after a colon is stripped; bad_record:<index> names the record", () => {
    const generic = t("error.generic");
    assert.equal(errorText(new ApiError("bad_record:3", "x")), t("error.bad_record_at", { n: 4 }));
    assert.match(errorText(new ApiError("bad_record:0", "x")), /№1\b/);
    assert.equal(errorText(new ApiError("bad_record:", "x")), t("error.bad_record"));
    assert.equal(errorText(new ApiError("bad_record:abc", "x")), t("error.bad_record"));
    assert.equal(errorText(new ApiError("bad_record", "x")), t("error.bad_record"));
    assert.equal(errorText(new ApiError("not_found:zzz", "x")), t("error.not_found"));
    assert.equal(errorText(new ApiError(":3", "x")), generic);
    assert.equal(errorText(new ApiError("unknown_code:3", "x")), generic);
  });

  test("errorText maps the API codes to Russian strings", () => {
    const codes = ["network", "timeout", "bad_response", "model_key_missing"];
    const texts = codes.map((code) => errorText(new ApiError(code, "dev message")));
    for (const text of texts) assert.match(text, /[А-Яа-я]/);
    assert.equal(new Set(texts).size, codes.length, "each code has its own text");
    const generic = errorText(new ApiError("something_new", "x"));
    assert.match(generic, /[А-Яа-я]/);
    assert.ok(!texts.includes(generic));
    assert.equal(errorText(new Error("plain")), generic);
    assert.equal(errorText(undefined), generic);
    assert.ok(!errorText(new ApiError("network", "SECRET-DEV-MESSAGE")).includes("SECRET"));
  });

  test("toast adds an entry; dismissToast removes only that entry", () => {
    const store = fresh();
    const a = toast(store, { kind: "info", text: "один" });
    const b = toast(store, { kind: "error", text: "два" });
    assert.deepEqual(store.get().toasts.map((x) => [x.id, x.kind, x.text]), [[a, "info", "один"], [b, "error", "два"]]);
    dismissToast(store, a);
    assert.deepEqual(store.get().toasts.map((x) => x.id), [b]);
  });

  test("dismissing an unknown id does not notify", () => {
    const store = fresh();
    let calls = 0;
    store.subscribe(() => calls++);
    dismissToast(store, 12345);
    assert.equal(calls, 0);
  });

  test("an identical toast replaces the earlier one; the list is capped", () => {
    const store = fresh();
    toast(store, { kind: "error", text: "same" });
    toast(store, { kind: "error", text: "same" });
    assert.equal(store.get().toasts.length, 1);
    for (let i = 0; i < 10; i++) toast(store, { kind: "error", text: `e${i}` });
    assert.ok(store.get().toasts.length <= 4);
    assert.equal(store.get().toasts.at(-1).text, "e9");
  });

  test("rejects a bad kind or empty text", () => {
    const store = fresh();
    assert.throws(() => toast(store, { kind: "warn", text: "x" }), TypeError);
    assert.throws(() => toast(store, { kind: "info", text: "" }), TypeError);
  });

  test("info toasts dismiss themselves; error toasts stay", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const store = fresh();
      toast(store, { kind: "info", text: "ok" });
      toast(store, { kind: "error", text: "bad" });
      mock.timers.tick(60000);
      assert.deepEqual(store.get().toasts.map((x) => x.text), ["bad"]);
    } finally {
      mock.timers.reset();
    }
  });

  test("toastError offers a retry only for a retryable error", () => {
    const store = fresh();
    const retry = () => {};
    toastError(store, new ApiError("network", "x"), { retry });
    toastError(store, new ApiError("model_key_missing", "x"), { retry });
    const [network, key] = store.get().toasts;
    assert.equal(network.kind, "error");
    assert.equal(network.retry, retry);
    assert.equal(key.retry, null);
    toastError(store, new ApiError("timeout", "x"));
    assert.equal(store.get().toasts.at(-1).retry, null);
  });
});
