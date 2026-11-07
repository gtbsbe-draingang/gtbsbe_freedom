// The API contract (spec section 7): JSON Schemas, example payloads and the official checklist
// seed. The backend's Pydantic models and the mock adapter are both tested against these files,
// so a drift fails a test instead of the demo.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const schemaDir = join(repoRoot, "contract", "schemas");
const exampleDir = join(repoRoot, "contract", "examples");
const seedFile = join(repoRoot, "checklists", "official-chat-v1.json");

const SCHEMA_NAMES = [
  "error", "conversation", "queue-item", "checklist-version", "checklist-seed", "evaluation",
  "appeal", "job", "config", "comparison", "accuracy", "analytics", "translation", "dry-run",
  "import-summary",
];

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out.sort();
}

function buildAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  for (const name of SCHEMA_NAMES) {
    ajv.addSchema(readJson(join(schemaDir, `${name}.schema.json`)));
  }
  return ajv;
}

function validator(ajv, name) {
  const validate = ajv.getSchema(`cqa/${name}`);
  assert.ok(validate, `schema cqa/${name} is registered`);
  return validate;
}

const describeErrors = (validate) =>
  JSON.stringify(validate.errors?.map((e) => `${e.instancePath || "/"} ${e.message}`), null, 1);

const examples = () =>
  readdirSync(exampleDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({ file, name: file.split(".")[0], data: readJson(join(exampleDir, file)) }));

const example = (file) => clone(readJson(join(exampleDir, file)));

describe("schemas", () => {
  test("every schema file exists, has $id cqa/<name> and is a valid 2020-12 schema", () => {
    const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
    for (const name of SCHEMA_NAMES) {
      const schema = readJson(join(schemaDir, `${name}.schema.json`));
      assert.equal(schema.$id, `cqa/${name}`, `${name}: $id`);
      assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema", `${name}: $schema`);
      assert.doesNotThrow(() => ajv.compile(schema), `${name} compiles`);
    }
    const files = readdirSync(schemaDir).filter((f) => f.endsWith(".schema.json")).sort();
    assert.deepEqual(files, SCHEMA_NAMES.map((n) => `${n}.schema.json`).sort(), "no stray schema files");
  });
});

