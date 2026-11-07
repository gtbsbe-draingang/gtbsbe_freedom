// Transcript domain: time, normalisation, upload parsing, fingerprints, PRNG.
// Fixtures are invented inline; the system-event texts are the pinned DEV phrases.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatOffset, offsets, parseTimestamp } from "../../src/domain/time.js";
import { UploadError, normalizeRecord, parseUpload } from "../../src/domain/normalize.js";
import {
  fingerprint,
  sha256Hex,
  sha256HexPure,
  transcriptHash,
} from "../../src/domain/fingerprint.js";
import { fnv1a32, seeded } from "../../src/domain/prng.js";

const line = (timestamp, speaker, text) => ({ timestamp, speaker, text });

// A chat shaped like the contract example: bot phase, handover, operator, identity, close.
function chatRecord() {
  return {
    conversation_id: "p1-ru-001",
    channel: "agent chat",
    language: "RU",
    audio_url: null,
    transcript: [
      line("00:00", "client", "Здравствуйте, не могу войти в приложение"), // 0
      line("00:05", "bot", "Здравствуйте! Я помощник. Чем могу помочь?"), // 1
      line("00:20", "client", "Нужен оператор"), // 2
      line("00:22", "system", "Эскалация на оператора"), // 3
      line("00:30", "client", "Алло?"), // 4 (waits 29 s for the operator's first reply)
      line("00:59", "operator", "Здравствуйте, меня зовут Айгерим"), // 5
      line("01:10", "client", "Не открывается приложение"), // 6
      line("01:50", "operator", "Сейчас проверим"), // 7  (waited 40 s)
      line("02:00", "system", "Личность клиента подтверждена"), // 8
      line("02:10", "client", "Спасибо"), // 9
      line("02:12", "client", "И ещё вопрос"), // 10
      line("02:20", "operator", "Слушаю"), // 11  (waited 10 s)
      line("02:30", "system", "Оператор закрыл чат"), // 12
    ],
  };
}

describe("time", () => {
  test("clock and iso parsing", () => {
    assert.deepEqual(parseTimestamp("01:05"), { kind: "clock", seconds: 65 });
    assert.deepEqual(parseTimestamp("1:02:05"), { kind: "clock", seconds: 3725 });
    assert.deepEqual(parseTimestamp("00:00"), { kind: "clock", seconds: 0 });
    const iso = parseTimestamp("2025-03-04T10:00:00.250+05:00");
    assert.equal(iso.kind, "iso");
    assert.equal(iso.epochMs, Date.parse("2025-03-04T10:00:00.250+05:00"));
    assert.equal(parseTimestamp("2025-03-04T05:00:00Z").epochMs, Date.UTC(2025, 2, 4, 5, 0, 0));
  });

  test("iso keeps sub-millisecond digits beyond three (7 fractional digits)", () => {
    const a = parseTimestamp("2025-03-04T10:00:00.0000000+05:00");
    const b = parseTimestamp("2025-03-04T10:00:09.1450000+05:00");
    assert.equal(a.kind, "iso");
    assert.ok(Math.abs(b.epochMs - a.epochMs - 9145) < 0.01);
  });

  test("garbage is unknown, never throws", () => {
    for (const bad of ["yesterday", "", "99", "1:2", "00:75", "2025-13-45T00:00:00Z", null, undefined, 12]) {
      assert.deepEqual(parseTimestamp(bad), { kind: "unknown" }, String(bad));
    }
  });

  test("offsets from first line, null for unknown", () => {
    const tr = [line("00:10", "client", "a"), line("yesterday", "client", "b"), line("01:15", "operator", "c")];
    assert.deepEqual(offsets(tr), [0, null, 65]);
    // The first line is unparsable: the base is the first parsable line.
    assert.deepEqual(offsets([line("?", "client", "a"), line("00:05", "client", "b"), line("00:08", "client", "c")]), [
      null,
      0,
      3,
    ]);
    assert.deepEqual(offsets([]), []);
  });

  test("offsets work for iso lines and ignore lines of another kind", () => {
    const tr = [
      line("2025-03-04T10:00:00.000+05:00", "client", "a"),
      line("2025-03-04T10:00:09.145+05:00", "operator", "b"),
      line("00:30", "operator", "c"),
    ];
    const o = offsets(tr);
    assert.equal(o[0], 0);
    assert.ok(Math.abs(o[1] - 9.145) < 1e-6);
    assert.equal(o[2], null);
  });

  test("formatOffset", () => {
    assert.equal(formatOffset(65), "1:05");
    assert.equal(formatOffset(3725), "1:02:05");
    assert.equal(formatOffset(0), "0:00");
    assert.equal(formatOffset(59.9), "0:59");
    assert.equal(formatOffset(null), "");
    assert.equal(formatOffset(NaN), "");
  });
});

