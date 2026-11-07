import { getAudioWaveform } from "../audio-waveform.js";
// The in-browser mock of the API contract (spec sections 6-7): the same interface as the HTTP
// adapter, answered from a small state kept in localStorage (or memory). Everything it returns is
// a copy, validates against contract/schemas, and is deterministic for a given dialogue and
// checklist version. Slow things are lazy: a job advances one item per `mockDelayMs` of wall
// clock, worked out when the state is next read, so a page reload mid-job loses nothing.
//
// Modules: fixtures (bundled JSON), persist (storage), grader (the mock model), evaluation
// (reuse, carried decisions, totals), datasets (record -> conversation), checklists (body
// checks), reports (comparison, accuracy, analytics, CSV).
import { ApiError, CLIENT_CODES } from "../errors.js";
import { fingerprint, transcriptHash } from "../../domain/fingerprint.js";
import { parseUpload, UploadError } from "../../domain/normalize.js";
import { validateAnswer } from "../../domain/scoring.js";
import { ChecklistBodyError, completeBody } from "./checklists.js";
import { compactTimestamp, toConversation } from "./datasets.js";
import { buildEvaluation, collectReusable, countCalls, recompute } from "./evaluation.js";
import { DEFAULT_CHECKLIST, exampleRecords, MODEL, OFFICIAL_SEED } from "./fixtures.js";
import { mockInfo, secondOpinion } from "./grader.js";
import { openStore } from "./persist.js";
import { buildAccuracy, buildAnalytics, buildComparison, buildCsv } from "./reports.js";

const ROLES = new Set(["controller", "reviewer"]);
// The backend's agreed error codes and statuses; the mock rejects with exactly these.
const STATUS = Object.freeze({
  not_found: 404,
  role_not_allowed: 403,
  checklist_locked: 409,
  model_key_missing: 409,
  organizer_url_missing: 409,
  appeal_already_open: 409,
  appeal_already_decided: 409,
  invalid_request: 422,
  invalid_checklist: 422,
  reason_required: 422,
  na_not_allowed: 422,
  step_not_in_scale: 422,
  bad_answer: 422,
  no_records: 422,
});

function fail(code, message) {
  // "bad_record:<index>" carries the index in the code, so it is matched by its prefix.
  const status = STATUS[code] ?? (code.startsWith("bad_record:") ? 422 : CLIENT_CODES.includes(code) ? null : 500);
  return new ApiError(code, message, { status });
}

// The scored weights of a checklist body, summed; anything but 100 draws a warning (not an error).
function weightWarnings(criteria) {
  const sum = Number(criteria.filter((c) => c.kind === "scored").reduce((total, c) => total + c.weight, 0).toFixed(6));
  return sum === 100 ? [] : [`weights_sum_${sum}`];
}

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * @param {object} [options]
 * @param {string} [options.devDataUrl]    when set, importDataset("DEV") fetches it (dev server only)
 * @param {string} [options.devAudioBase]  "data/audio/": calls of the DEV group get <base><id>.mp3
 * @param {boolean} [options.mockModelKey] default true; false: actions that need a model call fail
 * @param {number} [options.mockDelayMs]   default 600; one job item and the second opinion take this long
 * @param {Record<string, string>} [options.mockFault]  {method: error code}: that method rejects
 * @param {() => "controller" | "reviewer"} [options.role]  default controller; read at call time
 * @param {Storage | null} [options.storage]  default localStorage when it works, else memory
 * @param {typeof fetch} [options.fetchImpl]  for the dev data
 * @param {() => number} [options.now]     milliseconds, default Date.now (tests inject a clock)
 */
