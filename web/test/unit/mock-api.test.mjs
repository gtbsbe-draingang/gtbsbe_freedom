// The in-browser mock of the API contract (spec sections 6-7): datasets, deterministic grading,
// evaluations with reuse and carried decisions, appeals, checklists, reports. Every response is
// validated against contract/schemas with ajv, like contract.test.mjs.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveObjectURL } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { ApiError } from "../../src/api/errors.js";
import { createApi } from "../../src/api/index.js";
import { createMockApi } from "../../src/api/mock/index.js";
import { gradeMock } from "../../src/api/mock/grader.js";
import { fingerprint } from "../../src/domain/fingerprint.js";
import { score, validateAnswer } from "../../src/domain/scoring.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const seed = readJson(join(repoRoot, "checklists", "official-chat-v1.json"));

const SCHEMA_NAMES = [
  "error", "conversation", "queue-item", "checklist-version", "checklist-seed", "evaluation",
  "appeal", "job", "config", "comparison", "accuracy", "analytics", "translation", "dry-run",
  "import-summary",
];
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
for (const name of SCHEMA_NAMES) ajv.addSchema(readJson(join(repoRoot, "contract", "schemas", `${name}.schema.json`)));

function assertValid(name, value, what = name) {
  const validate = ajv.getSchema(`cqa/${name}`);
  assert.ok(validate, `schema cqa/${name}`);
  const ok = validate(value);
  assert.ok(ok, `${what} does not match cqa/${name}: ${JSON.stringify(validate.errors?.map((e) => `${e.instancePath || "/"} ${e.message}`))}`);
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    map,
  };
}

const roleBox = { current: "controller" };
const make = (options = {}) =>
  createMockApi({ mockDelayMs: 0, storage: memoryStorage(), role: () => roleBox.current, ...options });