describe("normalizeRecord", () => {
  test("drops audio_url and builds id DEV:p1-ru-001", () => {
    const rec = { ...chatRecord(), audio_url: "https://example.test/a.mp3?sig=SECRET" };
    const conv = normalizeRecord(rec, "DEV");
    assert.equal(conv.id, "DEV:p1-ru-001");
    assert.equal(conv.conversation_id, "p1-ru-001");
    assert.equal(conv.group_id, "DEV");
    assert.equal(conv.status, "new");
    assert.ok(!("audio_url" in conv));
    assert.ok(!JSON.stringify(conv).includes("SECRET"));
    assert.equal(conv.transcript.length, 13);
    // The input is not mutated.
    assert.equal(rec.audio_url, "https://example.test/a.mp3?sig=SECRET");
    assert.ok(!("duplicate" in rec.transcript[0]));
  });

  test("call without known audio: audio null, reason needs_import; chat: reason none", () => {
    const call = { conversation_id: "p4-ru-001", channel: "voice call", language: "RU", transcript: [] };
    const a = normalizeRecord(call, "DEV");
    assert.equal(a.audio, null);
    assert.equal(a.audio_unavailable_reason, "needs_import");
    const b = normalizeRecord(call, "DEV", { audioPathFor: () => null });
    assert.equal(b.audio, null);
    assert.equal(b.audio_unavailable_reason, "needs_import");
    const chat = normalizeRecord(chatRecord(), "DEV", { audioPathFor: () => "conversations/x/audio" });
    assert.equal(chat.audio, null);
    assert.equal(chat.audio_unavailable_reason, "none");
  });

  test("call with known audio gets the path; audioPathFor receives the plain id then the full id", () => {
    const seen = [];
    const call = { conversation_id: "p4-ru-001", channel: "voice call", language: "RU", transcript: [] };
    const conv = normalizeRecord(call, "DEV", {
      audioPathFor: (...args) => {
        seen.push(args);
        return "conversations/DEV:p4-ru-001/audio";
      },
    });
    assert.equal(conv.audio, "conversations/DEV:p4-ru-001/audio");
    assert.equal(conv.audio_unavailable_reason, null);
    assert.deepEqual(seen, [["p4-ru-001", "DEV:p4-ru-001"]]);
  });

  test("duplicates marked: consecutive exact duplicates only", () => {
    const rec = {
      conversation_id: "d1",
      channel: "agent chat",
      language: "EN",
      transcript: [
        line("00:01", "client", "hello"),
        line("00:01", "client", "hello"), // duplicate
        line("00:02", "client", "hello"), // other timestamp: kept
        line("00:02", "operator", "hello"), // other speaker: kept
        line("00:02", "operator", "hello"), // duplicate
        line("00:03", "client", "hello"),
      ],
    };
    const tr = normalizeRecord(rec, "DEV").transcript;
    assert.deepEqual(
      tr.map((m) => m.duplicate === true),
      [false, true, false, false, true, false],
    );
    assert.equal(tr.filter((m) => m.duplicate).length, 2);
  });

  test("facts on the contract chat example", () => {
    const f = normalizeRecord(chatRecord(), "DEV").facts;
    assert.deepEqual(f, {
      operator_joined_index: 5,
      first_reaction_seconds: 37,
      longest_wait_seconds: 40,
      identity_verified_index: 8,
      ending: "operator_closed",
    });
  });

  test("facts on a call with iso timestamps", () => {
    const rec = {
      conversation_id: "p4-ru-001",
      channel: "voice call",
      language: "RU",
      transcript: [
        line("2025-03-04T10:00:00.0000000+05:00", "client", "Алло"),
        line("2025-03-04T10:00:05.0000000+05:00", "system", "Агент присоединился к разговору с клиентом."),
        line("2025-03-04T10:00:14.1450000+05:00", "operator", "Добрый день"),
        line("2025-03-04T10:00:20.0000000+05:00", "client", "Вопрос по карте"),
        line("2025-03-04T10:00:52.7000000+05:00", "operator", "Да, слушаю"),
        line("2025-03-04T10:01:00.0000000+05:00", "system", "Клиент завершил разговор"),
        line("2025-03-04T10:01:01.0000000+05:00", "client", "Спасибо"),
      ],
    };
    const f = normalizeRecord(rec, "DEV").facts;
    assert.equal(f.operator_joined_index, 2);
    assert.ok(Math.abs(f.first_reaction_seconds - 9.145) < 1e-3);
    assert.ok(Math.abs(f.longest_wait_seconds - 32.7) < 1e-3);
    assert.equal(f.identity_verified_index, null);
    assert.equal(f.ending, "client_ended_call"); // although the last line is a client line
  });

  test("Review Focus 1: empty transcript gives null facts and no throw", () => {
    const rec = { conversation_id: "e1", channel: "agent chat", language: "RU", transcript: [] };
    const conv = normalizeRecord(rec, "CTRL");
    assert.deepEqual(conv.transcript, []);
    assert.deepEqual(conv.facts, {
      operator_joined_index: null,
      first_reaction_seconds: null,
      longest_wait_seconds: null,
      identity_verified_index: null,
      ending: "normal",
    });
  });

  test("Review Focus 1: unknown speaker kept as is; unknown timestamp does not break facts", () => {
    const rec = {
      conversation_id: "u1",
      channel: "agent chat",
      language: "KZ",
      transcript: [
        line("yesterday", "agent", "Сәлем"),
        line("00:03", "operator", "Сәлем"),
        line("00:05", "client", "Қайырлы күн"),
        line("00:11", "operator", "Тыңдап тұрмын"),
      ],
    };
    const conv = normalizeRecord(rec, "CTRL");
    assert.equal(conv.transcript[0].speaker, "agent");
    assert.equal(conv.transcript[0].timestamp, "yesterday");
    assert.equal(conv.facts.operator_joined_index, 1);
    assert.equal(conv.facts.longest_wait_seconds, 6);
    assert.equal(conv.facts.first_reaction_seconds, null); // no handover line
  });

  test("handover texts in all three languages, identity and endings", () => {
    const mk = (...sys) => ({
      conversation_id: "x",
      channel: "agent chat",
      language: "RU",
      transcript: [line("00:00", "client", "hi"), ...sys.map((s, i) => line(`00:0${i + 1}`, "system", s)), line("00:09", "operator", "op")],
    });
    for (const h of ["Чат операторға жіберілді", "Chat transferred to an agent", "Эскалация на оператора"]) {
      assert.equal(normalizeRecord(mk(h), "G").facts.first_reaction_seconds, 8, h);
    }
    assert.equal(normalizeRecord(mk("Клиенттің жеке басы расталды"), "G").facts.identity_verified_index, 1);
    assert.equal(normalizeRecord(mk("Customer identity verified"), "G").facts.identity_verified_index, 1);
    const ending = (text) => normalizeRecord(mk(text), "G").facts.ending;
    assert.equal(ending("Оператор чатты жапты"), "operator_closed");
    assert.equal(ending("Agent closed the chat"), "operator_closed");
    assert.equal(ending("Клиент покинул чат"), "client_left");
    assert.equal(ending("Соединение с клиентом прервано"), "connection_lost");
    assert.equal(ending("Клиентпен байланыс үзілді"), "connection_lost");
    assert.equal(ending("Connection to customer lost"), "connection_lost");
    assert.equal(ending("Клиент завершил разговор"), "client_ended_call");
    assert.equal(ending("Что-то другое"), "normal");
  });

  test("no handover: operator_joined_index is the first operator line; handover without operator: null", () => {
    const noHandover = {
      conversation_id: "n1",
      channel: "agent chat",
      language: "EN",
      transcript: [line("00:00", "bot", "hi"), line("00:02", "operator", "hello"), line("00:04", "operator", "again")],
    };
    assert.equal(normalizeRecord(noHandover, "G").facts.operator_joined_index, 1);
    const none = {
      conversation_id: "n2",
      channel: "agent chat",
      language: "EN",
      transcript: [line("00:00", "client", "hi"), line("00:02", "system", "Chat transferred to an agent")],
    };
    const f = normalizeRecord(none, "G").facts;
    assert.equal(f.operator_joined_index, null);
    assert.equal(f.longest_wait_seconds, null);
    assert.equal(f.first_reaction_seconds, null);
  });

  test("longest wait ignores the bot phase", () => {
    const rec = {
      conversation_id: "w1",
      channel: "agent chat",
      language: "RU",
      transcript: [
        line("00:00", "client", "вопрос"), // 0
        line("00:10", "bot", "ответ бота"), // 1  (bot phase: not an operator reply)
        line("01:00", "client", "ещё вопрос"), // 2  (bot phase: ignored even though 100 s pass)
        line("01:30", "system", "Эскалация на оператора"), // 3
        line("01:32", "client", "жду оператора"), // 4  (after the handover: waits 8 s)
        line("01:40", "operator", "Здравствуйте"), // 5
        line("01:50", "client", "проблема"), // 6
        line("01:55", "operator", "понял"), // 7  (waited 5 s)
      ],
    };
    const f = normalizeRecord(rec, "G").facts;
    assert.equal(f.longest_wait_seconds, 8);
    assert.equal(f.first_reaction_seconds, 10);
  });

  test("a client line between the handover and the operator's first reply counts as waiting", () => {
    const rec = {
      conversation_id: "w3",
      channel: "agent chat",
      language: "RU",
      transcript: [
        line("00:05", "client", "вопрос"), // 0  (before the handover: ignored)
        line("00:10", "system", "Эскалация на оператора"), // 1
        line("00:11", "client", "я жду"), // 2
        line("00:47", "operator", "Здравствуйте"), // 3
      ],
    };
    const f = normalizeRecord(rec, "G").facts;
    assert.equal(f.longest_wait_seconds, 36);
    assert.equal(f.first_reaction_seconds, 37);
  });

  test("without a handover the scan starts at the operator's first line", () => {
    const rec = {
      conversation_id: "w4",
      channel: "agent chat",
      language: "RU",
      transcript: [
        line("00:00", "client", "вопрос"), // 0  (before the first operator line: not counted)
        line("00:50", "operator", "Здравствуйте"), // 1
        line("01:00", "client", "ещё"), // 2
        line("01:07", "operator", "да"), // 3  (waited 7 s)
      ],
    };
    const f = normalizeRecord(rec, "G").facts;
    assert.equal(f.operator_joined_index, 1);
    assert.equal(f.longest_wait_seconds, 7);
  });

  test("a client line that no operator answers is not a wait", () => {
    const answeredNever = {
      conversation_id: "w2",
      channel: "agent chat",
      language: "RU",
      transcript: [
        line("00:00", "system", "Эскалация на оператора"),
        line("00:10", "operator", "Здравствуйте"),
        line("00:20", "client", "вопрос"),
        line("00:30", "system", "Соединение с клиентом прервано"),
      ],
    };
    const f = normalizeRecord(answeredNever, "G").facts;
    assert.equal(f.longest_wait_seconds, null);
    assert.equal(f.ending, "connection_lost");
    // A client line after the handover with no operator line at all: still no wait.
    const noOperator = {
      conversation_id: "w5",
      channel: "agent chat",
      language: "RU",
      transcript: [
        line("00:00", "system", "Эскалация на оператора"),
        line("00:05", "client", "алло"),
        line("00:30", "system", "Клиент покинул чат"),
      ],
    };
    const g = normalizeRecord(noOperator, "G").facts;
    assert.equal(g.longest_wait_seconds, null);
    assert.equal(g.operator_joined_index, null);
    assert.equal(g.ending, "client_left");
  });

  test("defensive: odd lines and missing transcript never throw", () => {
    const conv = normalizeRecord(
      { conversation_id: "o1", channel: "agent chat", language: "RU", transcript: [null, 5, { text: "x" }] },
      "G",
    );
    assert.equal(conv.transcript.length, 3);
    assert.ok(conv.transcript.every((m) => typeof m.timestamp === "string" && typeof m.text === "string"));
    const none = normalizeRecord({ conversation_id: "o2", channel: "agent chat", language: "RU" }, "G");
    assert.deepEqual(none.transcript, []);
  });
});