describe("examples", () => {
  test("every example validates against the schema named by its file prefix", () => {
    const ajv = buildAjv();
    const all = examples();
    assert.ok(all.length >= SCHEMA_NAMES.length - 1, "examples exist");
    for (const { file, name, data } of all) {
      assert.ok(SCHEMA_NAMES.includes(name), `${file}: prefix "${name}" names a schema`);
      const validate = validator(ajv, name);
      assert.ok(validate(data), `${file} must validate against cqa/${name}: ${describeErrors(validate)}`);
    }
  });

  test("every schema except the seed has at least one example", () => {
    const covered = new Set(examples().map((e) => e.name));
    for (const name of SCHEMA_NAMES) {
      if (name === "checklist-seed") continue;
      assert.ok(covered.has(name), `no example for ${name}`);
    }
  });

  test("conversation ids are {group_id}:{conversation_id}; chat and call match the agreed shape", () => {
    const chat = example("conversation.chat-ru.json");
    const call = example("conversation.call-ru.json");
    for (const c of [chat, call]) assert.equal(c.id, `${c.group_id}:${c.conversation_id}`);
    assert.equal(chat.conversation_id, "p1-ru-001");
    assert.equal(chat.channel, "agent chat");
    assert.equal(chat.audio, null);
    assert.equal(chat.audio_unavailable_reason, "none");
    assert.equal(chat.facts.ending, "normal", "a goodbye without a close event is a normal ending");
    assert.equal(call.conversation_id, "p4-ru-001");
    assert.equal(call.channel, "voice call");
    assert.equal(call.audio, null);
    assert.equal(call.audio_unavailable_reason, "needs_import");
    assert.equal(call.facts.ending, "normal");
    assert.ok(call.audio_offsets.length >= 3, "call has at least 3 audio_offsets");
    assert.ok(call.voice_measurements.length >= 2, "call has at least 2 voice_measurements");
    const speakers = new Set(chat.transcript.map((m) => m.speaker));
    assert.ok(speakers.size >= 3, "chat mixes client, operator and context lines");
  });

  test("evaluation evidence points at real messages and quotes their words", () => {
    const conversations = new Map(
      examples().filter((e) => e.name === "conversation").map((e) => [e.data.id, e.data]),
    );
    const evaluations = examples().filter((e) => e.name === "evaluation");
    assert.ok(evaluations.length >= 2);
    for (const { file, data } of evaluations) {
      const conv = conversations.get(data.conversation);
      assert.ok(conv, `${file}: conversation ${data.conversation} has an example`);
      const evidence = [
        ...data.results.flatMap((r) => r.evidence),
        ...data.gross_error.evidence,
      ];
      assert.ok(evidence.length > 0, `${file}: has evidence`);
      for (const ev of evidence) {
        const message = conv.transcript[ev.message_index];
        assert.ok(message, `${file}: message_index ${ev.message_index} exists`);
        assert.ok(message.text.includes(ev.quote), `${file}: quote "${ev.quote}" is in message ${ev.message_index}`);
      }
      for (const r of data.results) {
        if (r.checked_range) {
          assert.ok(r.checked_range.from <= r.checked_range.to);
          assert.ok(conv.transcript[r.checked_range.to], `${file}: checked_range ends inside the transcript`);
        }
      }
    }
  });

  test("evaluation example totals follow the points of the final answers", () => {
    for (const { file, data } of examples().filter((e) => e.name === "evaluation")) {
      const sum = data.results.reduce((acc, r) => acc + (r.points ?? 0), 0);
      assert.ok(Math.abs(sum - data.final_total) <= 0.02, `${file}: points ${sum} vs final_total ${data.final_total}`);
      const sectionSum = data.sections.reduce((acc, s) => acc + (s.points ?? 0), 0);
      assert.ok(Math.abs(sectionSum - data.final_total) <= 0.02, `${file}: section points ${sectionSum}`);
    }
  });

  test("the chat evaluation covers N/A, a scale answer, needs_review, coaching, a carried decision and no gross error", () => {
    const ev = example("evaluation.chat-na-scale-carried.json");
    assert.ok(ev.results.some((r) => r.answer === "na" && r.na_reason));
    assert.ok(ev.results.some((r) => typeof r.answer === "object" && typeof r.answer.step === "number"));
    assert.ok(ev.results.some((r) => r.needs_review === true));
    assert.ok(ev.results.some((r) => typeof r.coaching === "string" && r.coaching.length > 0));
    const carried = ev.results.find((r) => r.carried_decision);
    assert.ok(carried && carried.final_answer !== carried.answer, "carried decision changes the answer");
    assert.equal(ev.gross_error.flag, false);
    assert.notEqual(ev.original_total, ev.final_total);
  });

  test("the call evaluation has the gross error on with kinds [insult]", () => {
    const ev = example("evaluation.call-gross-error.json");
    assert.equal(ev.gross_error.flag, true);
    assert.deepEqual(ev.gross_error.kinds, ["insult"]);
  });

  test("appeals cover a pending second opinion and a decided one", () => {
    const pending = example("appeal.pending.json");
    const decided = example("appeal.decided.json");
    assert.equal(pending.second_opinion_status, "pending");
    assert.equal(pending.status, "open");
    assert.equal(pending.decision, null);
    assert.equal(decided.status, "decided");
    assert.ok(decided.decision && decided.decision.role === "reviewer");
  });

  test("the job example has one failed item", () => {
    const job = example("job.one-failed.json");
    assert.equal(job.failed, 1);
    assert.equal(job.items.filter((i) => i.status === "failed").length, 1);
  });
});