export function createMockApi(options = {}) {
  const {
    devDataUrl = null,
    devAudioBase = null,
    mockModelKey = true,
    mockDelayMs = 600,
    mockFault = {},
    role = () => "controller",
    storage,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
  } = options ?? {};
  if (typeof role !== "function") throw new TypeError("createMockApi: role must be a function");

  const hasKey = Boolean(mockModelKey);
  const delay = Number.isFinite(Number(mockDelayMs)) && Number(mockDelayMs) > 0 ? Number(mockDelayMs) : 0;
  const faults = mockFault !== null && typeof mockFault === "object" ? mockFault : {};
  const iso = (ms) => new Date(ms).toISOString();

  const store = openStore({ storage });
  const { state, volatile } = store;

  const currentRole = () => {
    const value = role();
    if (!ROLES.has(value)) throw new TypeError(`createMockApi: role() returned ${JSON.stringify(value)}`);
    return value;
  };

  // ---- lookups ----------------------------------------------------------------------------

  const lookupConversation = (id) => volatile[id] ?? state.conversations[id];

  function allConversations() {
    const byId = new Map(Object.entries(state.conversations));
    for (const [id, conv] of Object.entries(volatile)) byId.set(id, conv);
    return [...byId.values()];
  }

  const findChecklist = (id) => state.checklists.find((c) => c.checklist_id === id);
  const latestVersion = (row) => row.versions[row.versions.length - 1];
  function findVersion(checklistId, version) {
    const row = findChecklist(checklistId);
    const number = Number(version);
    return row ? row.versions.find((v) => v.version === number) : undefined;
  }
  const findEvaluation = (id) => state.evaluations.find((e) => e.id === id);
  const findAppeal = (id) => state.appeals.find((a) => a.id === id);

  function latestEvaluation(conversationId, checklistId, version) {
    for (let i = state.evaluations.length - 1; i >= 0; i -= 1) {
      const ev = state.evaluations[i];
      if (ev.conversation !== conversationId || ev.status !== "done" || ev.checklist_id !== checklistId) continue;
      if (version !== undefined && ev.version !== Number(version)) continue;
      return ev;
    }
    return undefined;
  }

  function statusOf(conversationId) {
    if (state.appeals.some((a) => a.conversation === conversationId && a.status === "open")) return "disputed";
    return state.evaluations.some((e) => e.conversation === conversationId && e.status === "done") ? "evaluated" : "new";
  }

  function finalOf(conversationId) {
    const ev = latestEvaluation(conversationId, DEFAULT_CHECKLIST.checklist_id, DEFAULT_CHECKLIST.version);
    if (!ev) return null;
    return {
      checklist_id: ev.checklist_id,
      version: ev.version,
      total: ev.final_total,
      gross_error: ev.gross_error.flag,
      open_appeals: state.appeals.filter((a) => a.evaluation_id === ev.id && a.status === "open").length,
      needs_review: ev.results.some((r) => r.needs_review),
    };
  }

  // ---- seed -------------------------------------------------------------------------------

  async function seedOfficial() {
    if (findChecklist(OFFICIAL_SEED.checklist_id)) return;
    const criteria = await Promise.all(
      OFFICIAL_SEED.criteria.map(async (c) => ({ ...structuredClone(c), fingerprint: await fingerprint(c) })),
    );
    state.checklists.push({
      checklist_id: OFFICIAL_SEED.checklist_id,
      versions: [
        {
          id: store.nextId("chv"),
          created_at: iso(now()),
          ...structuredClone(OFFICIAL_SEED),
          based_on: null,
          author_role: null,
          criteria,
        },
      ],
    });
    store.touch();
  }
  const ready = seedOfficial().then(() => store.flush());
  ready.catch(() => {}); // every method awaits it and reports the failure; this only silences the extra copy

  // ---- datasets ---------------------------------------------------------------------------

  async function fetchDevRecords() {
    if (typeof fetchImpl !== "function") throw fail("network", "No fetch available for the dev data");
    let body;
    try {
      const doFetch = fetchImpl; // a plain call: browsers reject fetch with a foreign `this`
      const response = await doFetch(devDataUrl);
      if (!response.ok) throw fail("not_found", `The dev data answered HTTP ${response.status}`);
      body = await response.text();
    } catch (cause) {
      if (cause instanceof ApiError) throw cause;
      throw new ApiError("network", `Cannot load the dev data: ${cause instanceof Error ? cause.message : cause}`, { cause });
    }
    return parseOrReject(body).records;
  }

  function parseOrReject(payload) {
    try {
      return parseUpload(typeof payload === "string" ? payload : JSON.stringify(payload));
    } catch (error) {
      if (error instanceof UploadError) {
        // no_records and bad_record:<i> keep their codes; unreadable JSON is a plain bad request.
        throw fail(error.code === "not_json" ? "invalid_request" : error.code, `Unusable upload: ${error.code}`);
      }
      throw error;
    }
  }

  // Stores the records as the group's conversations; counts imported / updated / unchanged by the
  // transcript hash. Unchanged ones keep what they have (for example the info the mock filled in).
  async function importRecords(groupId, records, { isVolatile }) {
    let imported = 0;
    let updated = 0;
    let unchanged = 0;
    const createdAt = iso(now());
    for (const record of records) {
      const conv = toConversation(record, groupId, { audioBase: devAudioBase, createdAt });
      const hash = await transcriptHash(conv.transcript);
      const known = state.hashes[conv.id];
      if (known === undefined) imported += 1;
      else if (known !== hash) updated += 1;
      else unchanged += 1;
      if (known === hash && lookupConversation(conv.id)) continue;
      delete volatile[conv.id];
      delete state.conversations[conv.id];
      (isVolatile ? volatile : state.conversations)[conv.id] = conv;
      state.hashes[conv.id] = hash;
      store.touch();
    }
    return { group_id: groupId, total: records.length, imported, updated, unchanged };
  }

  async function importDataset(groupId) {
    const group = text(groupId);
    if (group === "") throw new TypeError("API call is missing group_id");
    const fromDevData = group === "DEV" && Boolean(devDataUrl);
    const records = fromDevData ? await fetchDevRecords() : exampleRecords();
    return importRecords(group, records, { isVolatile: fromDevData });
  }

  async function uploadConversations(payload) {
    const { records } = parseOrReject(payload);
    const stamp = `upload-${compactTimestamp(now())}`;
    const taken = new Set(allConversations().map((c) => c.group_id));
    let groupId = stamp;
    for (let n = 2; taken.has(groupId); n += 1) groupId = `${stamp}-${n}`;
    return importRecords(groupId, records, { isVolatile: false });
  }

  // The conversation, importing its group first when it is not loaded (the mock only). A group
  // is imported only when it can hold the id: the dev data for DEV, otherwise the examples. So a
  // mistyped id fails with not_found and does not leave a made-up group in the queue.
  const exampleIds = new Set(exampleRecords().map((r) => r.conversation_id));
  async function resolveConversation(id) {
    const key = text(id);
    const found = lookupConversation(key);
    if (found) return found;
    const cut = key.indexOf(":");
    const group = key.slice(0, cut);
    if (cut > 0 && ((group === "DEV" && devDataUrl) || exampleIds.has(key.slice(cut + 1)))) {
      await importDataset(group);
      const imported = lookupConversation(key);
      if (imported) return imported;
    }
    throw fail("not_found", `No conversation ${key}`);
  }

  async function getConversation(id) {
    const conv = await resolveConversation(id);
    return { ...conv, status: statusOf(conv.id) };
  }

  async function listConversations(filters = {}) {
    const { group_id, status, channel, language, q } = filters ?? {};
    const needle = text(q).toLowerCase();
    const items = [];
    for (const conv of allConversations()) {
      const current = statusOf(conv.id);
      if (group_id && conv.group_id !== group_id) continue;
      if (status && current !== status) continue;
      if (channel && conv.channel !== channel) continue;
      if (language && conv.language !== language) continue;
      if (needle) {
        const haystack = [conv.id, conv.info?.topic ?? "", ...conv.transcript.map((m) => m.text)].join("\n").toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      const { transcript: _omitted, ...item } = conv;
      items.push({ ...item, status: current, final: finalOf(conv.id) });
    }
    return items;
  }

  async function getTranslation(id, to = "ru") {
    const conv = await resolveConversation(id);
    const key = `${conv.id}|${to}`;
    if (!state.translations[key]) {
      state.translations[key] = conv.transcript.map((m, i) => ({ message_index: i, text: `[демо-перевод] ${m.text}` }));
      store.touch();
    }
    return { conversation: conv.id, to, messages: state.translations[key] };
  }

  // ---- checklists -------------------------------------------------------------------------

  async function bodyOrReject(body, fallback) {
    try {
      return await completeBody(body, fallback);
    } catch (error) {
      if (error instanceof ChecklistBodyError) throw fail("invalid_checklist", error.message);
      throw error;
    }
  }

  const summaryOf = (row) => ({
    ...latestVersion(row),
    versions: row.versions.map((v) => v.version), // plain numbers, as the backend sends them
  });

  // The response of a save may carry `warnings`; the stored version does not.
  function withWarnings(version) {
    const warnings = weightWarnings(version.criteria);
    return warnings.length > 0 ? { ...version, warnings } : version;
  }

  async function listChecklists() {
    return state.checklists.map(summaryOf);
  }

  async function getChecklistVersion(checklistId, version) {
    const found = findVersion(checklistId, version);
    if (!found) throw fail("not_found", `No checklist version ${checklistId} v${version}`);
    return found;
  }

  async function createChecklist(body = {}) {
    const authorRole = currentRole();
    let source = null;
    let basedOn = null;
    if (body?.based_on) {
      source = findVersion(body.based_on.checklist_id, body.based_on.version);
      if (!source) throw fail("not_found", "The checklist to copy from does not exist");
      basedOn = { checklist_id: source.checklist_id, version: source.version };
    }
    const completed = await bodyOrReject(
      { ...body, name: body?.name ?? (source ? `${source.name} (копия)` : undefined) },
      source,
    );
    const checklistId = store.nextId("ck");
    const version = {
      id: store.nextId("chv"),
      created_at: iso(now()),
      checklist_id: checklistId,
      version: 1,
      ...completed,
      locked: false,
      based_on: basedOn,
      author_role: authorRole,
    };
    state.checklists.push({ checklist_id: checklistId, versions: [version] });
    store.touch();
    return withWarnings(version);
  }

  async function saveChecklistVersion(checklistId, body = {}) {
    const authorRole = currentRole();
    const row = findChecklist(checklistId);
    if (!row) throw fail("not_found", `No checklist ${checklistId}`);
    const previous = latestVersion(row);
    if (previous.locked) throw fail("checklist_locked", `Checklist ${checklistId} is locked; save a copy with based_on instead`);
    const completed = await bodyOrReject(body, previous);
    const version = {
      id: store.nextId("chv"),
      created_at: iso(now()),
      checklist_id: checklistId,
      version: previous.version + 1,
      ...completed,
      locked: false,
      based_on: previous.based_on,
      author_role: authorRole,
    };
    row.versions.push(version);
    store.touch();
    return withWarnings(version);
  }

  // ---- evaluations and jobs ---------------------------------------------------------------

  function addEvaluation(conv, version, mode, createdAt) {
    const hash = state.hashes[conv.id];
    const { evaluation, meta } = buildEvaluation({
      id: store.nextId("ev"),
      createdAt,
      conversation: conv,
      version,
      hash,
      mode,
      reusable: collectReusable(state.evaluations, state.evalMeta, conv.id, hash),
      appeals: state.appeals,
      evalMeta: state.evalMeta,
    });
    state.evaluations.push(evaluation);
    state.evalMeta[evaluation.id] = meta;
    if (conv.info === null) conv.info = mockInfo(conv); // extra B: filled on first grading
    return evaluation;
  }

  // Finishes one item of a job; the time is when the item was due, not when it was noticed.
  function finishItem(job, item, dueMs) {
    const meta = state.jobMeta[job.id];
    const conv = lookupConversation(item.conversation);
    const version = findVersion(meta.checklist_id, meta.version);
    if (!conv || !version) {
      item.status = "failed";
      item.error = "Диалог не загружен: импортируйте группу ещё раз.";
    } else if (conv.transcript.length === 0) {
      item.status = "failed";
      item.error = "Пустой диалог: оценивать нечего.";
    } else {
      item.evaluation_id = addEvaluation(conv, version, meta.mode, iso(Math.min(dueMs, now()))).id;
      item.status = "done";
      item.error = null;
    }
  }

  const unfinished = (job) => job.items.findIndex((i) => i.status === "queued" || i.status === "running");

  function advanceJob(job) {
    const meta = state.jobMeta[job.id];
    if (!meta || unfinished(job) === -1) return;
    const clock = now();
    let cursor = meta.cursor;
    let index = unfinished(job);
    while (index !== -1) {
      job.items[index].status = "running";
      if (clock - cursor < delay) break;
      cursor += delay;
      finishItem(job, job.items[index], cursor);
      index = unfinished(job);
    }
    meta.cursor = cursor;
    job.done = job.items.filter((i) => i.status === "done").length;
    job.failed = job.items.filter((i) => i.status === "failed").length;
    job.status = unfinished(job) !== -1 ? "running" : job.done === 0 && job.failed > 0 ? "failed" : "done";
    store.touch();
  }

  function advanceJobs() {
    for (const job of state.jobs) if (job.status === "running") advanceJob(job);
  }

  // Appeals whose second opinion is due get it now.
  function advanceAppeals() {
    for (const appeal of state.appeals) {
      if (appeal.second_opinion_status !== "pending") continue;
      const meta = state.appealMeta[appeal.id];
      if (hasKey && meta && now() < meta.ready_at) continue;
      const ev = findEvaluation(appeal.evaluation_id);
      const conv = lookupConversation(appeal.conversation);
      const criterion = ev && findVersion(ev.checklist_id, ev.version)?.criteria.find((c) => c.id === appeal.criterion_id);
      const result = ev?.results.find((r) => r.criterion_id === appeal.criterion_id);
      if (!hasKey || !conv || !criterion || !result) {
        appeal.second_opinion_status = "unavailable";
      } else {
        appeal.second_opinion = secondOpinion(conv, criterion, result.answer);
        appeal.second_opinion_status = "done";
      }
      store.touch();
    }
  }

  async function startEvaluations({ conversations, checklist_id, version, mode = "reuse", dry_run = false } = {}) {
    if (!Array.isArray(conversations) || conversations.length === 0) {
      throw fail("invalid_request", "conversations must be a non-empty array");
    }
    if (mode !== "reuse" && mode !== "full") throw fail("invalid_request", 'mode must be "reuse" or "full"');
    const checklist = findVersion(checklist_id, version);
    if (!checklist) throw fail("not_found", `No checklist version ${checklist_id} v${version}`);

    const convs = [];
    for (const id of [...new Set(conversations)]) convs.push(await resolveConversation(id));

    // `total` counts dialogues; `model_calls` and `reused` count criterion calls (the backend's unit).
    let modelCalls = 0;
    let reused = 0;
    for (const conv of convs) {
      const reusable = collectReusable(state.evaluations, state.evalMeta, conv.id, state.hashes[conv.id]);
      const counted = countCalls(checklist, reusable, mode);
      modelCalls += counted.modelCalls;
      reused += counted.reused;
    }
    if (dry_run) return { total: convs.length, model_calls: modelCalls, reused };
    if (modelCalls > 0 && !hasKey) {
      throw fail("model_key_missing", "A new model call is needed and no model key is configured");
    }

    const job = {
      id: store.nextId("job"),
      created_at: iso(now()),
      status: "running",
      mode,
      total: convs.length,
      done: 0,
      failed: 0,
      items: convs.map((c) => ({ conversation: c.id, status: "queued", error: null, evaluation_id: null })),
    };
    state.jobs.push(job);
    state.jobMeta[job.id] = { checklist_id: checklist.checklist_id, version: checklist.version, mode, cursor: now() };
    advanceJob(job);
    return job;
  }

  async function getJob(id) {
    const job = state.jobs.find((j) => j.id === id);
    if (!job) throw fail("not_found", `No job ${id}`);
    return job;
  }

  async function retryJob(id) {
    const job = await getJob(id);
    const failed = job.items.filter((i) => i.status === "failed");
    if (failed.length === 0) return job;
    if (!hasKey) throw fail("model_key_missing", "Retrying needs new model calls and no model key is configured");
    for (const item of failed) {
      item.status = "queued";
      item.error = null;
    }
    job.status = "running";
    state.jobMeta[job.id].cursor = now();
    advanceJob(job);
    return job;
  }

  async function listEvaluations(filters = {}) {
    const { conversation, checklist_id } = filters ?? {};
    return state.evaluations
      .filter((e) => (!conversation || e.conversation === conversation) && (!checklist_id || e.checklist_id === checklist_id))
      .reverse();
  }

  async function getEvaluation(id) {
    const ev = findEvaluation(id);
    if (!ev) throw fail("not_found", `No evaluation ${id}`);
    return ev;
  }

  // ---- appeals ----------------------------------------------------------------------------

  async function fileAppeal({ evaluation_id, criterion_id, comment } = {}) {
    const appealRole = currentRole();
    if (appealRole !== "controller") throw fail("role_not_allowed", "Only a controller can file an appeal");
    const ev = findEvaluation(evaluation_id);
    if (!ev || ev.status !== "done") throw fail("not_found", `No finished evaluation ${evaluation_id}`);
    if (!ev.results.some((r) => r.criterion_id === criterion_id)) {
      throw fail("not_found", `Evaluation ${ev.id} has no criterion ${criterion_id}`);
    }
    if (text(comment) === "") throw fail("invalid_request", "A comment is required");
    if (state.appeals.some((a) => a.evaluation_id === ev.id && a.criterion_id === criterion_id && a.status === "open")) {
      throw fail("appeal_already_open", `Criterion ${criterion_id} already has an open appeal on ${ev.id}`);
    }
    const appeal = {
      id: store.nextId("ap"),
      created_at: iso(now()),
      evaluation_id: ev.id,
      conversation: ev.conversation,
      criterion_id,
      comment: text(comment),
      role: appealRole,
      status: "open",
      second_opinion: null,
      second_opinion_status: hasKey ? "pending" : "unavailable",
      decision: null,
    };
    state.appeals.push(appeal);
    if (hasKey) state.appealMeta[appeal.id] = { ready_at: now() + delay };
    store.touch();
    return appeal;
  }

  async function listAppeals(filters = {}) {
    const { status } = filters ?? {};
    return state.appeals.filter((a) => !status || a.status === status).reverse();
  }

  async function getAppeal(id) {
    const appeal = findAppeal(id);
    if (!appeal) throw fail("not_found", `No appeal ${id}`);
    return appeal;
  }

  async function decideAppeal(id, { outcome, answer, reason } = {}) {
    const deciderRole = currentRole();
    if (deciderRole !== "reviewer") throw fail("role_not_allowed", "Only a reviewer can decide an appeal");
    const appeal = await getAppeal(id);
    if (appeal.status !== "open") throw fail("appeal_already_decided", `Appeal ${id} is already decided`);
    if (outcome !== "confirmed" && outcome !== "changed") throw fail("invalid_request", 'outcome must be "confirmed" or "changed"');
    if (text(reason) === "") throw fail("reason_required", "A reason is required");

    const ev = findEvaluation(appeal.evaluation_id);
    const version = findVersion(ev.checklist_id, ev.version);
    const criterion = version.criteria.find((c) => c.id === appeal.criterion_id);
    const result = ev.results.find((r) => r.criterion_id === appeal.criterion_id);

    let decided = structuredClone(result.answer); // "confirmed" keeps the model's answer
    if (outcome === "changed") {
      const problem = validateAnswer(criterion, answer);
      if (problem) throw fail(problem, `The answer does not fit criterion ${criterion.id}: ${problem}`);
      decided = structuredClone(answer);
    }
    appeal.status = "decided";
    appeal.decision = { outcome, answer: decided, reason: text(reason), role: deciderRole, decided_at: iso(now()) };
    // The reviewer's decision is the final answer; any decision carried in from before is replaced.
    result.final_answer = structuredClone(decided);
    result.carried_decision = null;
    recompute(ev, version);
    store.touch();
    return ev;
  }

  // ---- reports ----------------------------------------------------------------------------

  const reportContext = () => ({
    conversations: allConversations,
    latestEvaluation,
    version: findVersion,
    appeals: state.appeals,
    defaultChecklist: DEFAULT_CHECKLIST,
  });

  async function getComparison(params = {}) {
    const { from_checklist, from_version, to_checklist, to_version, group_id, conversations } = params ?? {};
    if (!from_checklist || !to_checklist || from_version === undefined || to_version === undefined) {
      throw fail("invalid_request", "from_checklist, from_version, to_checklist and to_version are required");
    }
    const from = findVersion(from_checklist, from_version);
    const to = findVersion(to_checklist, to_version);
    if (!from || !to) throw fail("not_found", "A checklist version in the comparison does not exist");
    const list = conversations === undefined || conversations === "" ? null : Array.isArray(conversations) ? conversations : String(conversations).split(",");
    return buildComparison(reportContext(), { from, to, groupId: group_id, conversations: list });
  }

  const getAccuracy = async () => buildAccuracy(reportContext());
  const getAnalytics = async () => buildAnalytics(reportContext());

  const csvUrls = new Map(); // group -> the last object URL, revoked when replaced
  function exportCsvUrl(groupId) {
    const csv = buildCsv(reportContext(), groupId);
    if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function" && typeof Blob !== "undefined") {
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const key = groupId ?? "";
      const previous = csvUrls.get(key);
      if (previous && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(previous);
      csvUrls.set(key, url);
      return url;
    }
    return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
  }

  // ---- the adapter ------------------------------------------------------------------------

  // Every method: an injected fault rejects first; otherwise wait for the seed, bring jobs and
  // second opinions up to date, run, hand back a copy, and write the state if it changed.
  function method(name, fn) {
    return async (...args) => {
      const code = faults[name];
      if (code) throw fail(code, `Injected mock fault for ${name}`);
      await ready;
      try {
        advanceJobs();
        advanceAppeals();
        return structuredClone(await fn(...args));
      } finally {
        store.flush();
      }
    };
  }

  return {
    getAudioWaveform,
    getConfig: method("getConfig", async () => ({
      models: [MODEL],
      prices: { [MODEL]: { input_per_mtok_usd: 0, output_per_mtok_usd: 0 } },
      model_key_configured: hasKey,
      default_checklist: { ...DEFAULT_CHECKLIST },
    })),
    importDataset: method("importDataset", importDataset),
    uploadConversations: method("uploadConversations", uploadConversations),

    listConversations: method("listConversations", listConversations),
    getConversation: method("getConversation", getConversation),
    audioUrl: (conversation) => {
      const audio = conversation?.audio;
      return typeof audio === "string" && audio !== "" ? audio : null;
    },
    getTranslation: method("getTranslation", getTranslation),

    listChecklists: method("listChecklists", listChecklists),
    getChecklistVersion: method("getChecklistVersion", getChecklistVersion),
    createChecklist: method("createChecklist", createChecklist),
    saveChecklistVersion: method("saveChecklistVersion", saveChecklistVersion),

    startEvaluations: method("startEvaluations", startEvaluations),
    getJob: method("getJob", getJob),
    retryJob: method("retryJob", retryJob),

    listEvaluations: method("listEvaluations", listEvaluations),
    getEvaluation: method("getEvaluation", getEvaluation),

    fileAppeal: method("fileAppeal", fileAppeal),
    listAppeals: method("listAppeals", listAppeals),
    getAppeal: method("getAppeal", getAppeal),
    decideAppeal: method("decideAppeal", decideAppeal),

    getComparison: method("getComparison", getComparison),
    getAccuracy: method("getAccuracy", getAccuracy),
    getAnalytics: method("getAnalytics", getAnalytics),
    exportCsvUrl,
  };
}