describe("parseUpload", () => {
  const rec = (id, extra = {}) => ({
    conversation_id: id,
    channel: "agent chat",
    language: "RU",
    transcript: [line("00:00", "client", "hi")],
    ...extra,
  });

  test("accepts all four shapes", () => {
    const single = parseUpload(JSON.stringify(rec("a")));
    assert.equal(single.records.length, 1);
    assert.equal(single.groupHint, null);

    const arr = parseUpload(JSON.stringify([rec("a"), rec("b")]));
    assert.deepEqual(arr.records.map((r) => r.conversation_id), ["a", "b"]);
    assert.equal(arr.groupHint, null);

    const wrapped = parseUpload(JSON.stringify({ records: [rec("a"), rec("b"), rec("c")] }));
    assert.equal(wrapped.records.length, 3);
    assert.equal(wrapped.groupHint, null);

    const full = parseUpload(
      JSON.stringify({ error: null, isSuccess: true, data: { dataset_group_id: "DEV", total_records: 2, records: [rec("a"), rec("b")] } }),
    );
    assert.equal(full.records.length, 2);
    assert.equal(full.groupHint, "DEV");
  });

  test("tolerates a BOM and surrounding whitespace", () => {
    const out = parseUpload("\uFEFF  " + JSON.stringify(rec("a")) + "\n");
    assert.equal(out.records.length, 1);
  });

  test("reports not_json, no_records and bad_record:<index>", () => {
    const code = (text) => {
      try {
        parseUpload(text);
      } catch (e) {
        assert.ok(e instanceof UploadError, "UploadError");
        assert.ok(e instanceof Error);
        return e.code;
      }
      return "no throw";
    };
    assert.equal(code("not json at all"), "not_json");
    assert.equal(code(""), "not_json");
    assert.equal(code("[]"), "no_records");
    assert.equal(code("{}"), "no_records");
    assert.equal(code('{"records": []}'), "no_records");
    assert.equal(code('{"error":"x","isSuccess":false,"data":null}'), "no_records");
    assert.equal(code("42"), "no_records");
    assert.equal(code("null"), "no_records");
    const { language, ...noLanguage } = rec("b");
    assert.equal(code(JSON.stringify([rec("a"), noLanguage])), "bad_record:1");
    const { channel, ...noChannel } = rec("a");
    assert.equal(code(JSON.stringify([noChannel])), "bad_record:0");
    const { conversation_id, ...noId } = rec("a");
    assert.equal(code(JSON.stringify({ records: [rec("a"), rec("b"), noId] })), "bad_record:2");
    assert.equal(code(JSON.stringify([rec("a", { transcript: "oops" })])), "bad_record:0");
    assert.equal(code(JSON.stringify([rec("a", { transcript: null })])), "bad_record:0");
    assert.equal(code(JSON.stringify([rec("a"), null])), "bad_record:1");
    assert.equal(code(JSON.stringify([rec("a", { conversation_id: "" })])), "bad_record:0");
  });

  test("R7: an empty transcript array is accepted", () => {
    const out = parseUpload(JSON.stringify([rec("a", { transcript: [] })]));
    assert.equal(out.records.length, 1);
  });

  test("records are returned as parsed (audio_url is dropped later, by normalizeRecord)", () => {
    const out = parseUpload(JSON.stringify([rec("a", { audio_url: "https://x/y" })]));
    assert.equal(out.records[0].audio_url, "https://x/y");
    assert.ok(!("audio_url" in normalizeRecord(out.records[0], "upload-1")));
  });
});