describe("official checklist seed", () => {
  test("seed validates against checklist-seed", () => {
    const ajv = buildAjv();
    const validate = validator(ajv, "checklist-seed");
    assert.ok(validate(readJson(seedFile)), describeErrors(validate));
  });

  test("seed carries the agreed header, sections, weights and N/A rules", () => {
    const seed = readJson(seedFile);
    assert.equal(seed.checklist_id, "official-chat");
    assert.equal(seed.version, 1);
    assert.equal(seed.name, "Чек-лист качества чатов");
    assert.equal(seed.channel, "any");
    assert.equal(seed.locked, true);
    assert.equal(seed.rounding, 2);
    for (const banned of ["id", "created_at", "fingerprint", "author_role", "based_on"]) {
      assert.ok(!(banned in seed), `seed has no ${banned}`);
    }
    assert.deepEqual(
      seed.sections.map((s) => [s.id, s.title]),
      [
        ["start", "Начало и понимание запроса"],
        ["safety", "Безопасность и решение"],
        ["conduct", "Ведение и завершение диалога"],
        ["gross", "Грубые нарушения"],
      ],
    );
    assert.deepEqual(seed.criteria.map((c) => c.id), ["c01", "c02", "c03", "c04", "c05", "c06", "c07", "c08"]);
    assert.deepEqual(seed.criteria.map((c) => c.weight), [10, 15, 20, 20, 15, 15, 5, 0]);
    assert.deepEqual(seed.criteria.map((c) => c.section_id), ["start", "start", "safety", "safety", "conduct", "conduct", "conduct", "gross"]);
    assert.deepEqual(seed.criteria.map((c) => c.na_allowed), [false, true, true, true, false, false, true, false]);
    for (const c of seed.criteria) {
      assert.ok(!("fingerprint" in c), `${c.id} has no fingerprint`);
      assert.equal(c.na_allowed, c.na_condition !== null, `${c.id}: na_condition iff N/A allowed`);
      if (c.na_condition !== null) assert.match(c.na_condition, /^N\/A — /);
    }
    assert.deepEqual(seed.criteria.map((c) => c.answer_type), ["yes_no", "yes_no", "yes_no", "scale", "yes_no", "scale", "yes_no", "yes_no"]);
    assert.deepEqual(seed.criteria[3].scale_steps.map((s) => s.value), [0, 5, 10, 15, 20]);
    assert.deepEqual(seed.criteria[5].scale_steps.map((s) => s.value), [0, 4, 7, 10]);
    for (const c of [seed.criteria[3], seed.criteria[5]]) {
      for (const step of c.scale_steps) assert.ok(step.label.length > 0);
    }
    const gross = seed.criteria[7];
    assert.equal(gross.kind, "gross_error");
    assert.deepEqual(gross.kinds, ["insult", "paid_service_outside_company", "confidential_disclosure"]);
    assert.ok(seed.criteria.slice(0, 7).every((c) => c.kind === "scored"));
    assert.match(seed.guidance, /Что считать предложением услуги в обход компании\?/);
    assert.match(seed.guidance, /порог первой реакции в 3 минуты/);
  });
});