const OFFICIAL = { checklist_id: "official-chat", version: 1 };
const P1 = "A:p1-ru-001";
const P4 = "A:p4-ru-001";

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ApiError, `ApiError expected, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

// Imports group A, runs a batch and returns the finished job.
async function evaluate(api, conversations, checklist = OFFICIAL, mode = "reuse") {
  const started = await api.startEvaluations({ conversations, ...checklist, mode });
  let job = started;
  for (let i = 0; i < 50 && job.status === "running"; i += 1) job = await api.getJob(started.id);
  assert.notEqual(job.status, "running");
  return job;
}

const latestEvaluation = async (api, conversation, checklist = OFFICIAL) =>
  (await api.listEvaluations({ conversation, checklist_id: checklist.checklist_id }))[0];

async function setup(options) {
  const api = make(options);
  await api.importDataset("A");
  return api;
}

describe("datasets", () => {
  test("import DEV-less group loads examples with group-prefixed ids", async () => {
    const api = make();
    const summary = await api.importDataset("A");
    assert.deepEqual(summary, { group_id: "A", total: 2, imported: 2, updated: 0, unchanged: 0 });
    assertValid("import-summary", summary);

    const queue = await api.listConversations({ group_id: "A" });
    assert.deepEqual(queue.map((c) => c.id).sort(), [P1, P4]);
    assert.ok(queue.every((c) => c.group_id === "A" && c.id === `A:${c.conversation_id}`));
    assert.ok(queue.every((c) => !("transcript" in c) && c.final === null && c.status === "new"));
    queue.forEach((c) => assertValid("queue-item", c));

    const conv = await api.getConversation(P1);
    assertValid("conversation", conv);
    assert.equal(conv.group_id, "A");
    assert.ok(conv.transcript.length > 5);
    assert.ok(!("audio_url" in conv));

    // importing again changes nothing
    assert.deepEqual(await api.importDataset("A"), { group_id: "A", total: 2, imported: 0, updated: 0, unchanged: 2 });
  });

  test("DEV without a devDataUrl loads the examples; calls get an audio path only for DEV", async () => {
    const api = make({ devAudioBase: "data/audio/" });
    await api.importDataset("DEV");
    await api.importDataset("A");
    const dev = await api.getConversation("DEV:p4-ru-001");
    assert.equal(dev.audio, "data/audio/p4-ru-001.mp3");
    assert.equal(api.audioUrl(dev), "data/audio/p4-ru-001.mp3");
    const other = await api.getConversation(P4);
    assert.equal(other.audio, null);
    assert.equal(other.audio_unavailable_reason, "needs_import");
    assert.equal(api.audioUrl(other), null);
    const chat = await api.getConversation("DEV:p1-ru-001");
    assert.equal(chat.audio, null);
    assert.equal(chat.audio_unavailable_reason, "none");
    assertValid("conversation", dev);
    assertValid("conversation", chat);
  });

  test("with devDataUrl, importDataset(DEV) fetches it; other groups never do", async () => {
    const requested = [];
    const records = [
      { conversation_id: "d-1", channel: "agent chat", language: "ru", audio_url: "https://x/a.mp3?sig=zzz",
        transcript: [{ timestamp: "00:00", speaker: "client", text: "Привет" }, { timestamp: "00:05", speaker: "operator", text: "Здравствуйте" }] },
    ];
    const fetchImpl = async (url) => {
      requested.push(String(url));
      return new Response(JSON.stringify({ data: { dataset_group_id: "DEV", records } }), { status: 200 });
    };
    const api = make({ devDataUrl: "data/dev.json", fetchImpl });
    const summary = await api.importDataset("DEV");
    assert.deepEqual(summary, { group_id: "DEV", total: 1, imported: 1, updated: 0, unchanged: 0 });
    const conv = await api.getConversation("DEV:d-1");
    assertValid("conversation", conv);
    assert.ok(!JSON.stringify(conv).includes("sig="), "the signed link is dropped");
    await api.importDataset("B");
    assert.deepEqual(requested, ["data/dev.json"]);
  });

  test("a failed dev fetch rejects with network", async () => {
    const api = make({ devDataUrl: "data/dev.json", fetchImpl: async () => { throw new TypeError("offline"); } });
    await rejects(api.importDataset("DEV"), "network");
  });

  test("uploadConversations accepts a record, an array, {records} and an organisers' response", async () => {
    const api = make();
    const record = { conversation_id: "u-1", channel: "agent chat", language: "en",
      transcript: [{ timestamp: "00:00", speaker: "client", text: "Hi" }] };
    const a = await api.uploadConversations(record);
    assert.match(a.group_id, /^upload-\d+/);
    assert.equal(a.total, 1);
    assertValid("import-summary", a);
    const b = await api.uploadConversations([record, { ...record, conversation_id: "u-2" }]);
    assert.equal(b.total, 2);
    const c = await api.uploadConversations({ records: [record] });
    const d = await api.uploadConversations({ data: { dataset_group_id: "CTRL", records: [record] } });
    assert.notEqual(new Set([a.group_id, b.group_id, c.group_id, d.group_id]).size, 1, "each upload gets a group");
    assert.equal(new Set([a.group_id, b.group_id, c.group_id, d.group_id]).size, 4);
    assert.ok((await api.getConversation(`${a.group_id}:u-1`)).id.startsWith("upload-"));
    await rejects(api.uploadConversations({ nothing: true }), "bad_request");
  });

  test("a changed transcript on re-import counts as updated", async () => {
    let text = "Привет";
    const fetchImpl = async () =>
      new Response(JSON.stringify([{ conversation_id: "d-1", channel: "agent chat", language: "ru",
        transcript: [{ timestamp: "00:00", speaker: "client", text }, { timestamp: "00:09", speaker: "operator", text: "Здравствуйте" }] }]));
    const api = make({ devDataUrl: "x.json", fetchImpl });
    assert.equal((await api.importDataset("DEV")).imported, 1);
    assert.equal((await api.importDataset("DEV")).unchanged, 1);
    text = "Добрый день";
    assert.deepEqual(await api.importDataset("DEV"), { group_id: "DEV", total: 1, imported: 0, updated: 1, unchanged: 0 });
  });

  test("getConversation imports the id's group first when it is not loaded", async () => {
    const api = make();
    const conv = await api.getConversation("CTRL:p1-ru-001");
    assert.equal(conv.id, "CTRL:p1-ru-001");
    assert.equal((await api.listConversations({ group_id: "CTRL" })).length, 2);
    await rejects(api.getConversation("CTRL:nope"), "not_found");
    await rejects(api.getConversation("no-colon"), "not_found");
    await rejects(api.getConversation("ZZ:nope"), "not_found");
    assert.equal((await api.listConversations({ group_id: "ZZ" })).length, 0, "a mistyped id leaves no group behind");
  });

  test("queue filters: status, channel, language and q", async () => {
    const api = await setup();
    assert.equal((await api.listConversations({ channel: "voice call" })).length, 1);
    assert.equal((await api.listConversations({ language: "EN" })).length, 0);
    assert.equal((await api.listConversations({ language: "RU" })).length, 2);
    assert.equal((await api.listConversations({ status: "new" })).length, 2);
    assert.equal((await api.listConversations({ status: "evaluated" })).length, 0);
    assert.equal((await api.listConversations({ q: "p4-ru" })).length, 1);
    assert.equal((await api.listConversations({ q: "комиссия" })).length, 1);
    assert.equal((await api.listConversations({ group_id: "Z" })).length, 0);
  });
});

describe("grading", () => {
  test("evaluate -> job done -> evaluation validates against the contract", async () => {
    const api = await setup();
    const job = await evaluate(api, [P1, P4]);
    assertValid("job", job);
    assert.equal(job.status, "done");
    assert.deepEqual([job.total, job.done, job.failed], [2, 2, 0]);
    assert.ok(job.items.every((i) => i.status === "done" && i.evaluation_id));

    for (const item of job.items) {
      const ev = await api.getEvaluation(item.evaluation_id);
      assertValid("evaluation", ev);
      assert.equal(ev.status, "done");
      assert.equal(ev.source, "mock");
      assert.equal(ev.model, "mock");
      assert.equal(ev.cost_usd, 0);
      assert.equal(ev.conversation, item.conversation);
      assert.equal(ev.results.length, 8);
      assert.ok(ev.results.every((r) => r.explanation.startsWith("Демо-оценка:")));
      assert.ok(ev.results.every((r) => r.reused === false && r.carried_decision === null));
    }
    const queue = await api.listConversations({ group_id: "A" });
    assert.ok(queue.every((c) => c.status === "evaluated" && c.final && c.final.version === 1));
    queue.forEach((c) => assertValid("queue-item", c));
  });

  test("totals come from score(): original from model answers, final from final answers", async () => {
    const api = await setup();
    await evaluate(api, [P1, P4]);
    const version = await api.getChecklistVersion("official-chat", 1);
    for (const id of [P1, P4]) {
      const ev = await latestEvaluation(api, id);
      const answers = Object.fromEntries(ev.results.map((r) => [r.criterion_id, { answer: r.answer, kinds: r.kinds }]));
      const expected = score(version, answers);
      assert.equal(ev.original_total, expected.total);
      assert.equal(ev.final_total, expected.total, "no decisions yet");
      assert.deepEqual(ev.sections, expected.sections);
      assert.equal(ev.gross_error.flag, expected.gross_error.flag);
      for (const r of ev.results) {
        const row = expected.results.find((x) => x.criterion_id === r.criterion_id);
        assert.equal(r.points, row.points);
        assert.equal(r.effective_weight, row.effective_weight);
        assert.deepEqual(r.final_answer, r.answer);
      }
    }
  });

  test("grading is deterministic, per conversation and checklist version", async () => {
    const strip = (ev) => ({ ...ev, id: 0, created_at: 0 });
    const run = async () => {
      const api = await setup();
      await evaluate(api, [P1, P4]);
      return [await latestEvaluation(api, P1), await latestEvaluation(api, P4)].map(strip);
    };
    const [first, second] = [await run(), await run()];
    assert.deepEqual(first, second);

    const api = await setup();
    const conv = await api.getConversation(P1);
    const version = await api.getChecklistVersion("official-chat", 1);
    assert.deepEqual(gradeMock(conv, version), gradeMock(conv, version));
    // the seed includes the conversation id: other ids give other answers somewhere
    const sig = (c) => JSON.stringify(gradeMock(c, version).map((r) => [r.answer, r.confidence, r.evidence]));
    assert.ok(["B", "C", "D", "E", "F"].some((g) => sig({ ...conv, id: `${g}:p1-ru-001` }) !== sig(conv)));
  });

  test("answers stay in the allowed set, with N/A only where allowed", async () => {
    const api = await setup();
    const version = await api.getChecklistVersion("official-chat", 1);
    const conv = await api.getConversation(P1);
    const seenNa = new Set();
    let gross = 0;
    for (let i = 0; i < 300; i += 1) {
      const results = gradeMock({ ...conv, id: `G${i}:x` }, version);
      assert.equal(results.length, version.criteria.length);
      results.forEach((r, k) => {
        const c = version.criteria[k];
        assert.equal(r.criterion_id, c.id);
        assert.equal(validateAnswer(c, r.answer), null, `${c.id}: ${JSON.stringify(r.answer)}`);
        if (r.answer === "na") seenNa.add(c.id);
        if (c.kind === "gross_error" && r.answer === "yes") {
          gross += 1;
          assert.ok(r.kinds.length > 0 && r.kinds.every((kind) => c.kinds.includes(kind)));
        } else assert.deepEqual(r.kinds, []);
      });
    }
    assert.ok(!seenNa.has("c01") && !seenNa.has("c05") && !seenNa.has("c06") && !seenNa.has("c08"), "N/A only where allowed");
    assert.ok(["c02", "c03", "c04", "c07"].every((id) => seenNa.has(id)), "N/A does occur where allowed");
    assert.ok(gross > 0 && gross < 60, `gross-error yes is rare, got ${gross}/300`);
  });

  test("N/A rate is about 0.2 where allowed", async () => {
    const api = await setup();
    const version = await api.getChecklistVersion("official-chat", 1);
    const conv = await api.getConversation(P1);
    let na = 0;
    const n = 1000;
    for (let i = 0; i < n; i += 1) {
      const [, c02] = gradeMock({ ...conv, id: `N${i}:x` }, version);
      if (c02.answer === "na") na += 1;
    }
    assert.ok(na / n > 0.15 && na / n < 0.25, `N/A share ${na / n}`);
  });

  test("evidence cites operator lines with their exact text as the quote", async () => {
    const api = await setup();
    await evaluate(api, [P1, P4]);
    for (const id of [P1, P4]) {
      const conv = await api.getConversation(id);
      const ev = await latestEvaluation(api, id);
      for (const r of ev.results) {
        for (const e of r.evidence) {
          const line = conv.transcript[e.message_index];
          assert.ok(line, `${id} ${r.criterion_id}: index ${e.message_index} exists`);
          assert.equal(e.quote, line.text);
          assert.equal(line.speaker, "operator");
        }
        if (r.evidence.some((e) => e.role === "expected_here")) assert.ok(r.checked_range, "expected_here comes with a checked range");
        if (r.checked_range) {
          assert.ok(r.checked_range.from <= r.checked_range.to && r.checked_range.to < conv.transcript.length);
        }
      }
    }
  });

  test("without an operator line, expected_here sits at the last index and checked_range covers everything", async () => {
    const api = make();
    const transcript = [
      { timestamp: "00:00", speaker: "client", text: "Алло?" },
      { timestamp: "00:04", speaker: "bot", text: "Ваш запрос передан." },
      { timestamp: "00:09", speaker: "system", text: "Клиент покинул чат." },
    ];
    const { group_id } = await api.uploadConversations({ conversation_id: "silent", channel: "agent chat", language: "ru", transcript });
    const id = `${group_id}:silent`;
    await evaluate(api, [id]);
    const ev = await latestEvaluation(api, id);
    assertValid("evaluation", ev);
    for (const r of ev.results) {
      assert.deepEqual(r.evidence, [{ message_index: 2, quote: "Клиент покинул чат.", role: "expected_here" }], r.criterion_id);
      assert.deepEqual(r.checked_range, { from: 0, to: 2 });
    }
  });

  test("coaching on no and below-top steps; low confidence sets needs_review; N/A carries its reason", async () => {
    const api = await setup();
    const version = await api.getChecklistVersion("official-chat", 1);
    const conv = await api.getConversation(P1);
    let low = 0;
    let total = 0;
    for (let i = 0; i < 400; i += 1) {
      for (const r of gradeMock({ ...conv, id: `K${i}:x` }, version)) {
        const c = version.criteria.find((x) => x.id === r.criterion_id);
        total += 1;
        assert.equal(r.needs_review, r.confidence === "low");
        if (r.confidence === "low") low += 1;
        const top = c.answer_type === "scale" ? Math.max(...c.scale_steps.map((s) => s.value)) : null;
        const bad =
          c.kind === "gross_error"
            ? r.answer === "yes"
            : r.answer === "no" || (typeof r.answer === "object" && r.answer.step < top);
        if (bad) assert.ok(typeof r.coaching === "string" && r.coaching.length > 0, `${c.id} ${JSON.stringify(r.answer)} needs coaching`);
        else assert.equal(r.coaching, null);
        if (r.answer === "na") assert.ok(typeof r.na_reason === "string" && r.na_reason.length > 0);
        else assert.equal(r.na_reason, null);
        assert.ok(r.explanation.startsWith("Демо-оценка:"));
      }
    }
    assert.ok(low / total > 0.06 && low / total < 0.14, `low-confidence share ${low / total}`);
  });

  test("dry_run counts model_calls and reused without creating a job", async () => {
    const api = await setup();
    const dry = (extra = {}) => api.startEvaluations({ conversations: [P1, P4], ...OFFICIAL, dry_run: true, ...extra });
    const first = await dry();
    assertValid("dry-run", first);
    assert.deepEqual(first, { total: 2, model_calls: 16, reused: 0 }, "two dialogues times eight criteria");
    assert.equal((await api.listEvaluations({})).length, 0, "nothing was created");

    await evaluate(api, [P1]);
    assert.deepEqual(await dry(), { total: 2, model_calls: 8, reused: 8 });
    assert.deepEqual(await dry({ mode: "full" }), { total: 2, model_calls: 16, reused: 0 });
    await evaluate(api, [P4]);
    assert.deepEqual(await dry(), { total: 2, model_calls: 0, reused: 16 });
    assert.equal((await api.listEvaluations({})).length, 2, "dry runs created no evaluations");
    const next = await api.startEvaluations({ conversations: [P1], ...OFFICIAL });
    assert.equal(next.id, "job-0003", "the dry runs did not use up job ids");
  });

  test("a re-run reuses unchanged results; mode full does not", async () => {
    const api = await setup();
    await evaluate(api, [P1]);
    const first = await latestEvaluation(api, P1);
    await evaluate(api, [P1]);
    const second = await latestEvaluation(api, P1);
    assert.notEqual(second.id, first.id);
    assert.ok(second.results.every((r) => r.reused === true));
    assert.deepEqual(second.results.map((r) => r.answer), first.results.map((r) => r.answer));
    assert.equal((await api.listEvaluations({ conversation: P1 })).length, 2);
    assert.equal((await api.listEvaluations({ conversation: P1 }))[0].id, second.id, "newest first");

    await evaluate(api, [P1], OFFICIAL, "full");
    const third = await latestEvaluation(api, P1);
    assert.ok(third.results.every((r) => r.reused === false));
    assert.deepEqual(third.results.map((r) => r.answer), first.results.map((r) => r.answer), "same seed, same answers");
  });

  test("jobs advance one item per mockDelayMs", async () => {
    let t = 1_000_000;
    const api = await setup({ mockDelayMs: 1000, now: () => t });
    const started = await api.startEvaluations({ conversations: [P1, P4], ...OFFICIAL });
    assertValid("job", started);
    assert.equal(started.status, "running");
    assert.deepEqual(started.items.map((i) => i.status), ["running", "queued"]);
    assert.equal(started.done, 0);

    t += 999;
    assert.equal((await api.getJob(started.id)).done, 0);
    t += 1;
    let job = await api.getJob(started.id);
    assert.deepEqual([job.done, job.status], [1, "running"]);
    assert.deepEqual(job.items.map((i) => i.status), ["done", "running"]);
    assert.ok(job.items[0].evaluation_id && job.items[1].evaluation_id === null);
    assert.equal((await api.listEvaluations({})).length, 1);

    t += 5000;
    job = await api.getJob(started.id);
    assert.deepEqual([job.done, job.status], [2, "done"]);
    assertValid("job", job);
  });

  test("an empty dialogue fails its item; retry re-queues failed items", async () => {
    const api = make();
    const rec = { channel: "agent chat", language: "ru" };
    const { group_id } = await api.uploadConversations([
      { ...rec, conversation_id: "ok", transcript: [{ timestamp: "00:00", speaker: "operator", text: "Здравствуйте" }] },
      { ...rec, conversation_id: "empty", transcript: [] },
    ]);
    const job = await evaluate(api, [`${group_id}:ok`, `${group_id}:empty`]);
    assertValid("job", job);
    assert.deepEqual([job.total, job.done, job.failed], [2, 1, 1]);
    const failed = job.items.find((i) => i.status === "failed");
    assert.equal(failed.conversation, `${group_id}:empty`);
    assert.ok(failed.error && failed.evaluation_id === null);
    const retried = await api.retryJob(job.id);
    assertValid("job", retried);
    assert.deepEqual([retried.done, retried.failed], [1, 1], "the empty dialogue fails again");
    await rejects(api.retryJob("job-9999"), "not_found");
    const noKey = make({ mockModelKey: false });
    await rejects(noKey.retryJob("job-0001"), "not_found");
  });

  test("conversation info is filled by the mock on first evaluation when it was unknown", async () => {
    const api = make();
    const { group_id } = await api.uploadConversations({ conversation_id: "i-1", channel: "agent chat", language: "ru",
      transcript: [{ timestamp: "00:00", speaker: "client", text: "Хочу закрыть счёт" }, { timestamp: "00:09", speaker: "operator", text: "Конечно" }] });
    const id = `${group_id}:i-1`;
    assert.equal((await api.getConversation(id)).info, null);
    await evaluate(api, [id]);
    const info = (await api.getConversation(id)).info;
    assertValid("conversation", await api.getConversation(id));
    assert.equal(info.topic, "Хочу закрыть счёт");
  });
});

describe("appeals", () => {
  async function evaluated() {
    const api = await setup({ mockModelKey: true });
    await evaluate(api, [P1]);
    return { api, ev: await latestEvaluation(api, P1) };
  }
  const flip = (answer) => (answer === "yes" ? "no" : "yes");

  test("appeal -> decide changed -> final_total recomputed, original_total unchanged", async () => {
    const { api, ev } = await evaluated();
    const before = ev.results.find((r) => r.criterion_id === "c05");
    const appeal = await api.fileAppeal({ evaluation_id: ev.id, criterion_id: "c05", comment: "Не согласен" });
    assertValid("appeal", appeal);
    assert.equal(appeal.status, "open");
    assert.equal(appeal.role, "controller");
    assert.equal((await api.getConversation(P1)).status, "disputed");
    assert.equal((await api.listConversations({ status: "disputed" })).length, 1);
    assert.equal((await api.listConversations({ group_id: "A" })).find((c) => c.id === P1).final.open_appeals, 1);

    roleBox.current = "reviewer";
    const answer = flip(before.answer);
    const after = await api.decideAppeal(appeal.id, { outcome: "changed", answer, reason: "Оператор вежлив" });
    roleBox.current = "controller";
    assertValid("evaluation", after);
    assert.equal(after.id, ev.id, "the recalculated final result of the evaluation comes back");
    assert.equal(after.original_total, ev.original_total);
    assert.notEqual(after.final_total, ev.final_total);
    assert.equal(after.final_total, score(await api.getChecklistVersion("official-chat", 1),
      Object.fromEntries(after.results.map((r) => [r.criterion_id, { answer: r.final_answer, kinds: r.kinds }]))).total);
    const row = after.results.find((r) => r.criterion_id === "c05");
    assert.equal(row.answer, before.answer, "the model's answer stays");
    assert.equal(row.final_answer, answer);
    assert.equal(row.carried_decision, null);

    const decided = await api.getAppeal(appeal.id);
    assertValid("appeal", decided);
    assert.equal(decided.status, "decided");
    assert.equal(decided.decision.outcome, "changed");
    assert.equal(decided.decision.role, "reviewer");
    assert.equal(decided.decision.answer, answer);
    assert.ok(decided.decision.decided_at);
    assert.equal((await api.getConversation(P1)).status, "evaluated");
    const final = (await api.listConversations({ group_id: "A" })).find((c) => c.id === P1).final;
    assert.equal(final.total, after.final_total);
    assert.equal(final.open_appeals, 0);
    assert.equal((await api.getEvaluation(ev.id)).final_total, after.final_total, "stored");
  });

  test("confirmed keeps the model answer; validation of decisions", async () => {
    const { api, ev } = await evaluated();
    const appeal = await api.fileAppeal({ evaluation_id: ev.id, criterion_id: "c01", comment: "Проверьте" });
    await rejects(api.decideAppeal(appeal.id, { outcome: "changed", answer: "na", reason: "x" }), "invalid_answer");
    await rejects(api.decideAppeal(appeal.id, { outcome: "changed", answer: { step: 5 }, reason: "x" }), "invalid_answer");
    await rejects(api.decideAppeal(appeal.id, { outcome: "confirmed", reason: "  " }), "bad_request");
    await rejects(api.decideAppeal(appeal.id, { outcome: "maybe", reason: "x" }), "bad_request");
    await rejects(api.decideAppeal("ap-9999", { outcome: "confirmed", reason: "x" }), "not_found");
    const after = await api.decideAppeal(appeal.id, { outcome: "confirmed", reason: "Оценка верна" });
    assert.equal(after.final_total, ev.final_total);
    assert.equal((await api.getAppeal(appeal.id)).decision.outcome, "confirmed");
    await rejects(api.decideAppeal(appeal.id, { outcome: "confirmed", reason: "ещё раз" }), "appeal_already_decided");
  });

  test("one open appeal per criterion per evaluation; filing validates its input", async () => {
    const { api, ev } = await evaluated();
    const body = { evaluation_id: ev.id, criterion_id: "c06", comment: "Завышено" };
    await api.fileAppeal(body);
    await rejects(api.fileAppeal(body), "appeal_already_open");
    await api.fileAppeal({ ...body, criterion_id: "c07" });
    await rejects(api.fileAppeal({ ...body, comment: "" }), "bad_request");
    await rejects(api.fileAppeal({ ...body, criterion_id: "zz" }), "not_found");
    await rejects(api.fileAppeal({ ...body, evaluation_id: "ev-9999" }), "not_found");
    const open = await api.listAppeals({ status: "open" });
    assert.equal(open.length, 2);
    open.forEach((a) => assertValid("appeal", a));
    assert.equal((await api.listAppeals({ status: "decided" })).length, 0);
    assert.equal((await api.listAppeals({})).length, 2);
  });

  test("a decided appeal frees the criterion for a new one", async () => {
    const { api, ev } = await evaluated();
    const body = { evaluation_id: ev.id, criterion_id: "c05", comment: "a" };
    const first = await api.fileAppeal(body);
    await api.decideAppeal(first.id, { outcome: "confirmed", reason: "ok" });
    const second = await api.fileAppeal({ ...body, comment: "b" });
    assert.notEqual(second.id, first.id);
  });

  test("with a model key the second opinion is pending, then done after mockDelayMs", async () => {
    let t = 5000;
    const api = await setup({ mockDelayMs: 1000, now: () => t, mockModelKey: true });
    const job = await api.startEvaluations({ conversations: [P1], ...OFFICIAL });
    t += 10_000;
    assert.equal((await api.getJob(job.id)).status, "done");
    const ev = await latestEvaluation(api, P1);
    const filed = await api.fileAppeal({ evaluation_id: ev.id, criterion_id: "c05", comment: "x" });
    assert.equal(filed.second_opinion_status, "pending");
    assert.equal(filed.second_opinion, null);
    t += 999;
    assert.equal((await api.getAppeal(filed.id)).second_opinion_status, "pending");
    t += 1;
    const done = await api.getAppeal(filed.id);
    assertValid("appeal", done);
    assert.equal(done.second_opinion_status, "done");
    assert.ok(done.second_opinion.reasoning.startsWith("Демо-второе мнение:"));
    const criterion = (await api.getChecklistVersion("official-chat", 1)).criteria.find((c) => c.id === "c05");
    assert.equal(validateAnswer(criterion, done.second_opinion.answer), null);
  });

  test("mockDelayMs 0: pending when filed, done on the next read", async () => {
    const { api, ev } = await evaluated();
    const filed = await api.fileAppeal({ evaluation_id: ev.id, criterion_id: "c05", comment: "x" });
    assert.equal(filed.second_opinion_status, "pending");
    assert.equal((await api.getAppeal(filed.id)).second_opinion_status, "done");
  });

  test("mockModelKey false: startEvaluations rejects model_key_missing; fileAppeal still works, second opinion unavailable", async () => {
    const storage = memoryStorage();
    const keyed = make({ storage, mockModelKey: true });
    await keyed.importDataset("A");
    await evaluate(keyed, [P1]);

    const api = make({ storage, mockModelKey: false });
    assert.equal((await api.getConfig()).model_key_configured, false);
    const err = await api.startEvaluations({ conversations: [P4], ...OFFICIAL }).catch((e) => e);
    assert.ok(err instanceof ApiError);
    assert.equal(err.code, "model_key_missing");
    assert.equal(err.status, 409);
    assert.equal(err.retryable, false);
    assertValid("error", { error: err.code, message: err.message });
    await rejects(api.startEvaluations({ conversations: [P1], ...OFFICIAL, mode: "full" }), "model_key_missing");
    // a dry run is only an estimate; a batch that needs no model call is allowed
    assert.deepEqual(await api.startEvaluations({ conversations: [P4], ...OFFICIAL, dry_run: true }), { total: 1, model_calls: 8, reused: 0 });
    const reuse = await api.startEvaluations({ conversations: [P1], ...OFFICIAL });
    assert.equal(reuse.mode, "reuse");

    const ev = await latestEvaluation(api, P1);
    const filed = await api.fileAppeal({ evaluation_id: ev.id, criterion_id: "c05", comment: "x" });
    assert.equal(filed.second_opinion_status, "unavailable");
    assert.equal((await api.getAppeal(filed.id)).second_opinion_status, "unavailable");
    assert.equal((await api.getAppeal(filed.id)).second_opinion, null);
    assertValid("appeal", await api.getAppeal(filed.id));
    assert.equal((await api.getConfig()).model_key_configured, false);
  });
});

describe("carried decisions", () => {
  // Evaluates P1, appeals c05 and changes it. Returns the first evaluation and the decided appeal.
  async function decided(api) {
    await evaluate(api, [P1]);
    const ev = await latestEvaluation(api, P1);
    const appeal = await api.fileAppeal({ evaluation_id: ev.id, criterion_id: "c05", comment: "x" });
    roleBox.current = "reviewer";
    const answer = ev.results.find((r) => r.criterion_id === "c05").answer === "yes" ? "no" : "yes";
    await api.decideAppeal(appeal.id, { outcome: "changed", answer, reason: "потому что" });
    roleBox.current = "controller";
    return { ev: await api.getEvaluation(ev.id), appeal: await api.getAppeal(appeal.id) };
  }

  test("re-run with unchanged criteria reuses results and carries the decision", async () => {
    const api = await setup();
    const { ev, appeal } = await decided(api);
    await evaluate(api, [P1]);
    const again = await latestEvaluation(api, P1);
    assertValid("evaluation", again);
    assert.notEqual(again.id, ev.id);
    assert.ok(again.results.every((r) => r.reused));
    const c05 = again.results.find((r) => r.criterion_id === "c05");
    assert.deepEqual(c05.carried_decision, { appeal_id: appeal.id, evaluation_id: ev.id });
    assert.deepEqual(c05.final_answer, appeal.decision.answer);
    assert.notDeepEqual(c05.final_answer, c05.answer);
    assert.ok(again.results.filter((r) => r.criterion_id !== "c05").every((r) => r.carried_decision === null));
    assert.equal(again.original_total, ev.original_total);
    assert.equal(again.final_total, ev.final_total, "same decision, same final total");
    assert.notEqual(again.final_total, again.original_total);
    // points follow the final answer
    assert.deepEqual(again.results.map((r) => r.points), ev.results.map((r) => r.points));
  });

  test("mode full still carries the decision but does not reuse results", async () => {
    const api = await setup();
    const { appeal } = await decided(api);
    await evaluate(api, [P1], OFFICIAL, "full");
    const again = await latestEvaluation(api, P1);
    assert.ok(again.results.every((r) => r.reused === false));
    assert.equal(again.results.find((r) => r.criterion_id === "c05").carried_decision.appeal_id, appeal.id);
  });

  test("another checklist with the same criteria carries; changed wording does not; weight only does", async () => {
    const api = await setup();
    const { ev, appeal } = await decided(api);
    const copy = await api.createChecklist({ based_on: OFFICIAL, name: "Копия" });
    assertValid("checklist-version", copy);
    assert.equal(copy.version, 1);
    assert.equal(copy.locked, false);
    assert.deepEqual(copy.based_on, OFFICIAL);
    assert.notEqual(copy.checklist_id, "official-chat");
    const ref = { checklist_id: copy.checklist_id, version: 1 };

    await evaluate(api, [P1], ref);
    const onCopy = await latestEvaluation(api, P1, ref);
    assert.ok(onCopy.results.every((r) => r.reused), "same fingerprints and transcript: all reused");
    assert.equal(onCopy.results.find((r) => r.criterion_id === "c05").carried_decision.appeal_id, appeal.id);
    assert.equal(onCopy.final_total, ev.final_total);

    // weight only: same fingerprint, so still carried
    const weightOnly = await api.saveChecklistVersion(copy.checklist_id, {
      criteria: copy.criteria.map((c) => (c.id === "c05" ? { ...c, weight: 30 } : c)),
    });
    assert.equal(weightOnly.version, 2);
    assert.deepEqual(
      await api.startEvaluations({ conversations: [P1], checklist_id: copy.checklist_id, version: 2, dry_run: true }),
      { total: 1, model_calls: 0, reused: 8 },
      "a weight-only change needs no model call",
    );
    await evaluate(api, [P1], { checklist_id: copy.checklist_id, version: 2 });
    const w = await latestEvaluation(api, P1, { checklist_id: copy.checklist_id, version: 2 });
    assert.ok(w.results.every((r) => r.reused));
    assert.ok(w.results.find((r) => r.criterion_id === "c05").carried_decision);
    assert.notEqual(w.original_total, ev.original_total, "the weight changed the totals");

    // wording: new fingerprint, no reuse, no carry
    const reworded = await api.saveChecklistVersion(copy.checklist_id, {
      criteria: weightOnly.criteria.map((c) => (c.id === "c05" ? { ...c, wording: "Да — оператор вежлив и внимателен." } : c)),
    });
    assert.equal(reworded.version, 3);
    assert.notEqual(reworded.criteria.find((c) => c.id === "c05").fingerprint, copy.criteria.find((c) => c.id === "c05").fingerprint);
    const dry = await api.startEvaluations({ conversations: [P1], checklist_id: copy.checklist_id, version: 3, dry_run: true });
    assert.deepEqual(dry, { total: 1, model_calls: 1, reused: 7 }, "only the reworded criterion needs a model call");
    await evaluate(api, [P1], { checklist_id: copy.checklist_id, version: 3 });
    const r = await latestEvaluation(api, P1, { checklist_id: copy.checklist_id, version: 3 });
    const c05 = r.results.find((x) => x.criterion_id === "c05");
    assert.equal(c05.reused, false);
    assert.equal(c05.carried_decision, null);
    assert.deepEqual(c05.final_answer, c05.answer);
    assert.ok(r.results.filter((x) => x.criterion_id !== "c05").every((x) => x.reused));
  });

  test("a changed transcript: no reuse and no carry", async () => {
    let text = "Здравствуйте! Меня зовут Айгерим";
    const fetchImpl = async () =>
      new Response(JSON.stringify([{ conversation_id: "d-1", channel: "agent chat", language: "ru",
        transcript: [{ timestamp: "00:00", speaker: "client", text: "Привет" }, { timestamp: "00:09", speaker: "operator", text }] }]));
    const api = make({ devDataUrl: "x.json", fetchImpl });
    await api.importDataset("DEV");
    await evaluate(api, ["DEV:d-1"]);
    const ev = await latestEvaluation(api, "DEV:d-1");
    const appeal = await api.fileAppeal({ evaluation_id: ev.id, criterion_id: "c05", comment: "x" });
    await api.decideAppeal(appeal.id, { outcome: "confirmed", reason: "ok" });

    await evaluate(api, ["DEV:d-1"]);
    assert.ok((await latestEvaluation(api, "DEV:d-1")).results.every((r) => r.reused), "unchanged transcript reuses");

    text = "Добрый день! Чем могу помочь?";
    assert.equal((await api.importDataset("DEV")).updated, 1);
    assert.deepEqual(await api.startEvaluations({ conversations: ["DEV:d-1"], ...OFFICIAL, dry_run: true }), { total: 1, model_calls: 8, reused: 0 });
    await evaluate(api, ["DEV:d-1"]);
    const fresh = await latestEvaluation(api, "DEV:d-1");
    assert.ok(fresh.results.every((r) => r.reused === false && r.carried_decision === null));
  });

  test("the decision of a later appeal wins over the earlier one", async () => {
    const api = await setup();
    const { ev } = await decided(api);
    await evaluate(api, [P1]);
    const second = await latestEvaluation(api, P1);
    const next = await api.fileAppeal({ evaluation_id: second.id, criterion_id: "c05", comment: "ещё раз" });
    roleBox.current = "reviewer";
    await api.decideAppeal(next.id, { outcome: "confirmed", reason: "вернём" });
    roleBox.current = "controller";
    await evaluate(api, [P1]);
    const third = await latestEvaluation(api, P1);
    const c05 = third.results.find((r) => r.criterion_id === "c05");
    assert.equal(c05.carried_decision.appeal_id, next.id);
    assert.notEqual(c05.carried_decision.evaluation_id, ev.id);
    assert.deepEqual(c05.final_answer, c05.answer, "the later decision confirmed the model answer");
  });
});

describe("checklists", () => {
  test("the seed is the locked official checklist with fingerprints", async () => {
    const api = make();
    const list = await api.listChecklists();
    assert.equal(list.length, 1);
    assertValid("checklist-version", list[0]);
    assert.equal(list[0].checklist_id, "official-chat");
    assert.equal(list[0].locked, true);
    assert.equal(list[0].based_on, null);
    assert.deepEqual(list[0].versions.map((v) => v.version), [1]);
    const v1 = await api.getChecklistVersion("official-chat", 1);
    assertValid("checklist-version", v1);
    assert.equal(v1.criteria.length, seed.criteria.length);
    assert.equal(v1.guidance, seed.guidance);
    for (const [i, c] of v1.criteria.entries()) {
      assert.equal(c.fingerprint, await fingerprint(seed.criteria[i]), "computed from the seed as it is");
      assert.equal(c.guidance, seed.criteria[i].guidance);
    }
    assert.deepEqual((await api.getConfig()).default_checklist, OFFICIAL);
    await rejects(api.getChecklistVersion("official-chat", 2), "not_found");
    await rejects(api.getChecklistVersion("nope", 1), "not_found");
  });

  test("locked checklist rejects a new version; copy with based_on works", async () => {
    const api = make();
    const err = await api.saveChecklistVersion("official-chat", { name: "Новое имя" }).catch((e) => e);
    assert.ok(err instanceof ApiError);
    assert.equal(err.code, "locked");
    assert.equal(err.status, 409);
    assertValid("error", { error: err.code, message: err.message });

    roleBox.current = "reviewer";
    const copy = await api.createChecklist({ based_on: OFFICIAL, name: "Мой чек-лист", description: "Копия" });
    roleBox.current = "controller";
    assertValid("checklist-version", copy);
    assert.equal(copy.name, "Мой чек-лист");
    assert.equal(copy.author_role, "reviewer");
    assert.equal(copy.locked, false);
    assert.equal(copy.criteria.length, 8);
    assert.deepEqual(copy.criteria.map((c) => c.fingerprint), (await api.getChecklistVersion("official-chat", 1)).criteria.map((c) => c.fingerprint));
    assert.equal((await api.listChecklists()).length, 2);

    const v2 = await api.saveChecklistVersion(copy.checklist_id, { name: "Мой чек-лист 2" });
    assertValid("checklist-version", v2);
    assert.equal(v2.version, 2);
    assert.equal(v2.name, "Мой чек-лист 2");
    assert.deepEqual(v2.based_on, OFFICIAL, "based_on is kept on a new version");
    assert.equal((await api.getChecklistVersion(copy.checklist_id, 1)).name, "Мой чек-лист", "versions are immutable");
    const listed = (await api.listChecklists()).find((c) => c.checklist_id === copy.checklist_id);
    assert.equal(listed.version, 2);
    assert.deepEqual(listed.versions.map((v) => v.version), [1, 2]);
    await rejects(api.saveChecklistVersion("nope", {}), "not_found");
    await rejects(api.createChecklist({ based_on: { checklist_id: "nope", version: 1 }, name: "x" }), "not_found");
  });

  test("createChecklist from scratch assigns criterion ids and fingerprints; bad input is rejected", async () => {
    const api = make();
    const created = await api.createChecklist({
      name: "Звонки",
      channel: "call",
      sections: [{ id: "s1", title: "Начало", order: 1 }],
      criteria: [
        { section_id: "s1", order: 1, title: "Приветствие", wording: "Да — поздоровался.", answer_type: "yes_no", weight: 50, na_allowed: false },
        { section_id: "s1", order: 2, title: "Тон", wording: "Оцените тон.", answer_type: "scale", weight: 60, na_allowed: true, na_condition: "N/A — разговор оборвался.",
          scale_steps: [{ value: 0, label: "плохо" }, { value: 5, label: "хорошо" }] },
      ],
    });
    assertValid("checklist-version", created);
    assert.equal(created.based_on, null);
    assert.equal(new Set(created.criteria.map((c) => c.id)).size, 2);
    assert.ok(created.criteria.every((c) => c.id && c.fingerprint && c.kind === "scored" && Array.isArray(c.kinds)));
    assert.ok(created.criteria.every((c) => c.guidance === null), "criterion guidance is null when none");
    const blank = await api.createChecklist({ name: "Пустое пояснение", sections: created.sections,
      criteria: created.criteria.map((c) => ({ ...c, guidance: "" })) });
    assert.ok(blank.criteria.every((c) => c.guidance === null), "an empty guidance becomes null");
    assert.deepEqual(blank.criteria.map((c) => c.fingerprint), created.criteria.map((c) => c.fingerprint), "null and empty are the same criterion");
    assert.equal(created.guidance, "", "the checklist's own guidance stays a string");
    await rejects(api.createChecklist({ name: "Пусто", sections: [], criteria: [] }), "invalid_checklist");
    await rejects(api.createChecklist({ sections: created.sections, criteria: created.criteria }), "invalid_checklist");
    await rejects(api.createChecklist({ name: "x", sections: created.sections,
      criteria: [{ ...created.criteria[0], section_id: "ghost" }] }), "invalid_checklist");
    await rejects(api.createChecklist({ name: "x", sections: created.sections,
      criteria: [{ ...created.criteria[1], scale_steps: [{ value: 1, label: "один" }] }] }), "invalid_checklist");
  });
});

describe("isolation, faults and storage", () => {
  test("same conversation_id in groups A and B -> two items, evaluations never cross", async () => {
    const api = make();
    await api.importDataset("A");
    await api.importDataset("B");
    const queue = await api.listConversations({});
    assert.equal(queue.length, 4);
    assert.deepEqual(queue.map((c) => c.id).sort(), ["A:p1-ru-001", "A:p4-ru-001", "B:p1-ru-001", "B:p4-ru-001"]);
    assert.equal(new Set(queue.map((c) => c.conversation_id)).size, 2);

    await evaluate(api, ["A:p1-ru-001"]);
    assert.equal((await api.listEvaluations({ conversation: "B:p1-ru-001" })).length, 0);
    assert.equal((await api.listEvaluations({ conversation: "A:p1-ru-001" })).length, 1);
    const byId = Object.fromEntries((await api.listConversations({})).map((c) => [c.id, c]));
    assert.ok(byId["A:p1-ru-001"].final);
    assert.equal(byId["B:p1-ru-001"].final, null);
    assert.equal(byId["B:p1-ru-001"].status, "new");
    // equal content in another group is not reused
    assert.deepEqual(await api.startEvaluations({ conversations: ["B:p1-ru-001"], ...OFFICIAL, dry_run: true }), { total: 1, model_calls: 8, reused: 0 });

    await evaluate(api, ["B:p1-ru-001"]);
    const evA = (await api.listEvaluations({ conversation: "A:p1-ru-001" }))[0];
    const evB = (await api.listEvaluations({ conversation: "B:p1-ru-001" }))[0];
    assert.notEqual(evA.id, evB.id);
    assert.equal(evA.conversation, "A:p1-ru-001");
    assert.equal(evB.conversation, "B:p1-ru-001");
    assert.ok(evB.results.every((r) => r.reused === false));

    // an appeal and its decision on A stay on A
    const appeal = await api.fileAppeal({ evaluation_id: evA.id, criterion_id: "c05", comment: "x" });
    assert.equal(appeal.conversation, "A:p1-ru-001");
    assert.equal((await api.getConversation("B:p1-ru-001")).status, "evaluated");
    assert.equal((await api.getConversation("A:p1-ru-001")).status, "disputed");
    assert.equal((await api.listConversations({ group_id: "B" })).filter((c) => c.status === "disputed").length, 0);
  });

  test("mockFault makes the named method reject with that code", async () => {
    const api = await setup({ mockFault: { startEvaluations: "network", getConfig: "model_key_missing", getAnalytics: "not_found" } });
    const net = await api.startEvaluations({ conversations: [P1], ...OFFICIAL }).catch((e) => e);
    assert.ok(net instanceof ApiError);
    assert.equal(net.code, "network");
    assert.equal(net.retryable, true);
    await rejects(api.getConfig(), "model_key_missing");
    await rejects(api.getAnalytics(), "not_found");
    assert.equal((await api.listConversations({})).length, 2, "other methods are unaffected");
    assert.equal((await api.listEvaluations({})).length, 0, "a faulted method does nothing");
  });

  test("storage that throws -> still works in memory", async () => {
    const boom = () => { throw new Error("storage disabled"); };
    const api = make({ storage: { getItem: boom, setItem: boom, removeItem: boom } });
    await api.importDataset("A");
    await evaluate(api, [P1]);
    const ev = await latestEvaluation(api, P1);
    assertValid("evaluation", ev);
    const appeal = await api.fileAppeal({ evaluation_id: ev.id, criterion_id: "c05", comment: "x" });
    assert.equal((await api.getAppeal(appeal.id)).status, "open");
    assert.equal((await api.createChecklist({ based_on: OFFICIAL, name: "Копия" })).version, 1);
  });

  test("storage: null runs in memory; the default is localStorage when it works and memory when it throws", async () => {
    const memory = createMockApi({ mockDelayMs: 0, role: () => "controller", storage: null });
    assert.equal((await memory.importDataset("A")).total, 2);

    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const fake = memoryStorage();
    try {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => fake });
      const working = createMockApi({ mockDelayMs: 0, role: () => "controller" });
      await working.importDataset("A");
      assert.ok(fake.map.has("cqa-mock-v1"), "written to localStorage");
      assert.equal(fake.map.has("cqa-mock-v1-probe"), false, "the probe key is removed again");

      Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("SecurityError"); } });
      const blocked = createMockApi({ mockDelayMs: 0, role: () => "controller" });
      assert.equal((await blocked.importDataset("A")).total, 2);
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete globalThis.localStorage;
    }
  });

  test("state persists in storage under cqa-mock-v1 and survives a new instance", async () => {
    const storage = memoryStorage();
    const one = make({ storage });
    await one.importDataset("A");
    await evaluate(one, [P1]);
    const ev = await latestEvaluation(one, P1);
    const appeal = await one.fileAppeal({ evaluation_id: ev.id, criterion_id: "c05", comment: "x" });
    const copy = await one.createChecklist({ based_on: OFFICIAL, name: "Копия" });
    await one.getTranslation(P1, "ru");
    assert.ok(storage.map.has("cqa-mock-v1"));

    const two = make({ storage });
    assert.equal((await two.listConversations({ group_id: "A" })).length, 2);
    assert.equal((await latestEvaluation(two, P1)).id, ev.id);
    assert.equal((await two.getAppeal(appeal.id)).status, "open");
    assert.equal((await two.listChecklists()).length, 2);
    assert.equal((await two.getChecklistVersion(copy.checklist_id, 1)).name, "Копия");
    // ids continue where they left off
    const job = await two.startEvaluations({ conversations: [P4], ...OFFICIAL });
    assert.equal(job.id, "job-0002");
    // decisions made in the second instance reach the first one's storage
    await two.decideAppeal(appeal.id, { outcome: "confirmed", reason: "ok" });
    assert.equal((await make({ storage }).getAppeal(appeal.id)).status, "decided");
  });

  test("dev conversations are not written to storage; evaluations of them survive", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify([{ conversation_id: "d-1", channel: "agent chat", language: "ru",
        transcript: [{ timestamp: "00:00", speaker: "client", text: "SECRETTEXT" }, { timestamp: "00:09", speaker: "operator", text: "ok" }] }]));
    const storage = memoryStorage();
    const one = make({ storage, devDataUrl: "x.json", fetchImpl });
    await one.importDataset("DEV");
    await evaluate(one, ["DEV:d-1"]);
    assert.ok(!storage.map.get("cqa-mock-v1").includes("SECRETTEXT"));
    const two = make({ storage, devDataUrl: "x.json", fetchImpl });
    assert.equal((await two.listEvaluations({ conversation: "DEV:d-1" })).length, 1);
    assert.equal((await two.listConversations({})).length, 0, "not loaded until imported");
    assert.equal((await two.getConversation("DEV:d-1")).id, "DEV:d-1", "getConversation imports the group");
  });

  test("corrupt or foreign data in storage is ignored", async () => {
    for (const bad of ["{oops", "[]", '{"schema":99}', "null", '"x"']) {
      const storage = memoryStorage();
      storage.setItem("cqa-mock-v1", bad);
      const api = make({ storage });
      assert.equal((await api.listChecklists()).length, 1);
      assert.equal((await api.importDataset("A")).total, 2);
    }
  });

  test("responses are copies: changing one does not change the mock's state", async () => {
    const api = await setup();
    const conv = await api.getConversation(P1);
    conv.transcript.length = 0;
    conv.channel = "voice call";
    assert.ok((await api.getConversation(P1)).transcript.length > 0);
    assert.equal((await api.getConversation(P1)).channel, "agent chat");
    const version = await api.getChecklistVersion("official-chat", 1);
    version.criteria.length = 0;
    assert.equal((await api.getChecklistVersion("official-chat", 1)).criteria.length, 8);
  });

  test("createApi({api: 'mock'}) builds the mock", async () => {
    const api = createApi({ api: "mock", mockDelayMs: 0, storage: memoryStorage(), role: () => "reviewer" });
    assert.equal((await api.getConfig()).default_checklist.checklist_id, "official-chat");
    assert.throws(() => createApi({ api: "ftp" }), /ftp/);
  });

  test("a bad role() value throws like the HTTP adapter", async () => {
    const api = make({ role: () => "boss" });
    await api.importDataset("A");
    await assert.rejects(api.createChecklist({ based_on: OFFICIAL, name: "x" }), TypeError);
  });
});

describe("other endpoints", () => {
  test("translation prefixes each text with «[демо-перевод] » and is stored", async () => {
    const api = await setup();
    const conv = await api.getConversation(P1);
    const tr = await api.getTranslation(P1, "ru");
    assertValid("translation", tr);
    assert.equal(tr.conversation, P1);
    assert.equal(tr.to, "ru");
    assert.equal(tr.messages.length, conv.transcript.length);
    tr.messages.forEach((m, i) => {
      assert.equal(m.message_index, i);
      assert.equal(m.text, `[демо-перевод] ${conv.transcript[i].text}`);
    });
    assert.deepEqual(await api.getTranslation(P1, "ru"), tr);
    assert.equal((await api.getTranslation(P1, "en")).to, "en");
    await rejects(api.getTranslation("A:nope", "ru"), "not_found");
  });

  test("config reflects the model key and the default checklist", async () => {
    const cfg = await make().getConfig();
    assertValid("config", cfg);
    assert.equal(cfg.model_key_configured, true);
    assert.deepEqual(cfg.default_checklist, OFFICIAL);
    assert.equal((await make({ mockModelKey: false }).getConfig()).model_key_configured, false);
  });

  test("comparison uses final totals on both sides", async () => {
    const api = await setup();
    await evaluate(api, [P1, P4]);
    const copy = await api.createChecklist({ based_on: OFFICIAL, name: "Копия" });
    const v2 = await api.saveChecklistVersion(copy.checklist_id, {
      criteria: copy.criteria.map((c) => (c.id === "c01" ? { ...c, weight: 40 } : c)),
    });
    await evaluate(api, [P1, P4], { checklist_id: copy.checklist_id, version: v2.version });

    // a decision on the official evaluation moves its final total, so the comparison must see it
    const ev = await latestEvaluation(api, P1);
    const appeal = await api.fileAppeal({ evaluation_id: ev.id, criterion_id: "c01", comment: "x" });
    const answer = ev.results.find((r) => r.criterion_id === "c01").answer === "yes" ? "no" : "yes";
    roleBox.current = "reviewer";
    const decided = await api.decideAppeal(appeal.id, { outcome: "changed", answer, reason: "r" });
    roleBox.current = "controller";

    const cmp = await api.getComparison({ from_checklist: "official-chat", from_version: 1, to_checklist: copy.checklist_id, to_version: v2.version, group_id: "A" });
    assertValid("comparison", cmp);
    assert.equal(cmp.from.name, "Чек-лист качества чатов");
    assert.equal(cmp.to.name, "Копия");
    assert.equal(cmp.rows.length, 2);
    const row = cmp.rows.find((r) => r.conversation === P1);
    assert.equal(row.conversation_id, "p1-ru-001");
    assert.equal(row.group_id, "A");
    assert.equal(row.old_total, decided.final_total);
    const newEv = await latestEvaluation(api, P1, { checklist_id: copy.checklist_id });
    assert.equal(row.new_total, newEv.final_total);
    assert.equal(row.delta, Math.round((row.new_total - row.old_total) * 100) / 100);
    assert.equal(cmp.summary.total, 2);
    assert.ok(cmp.summary.changed >= 1);
    const only = await api.getComparison({ from_checklist: "official-chat", from_version: "1", to_checklist: copy.checklist_id, to_version: String(v2.version), conversations: [P4] });
    assert.deepEqual(only.rows.map((r) => r.conversation), [P4]);
    await rejects(api.getComparison({ from_checklist: "official-chat", from_version: 1, to_checklist: "nope", to_version: 1 }), "not_found");
    await rejects(api.getComparison({}), "bad_request");
  });

  test("accuracy compares with a second seeded grader and says the reference is not loaded", async () => {
    const api = await setup();
    const empty = await api.getAccuracy();
    assertValid("accuracy", empty);
    assert.equal(empty.reference_note, "Демо: эталон не загружен");
    assert.equal(empty.overall.n, 0);
    assert.equal(empty.missing, 16, "two conversations, eight criteria each, none graded");

    await evaluate(api, [P1, P4]);
    const rep = await api.getAccuracy();
    assertValid("accuracy", rep);
    assert.equal(rep.reference_note, "Демо: эталон не загружен");
    assert.equal(rep.model, "mock");
    assert.equal(rep.overall.n, 16);
    assert.equal(rep.missing, 0);
    assert.equal(rep.disputed_excluded, 0);
    assert.equal(rep.disagreements.length, Math.round(rep.overall.n * (1 - rep.overall.agreement)));
    assert.deepEqual(rep.by_channel.map((c) => c.channel).sort(), ["agent chat", "voice call"]);
    assert.deepEqual(rep.by_language.map((c) => c.language), ["RU"]);
    for (const d of rep.disagreements) assert.notDeepEqual(d.reference, d.evaluated);

    const ev = await latestEvaluation(api, P1);
    await api.fileAppeal({ evaluation_id: ev.id, criterion_id: "c01", comment: "x" });
    const after = await api.getAccuracy();
    assert.equal(after.disputed_excluded, 1);
    assert.equal(after.overall.n, 15);
  });

  test("analytics use final totals, per criterion, language, channel and gross errors", async () => {
    const api = await setup();
    assertValid("analytics", await api.getAnalytics());
    await evaluate(api, [P1, P4]);
    const an = await api.getAnalytics();
    assertValid("analytics", an);
    assert.ok(an.by_criterion.every((c) => c.n === 2 && c.fail_rate >= 0 && c.fail_rate <= 1));
    assert.ok(!an.by_criterion.some((c) => c.criterion_id === "c08"), "the gross-error flag is reported separately");
    const evs = [await latestEvaluation(api, P1), await latestEvaluation(api, P4)];
    const totals = evs.map((e) => e.final_total).filter((t) => t !== null);
    const lang = an.by_language.find((l) => l.language === "RU");
    assert.equal(lang.n, 2);
    assert.equal(lang.avg_total, Math.round((totals.reduce((a, b) => a + b, 0) / totals.length) * 100) / 100);
    assert.equal(an.gross_errors.count, evs.filter((e) => e.gross_error.flag).length);
    assert.deepEqual(an.gross_errors.conversations.sort(), evs.filter((e) => e.gross_error.flag).map((e) => e.conversation).sort());
  });

  test("exportCsvUrl returns a URL of csv.js output with a BOM, `;` and one row per dialogue", async () => {
    const api = await setup();
    await evaluate(api, [P1]);
    const url = api.exportCsvUrl("A");
    assert.equal(typeof url, "string");
    assert.match(url, /^blob:/);
    const bytes = Buffer.from(await resolveObjectURL(url).arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM");
    const text = bytes.toString("utf8");
    assert.equal(text.charCodeAt(0), 0xfeff);
    const lines = text.slice(1).split("\r\n").filter(Boolean);
    assert.equal(lines.length, 3, "header and two dialogues");
    assert.ok(lines[0].split(";").length > 8);
    assert.ok(lines[1].startsWith("A;p1-ru-001;"));
    const graded = lines[1].split(";");
    assert.match(text, /\d+,\d\d/, "totals use a decimal comma for Excel in ru-RU");
    assert.ok(graded.length >= lines[0].split(";").length - 2);
    assert.equal(lines[2].split(";")[1], "p4-ru-001");
  });

  test("exportCsvUrl copes with a missing URL.createObjectURL", async () => {
    const saved = URL.createObjectURL;
    try {
      URL.createObjectURL = undefined;
      const api = await setup();
      const url = api.exportCsvUrl("A");
      assert.match(url, /^data:text\/csv/);
    } finally {
      URL.createObjectURL = saved;
    }
  });
});

describe("every mock response validates against its schema", () => {
  test("one call of each method", async () => {
    const api = make({ mockModelKey: true });
    assertValid("config", await api.getConfig());
    assertValid("import-summary", await api.importDataset("A"));
    assertValid("import-summary", await api.uploadConversations({ conversation_id: "u", channel: "voice call", language: "kz",
      transcript: [{ timestamp: "2026-11-02T10:15:03+05:00", speaker: "operator", text: "Алло" }, { timestamp: "2026-11-02T10:15:09+05:00", speaker: "client", text: "Сәлем" }] }));
    for (const item of await api.listConversations({})) assertValid("queue-item", item);
    for (const id of [P1, P4]) assertValid("conversation", await api.getConversation(id));
    assertValid("translation", await api.getTranslation(P1, "ru"));
    for (const c of await api.listChecklists()) assertValid("checklist-version", c);
    assertValid("checklist-version", await api.getChecklistVersion("official-chat", 1));
    const copy = await api.createChecklist({ based_on: OFFICIAL, name: "Копия" });
    assertValid("checklist-version", copy);
    assertValid("checklist-version", await api.saveChecklistVersion(copy.checklist_id, { description: "d" }));
    assertValid("dry-run", await api.startEvaluations({ conversations: [P1, P4], ...OFFICIAL, dry_run: true }));
    const job = await api.startEvaluations({ conversations: [P1, P4], ...OFFICIAL });
    assertValid("job", job);
    assertValid("job", await api.getJob(job.id));
    assertValid("job", await api.retryJob(job.id));
    const evs = await api.listEvaluations({ conversation: P1 });
    evs.forEach((e) => assertValid("evaluation", e));
    assertValid("evaluation", await api.getEvaluation(evs[0].id));
    const appeal = await api.fileAppeal({ evaluation_id: evs[0].id, criterion_id: "c05", comment: "x" });
    assertValid("appeal", appeal);
    (await api.listAppeals({})).forEach((a) => assertValid("appeal", a));
    assertValid("appeal", await api.getAppeal(appeal.id));
    assertValid("evaluation", await api.decideAppeal(appeal.id, { outcome: "confirmed", reason: "ok" }));
    assertValid("comparison", await api.getComparison({ from_checklist: "official-chat", from_version: 1, to_checklist: copy.checklist_id, to_version: 1 }));
    assertValid("accuracy", await api.getAccuracy());
    assertValid("analytics", await api.getAnalytics());
    assert.equal(typeof api.exportCsvUrl("A"), "string");
    assert.equal(api.audioUrl(await api.getConversation(P1)), null);
  });
});