describe("fingerprint", () => {
  const official = {
    title: "Установление контакта",
    wording: "Да — оператор поздоровался на языке клиента и представился в первом ответе.",
    answer_type: "yes_no",
    scale_steps: [],
    na_allowed: false,
    na_condition: null,
    kind: "scored",
    kinds: [],
    guidance: null,
  };

  test("fingerprint cross-stream vector", async () => {
    assert.equal(
      await fingerprint(official),
      "ace5cc7a0b747465ba875ad6dbd6a653dcac2d04490a4c66304a7a6bd339516b",
    );
  });

  test("missing fields are null, scale_steps and kinds default to []", async () => {
    const sparse = { title: official.title, wording: official.wording, answer_type: "yes_no", na_allowed: false, kind: "scored" };
    assert.equal(await fingerprint(sparse), await fingerprint(official));
  });

  test("missing kind fingerprints as scored", async () => {
    const { kind, ...withoutKind } = official;
    assert.equal(await fingerprint(withoutKind), await fingerprint({ ...official, kind: "scored" }));
  });

  test("stable under key order, changes when wording or kind changes, ignores weight, order and model", async () => {
    const base = await fingerprint(official);
    const shuffled = Object.fromEntries(Object.entries(official).reverse());
    assert.equal(await fingerprint(shuffled), base);
    assert.notEqual(await fingerprint({ ...official, wording: official.wording + " " }), base);
    assert.notEqual(await fingerprint({ ...official, kind: "gross_error" }), base);
    assert.notEqual(await fingerprint({ ...official, kinds: ["abuse"] }), base);
    assert.notEqual(await fingerprint({ ...official, guidance: "g" }), base);
    assert.equal(
      await fingerprint({ ...official, weight: 12, order: 7, model: "claude-x", id: "c99", section_id: "s9", fingerprint: "zzz" }),
      base,
    );
  });

  test("scale steps: key order inside a step is irrelevant, content matters", async () => {
    const scale = { ...official, answer_type: "scale", scale_steps: [{ value: 15, label: "Полностью" }, { value: 0, label: "Нет" }] };
    const flipped = { ...scale, scale_steps: [{ label: "Полностью", value: 15 }, { label: "Нет", value: 0 }] };
    assert.equal(await fingerprint(flipped), await fingerprint(scale));
    const changed = { ...scale, scale_steps: [{ value: 10, label: "Полностью" }, { value: 0, label: "Нет" }] };
    assert.notEqual(await fingerprint(changed), await fingerprint(scale));
  });

  test("transcriptHash ignores the duplicate flag and extra fields, reacts to text", async () => {
    const a = [line("00:00", "client", "привет"), line("00:01", "operator", "здравствуйте")];
    const b = a.map((m) => ({ ...m, duplicate: true, extra: 1 }));
    assert.equal(await transcriptHash(a), await transcriptHash(b));
    const c = [line("00:00", "client", "привет!"), a[1]];
    assert.notEqual(await transcriptHash(a), await transcriptHash(c));
    assert.match(await transcriptHash([]), /^[0-9a-f]{64}$/);
    // Canonical form is [{"speaker":...,"text":...,"timestamp":...}] with sorted keys.
    const expected = await sha256Hex('[{"speaker":"client","text":"привет","timestamp":"00:00"}]');
    assert.equal(await transcriptHash([line("00:00", "client", "привет")]), expected);
  });

  test("pure-JS SHA-256 agrees with crypto.subtle (known vectors and non-ASCII)", async () => {
    assert.equal(sha256HexPure(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(sha256HexPure("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (const s of ["Установление контакта — Да", "a".repeat(1000), "😀 emoji", "x".repeat(55), "x".repeat(56), "x".repeat(64)]) {
      assert.equal(sha256HexPure(s), await sha256Hex(s), s.slice(0, 12));
    }
  });
});

describe("prng", () => {
  test("fnv1a32 known vectors", () => {
    assert.equal(fnv1a32(""), 0x811c9dc5);
    assert.equal(fnv1a32("a"), 0xe40c292c);
    assert.equal(fnv1a32("foobar"), 0xbf9cf968);
  });

  test("seeded is deterministic", () => {
    const a = seeded("p1-ru-001:c01");
    const b = seeded("p1-ru-001:c01");
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    assert.deepEqual(seqA, seqB);
    assert.ok(seqA.every((x) => x >= 0 && x < 1));
    assert.ok(new Set(seqA).size > 15);
    const c = seeded("another seed");
    assert.notDeepEqual(
      seqA,
      Array.from({ length: 20 }, () => c()),
    );
  });

  test("seeded sequence is pinned (mulberry32 over the FNV-1a seed; checked against a Python reference)", () => {
    const r = seeded("abc");
    assert.deepEqual([r(), r(), r()], [0.5166419988963753, 0.6596221292857081, 0.0018796597141772509]);
  });
});