describe("schema rules", () => {
  test("step answer must be a number", () => {
    const validate = validator(buildAjv(), "evaluation");
    const ev = example("evaluation.chat-na-scale-carried.json");
    const scale = ev.results.find((r) => typeof r.answer === "object");
    assert.ok(validate(ev), "baseline example is valid");

    scale.answer = { step: "15" };
    assert.equal(validate(ev), false, 'answer {"step": "15"} is rejected');

    scale.answer = { step: 15 };
    scale.final_answer = { step: "15" };
    assert.equal(validate(ev), false, "final_answer needs a numeric step too");
  });

  test("evaluation without conversation is rejected", () => {
    const validate = validator(buildAjv(), "evaluation");
    const ev = example("evaluation.chat-na-scale-carried.json");
    delete ev.conversation;
    assert.equal(validate(ev), false);
  });

  test("evaluation results need final_answer, and a done evaluation needs its totals", () => {
    const validate = validator(buildAjv(), "evaluation");
    const noFinal = example("evaluation.chat-na-scale-carried.json");
    delete noFinal.results[0].final_answer;
    assert.equal(validate(noFinal), false, "final_answer is required");

    const noTotals = example("evaluation.chat-na-scale-carried.json");
    delete noTotals.final_total;
    assert.equal(validate(noTotals), false, "done evaluation needs final_total (null when not calculated)");

    const queued = example("evaluation.chat-na-scale-carried.json");
    for (const key of ["results", "original_total", "final_total", "sections", "gross_error"]) delete queued[key];
    queued.status = "queued";
    assert.ok(validate(queued), describeErrors(validate));

    const notCalculated = example("evaluation.chat-na-scale-carried.json");
    notCalculated.final_total = null;
    notCalculated.original_total = null;
    assert.ok(validate(notCalculated), "null totals mean not calculated");
  });

  test("conversation with audio_url is rejected", () => {
    const ajv = buildAjv();
    const conv = example("conversation.call-ru.json");
    conv.audio_url = "https://example.invalid/audio.mp3";
    assert.equal(validator(ajv, "conversation")(conv), false);

    const item = example("queue-item.chat-ru.json");
    item.audio_url = "https://example.invalid/audio.mp3";
    assert.equal(validator(ajv, "queue-item")(item), false, "queue-item forbids audio_url too");
  });

  test("a conversation without audio needs a reason; speaker is any string; extra fields pass", () => {
    const validate = validator(buildAjv(), "conversation");
    const noReason = example("conversation.call-ru.json");
    delete noReason.audio_unavailable_reason;
    assert.equal(validate(noReason), false, "audio null needs audio_unavailable_reason");

    const odd = example("conversation.chat-ru.json");
    odd.transcript[0].speaker = "Supervisor-7";
    odd.extra_backend_field = { anything: true };
    assert.ok(validate(odd), describeErrors(validate));

    const withAudio = example("conversation.call-ru.json");
    withAudio.audio = "/conversations/example:p4-ru-001/audio";
    delete withAudio.audio_unavailable_reason;
    assert.ok(validate(withAudio), "audio path without a reason is fine");
  });

  test("facts.ending is one of the agreed values", () => {
    const ajv = buildAjv();
    const endings = ["operator_closed", "client_left", "connection_lost", "client_ended_call", "normal"];
    for (const name of ["conversation", "queue-item"]) {
      const validate = validator(ajv, name);
      const base = example(name === "conversation" ? "conversation.chat-ru.json" : "queue-item.chat-ru.json");
      for (const ending of endings) {
        base.facts.ending = ending;
        assert.ok(validate(base), `${name}: ${ending} is allowed: ${describeErrors(validate)}`);
      }
      for (const ending of ["operator_goodbye", "operator_ended_call", ""]) {
        base.facts.ending = ending;
        assert.equal(validate(base), false, `${name}: "${ending}" is rejected`);
      }
    }
  });

  test("info.outcome is one of the agreed values; the other info fields are free text", () => {
    const ajv = buildAjv();
    const outcomes = ["resolved", "passed_to_specialists", "unresolved", "client_left", null];
    for (const name of ["conversation", "queue-item"]) {
      const validate = validator(ajv, name);
      const base = example(name === "conversation" ? "conversation.chat-ru.json" : "queue-item.chat-ru.json");
      for (const outcome of outcomes) {
        base.info.outcome = outcome;
        assert.ok(validate(base), `${name}: outcome ${outcome} is allowed: ${describeErrors(validate)}`);
      }
      for (const outcome of ["вопрос решён", "solved", ""]) {
        base.info.outcome = outcome;
        assert.equal(validate(base), false, `${name}: outcome "${outcome}" is rejected`);
      }
      base.info = { topic: "Любая тема", mood_start: "любое", mood_end: "любое", outcome: "resolved" };
      assert.ok(validate(base), `${name}: topic and moods are free text`);
      base.info = null;
      assert.ok(validate(base), `${name}: info may be null`);
    }
  });

  test("language is a plain string with the RU/KZ/EN convention in the examples", () => {
    const ajv = buildAjv();
    const conv = example("conversation.chat-ru.json");
    conv.language = "DE";
    assert.ok(validator(ajv, "conversation")(conv), "another code is kept, not rejected");

    const languages = [];
    for (const { name, data } of examples()) {
      if (name === "conversation" || name === "queue-item") languages.push(data.language);
      if (name === "analytics" || name === "accuracy") languages.push(...data.by_language.map((r) => r.language));
    }
    assert.ok(languages.length >= 8);
    for (const language of languages) assert.match(language, /^(RU|KZ|EN)$/);
  });

  test("checklist guidance is a string (empty when none); criterion guidance is null when none", () => {
    const ajv = buildAjv();
    const version = validator(ajv, "checklist-version");
    const seed = validator(ajv, "checklist-seed");
    const custom = example("checklist-version.custom.json");
    assert.equal(custom.guidance, "");
    assert.ok(custom.criteria.every((c) => c.guidance === null), "empty criterion guidance is null, not an empty string");
    assert.ok(version(custom), describeErrors(version));

    const nullTop = clone(custom);
    nullTop.guidance = null;
    assert.equal(version(nullTop), false, "checklist-level guidance null is rejected");
    const withText = clone(custom);
    withText.criteria[0].guidance = "Подсказка проверяющему.";
    assert.ok(version(withText), "criterion guidance may be text");

    const official = readJson(seedFile);
    assert.ok(seed(official), describeErrors(seed));
    official.guidance = null;
    assert.equal(seed(official), false, "the seed's checklist-level guidance is a string too");
  });

  test("seed criterion guidance is the #25 team note on c01, c03, c06, c07 and null elsewhere", () => {
    const seed = readJson(seedFile);
    assert.equal(typeof seed.guidance, "string");
    assert.ok(seed.guidance.length > 0);
    const team = new Set(["c01", "c03", "c06", "c07"]);
    for (const c of seed.criteria) {
      if (team.has(c.id)) assert.match(c.guidance, /^Уточнение команды: /, `${c.id}: team guidance`);
      else assert.strictEqual(c.guidance, null, `${c.id}: guidance is null`);
    }
  });

  test("voice measurements use semitones, seconds and words per minute", () => {
    const call = example("conversation.call-ru.json");
    for (const m of call.voice_measurements) {
      assert.ok(m.pitch_range >= 0 && m.pitch_range <= 24, `pitch_range ${m.pitch_range} is in semitones`);
      assert.ok(m.pauses <= m.to_seconds - m.from_seconds, "pauses are seconds of silence inside the part");
      assert.ok(m.overlap <= m.to_seconds - m.from_seconds, "overlap is seconds inside the part");
    }
    const schema = readJson(join(schemaDir, "conversation.schema.json"));
    const props = schema.$defs.voice_measurements.items.properties;
    assert.match(props.pitch_range.description, /semitones/);
    assert.match(props.pauses.description, /Seconds of silence/);
    assert.match(props.rate_wpm.description, /words per minute/);
    assert.match(props.overlap.description, /overlaps the client/);
  });

  test("conversation references need the {group_id}:{conversation_id} form", () => {
    const ajv = buildAjv();
    const cases = [
      ["conversation", "conversation.chat-ru.json", (o) => { o.id = "p1-ru-001"; }],
      ["queue-item", "queue-item.chat-ru.json", (o) => { o.id = "p1-ru-001"; }],
      ["evaluation", "evaluation.chat-na-scale-carried.json", (o) => { o.conversation = "p1-ru-001"; }],
      ["appeal", "appeal.pending.json", (o) => { o.conversation = "p4-ru-001"; }],
      ["job", "job.one-failed.json", (o) => { o.items[0].conversation = "p1-ru-001"; }],
      ["comparison", "comparison.json", (o) => { o.rows[0].conversation = "p1-ru-001"; }],
      ["accuracy", "accuracy.json", (o) => { o.disagreements[0].conversation = "p1-ru-001"; }],
      ["translation", "translation.json", (o) => { o.conversation = "p2-kz-004"; }],
      ["analytics", "analytics.json", (o) => { o.gross_errors.conversations[0] = "p4-ru-001"; }],
    ];
    for (const [name, file, breakIt] of cases) {
      const validate = validator(ajv, name);
      const good = example(file);
      assert.ok(validate(good), `${file}: baseline is valid`);
      breakIt(good);
      assert.equal(validate(good), false, `${name}: a bare conversation_id is rejected`);
    }
  });

  test("a comparison delta may be null; accuracy agreement stays within 0..1", () => {
    const ajv = buildAjv();
    const cmp = example("comparison.json");
    cmp.rows[0].new_total = null;
    cmp.rows[0].delta = null;
    assert.ok(validator(ajv, "comparison")(cmp), "null delta is allowed");

    const acc = example("accuracy.json");
    assert.ok(validator(ajv, "accuracy")(acc));
    acc.overall.agreement = 1.2;
    assert.equal(validator(ajv, "accuracy")(acc), false, "agreement above 1 is rejected");
  });

  test("appeal role and decision outcome are enumerated", () => {
    const validate = validator(buildAjv(), "appeal");
    const badRole = example("appeal.decided.json");
    badRole.role = "admin";
    assert.equal(validate(badRole), false);
    const badOutcome = example("appeal.decided.json");
    badOutcome.decision.outcome = "maybe";
    assert.equal(validate(badOutcome), false);
  });

  test("a scale criterion needs steps and a gross-error criterion weighs 0", () => {
    const validate = validator(buildAjv(), "checklist-seed");
    const noSteps = readJson(seedFile);
    noSteps.criteria[3].scale_steps = [];
    assert.equal(validate(noSteps), false, "scale without steps");

    const weighted = readJson(seedFile);
    weighted.criteria[7].weight = 5;
    assert.equal(validate(weighted), false, "gross error with weight");
  });
});

describe("secrets", () => {
  test('no file in contract/ or checklists/ contains "sig="', () => {
    const files = [...walk(join(repoRoot, "contract")), ...walk(join(repoRoot, "checklists"))];
    assert.ok(files.length > 0, "there are files to scan");
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      assert.ok(!text.includes("sig="), `${relative(repoRoot, file).split(sep).join("/")} contains a signed URL`);
    }
  });
});
