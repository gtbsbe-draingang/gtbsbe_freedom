(() => {
  // package.json
  var version = "0.1.0";

  // src/api/errors.js
  var CLIENT_CODES = Object.freeze(["network", "timeout", "bad_response"]);
  var ApiError = class extends Error {
    /**
     * @param {string} code
     * @param {string} message
     * @param {{status?: number | null, retryable?: boolean, cause?: unknown}} [options]
     *   `retryable` defaults to true for "network", "timeout" and any 5xx status, false otherwise.
     */
    constructor(code, message, { status = null, retryable, cause } = {}) {
      super(message, cause === void 0 ? void 0 : { cause });
      this.name = "ApiError";
      this.code = code;
      this.status = status;
      this.retryable = retryable ?? (code === "network" || code === "timeout" || status !== null && status >= 500);
    }
  };

  // src/api/http.js
  var ROLES = /* @__PURE__ */ new Set(["controller", "reviewer"]);
  var HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
  var HTTP_URL = /^https?:\/\//i;
  function seg(value, name = "path segment") {
    if (value === void 0 || value === null || value === "") {
      throw new TypeError(`API call is missing ${name}`);
    }
    return encodeURIComponent(String(value));
  }
  function query(params, keys) {
    const search = new URLSearchParams();
    for (const key of keys) {
      const value = params?.[key];
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) {
        if (v === void 0 || v === null || v === "") continue;
        search.append(key, String(v));
      }
    }
    const text2 = search.toString();
    return text2 ? `?${text2}` : "";
  }
  function createHttpApi({ apiBase, role, fetchImpl = globalThis.fetch, timeoutMs = 3e4 } = {}) {
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
      if (body !== void 0) {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      let response;
      let text2;
      try {
        const doFetch = fetchImpl;
        response = await doFetch(`${base}/${path}`, init);
        text2 = await response.text();
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
        data = JSON.parse(text2);
        parsed = true;
      } catch {
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
    function resolve(rel) {
      if (isAbsolute) {
        const url = new URL(rel, `${base}/`);
        return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
      }
      if (HAS_SCHEME.test(rel)) return HTTP_URL.test(rel) ? rel : null;
      return rel.startsWith("/") ? rel : `${base}/${rel}`;
    }
    return {
      getConfig: async () => get("config"),
      importDataset: async (groupId) => get(`datasets/${seg(groupId, "group_id")}`),
      uploadConversations: async (payload) => post("conversations", Array.isArray(payload) ? { records: payload } : payload),
      listConversations: async (filters = {}) => get(`conversations${query(filters, ["group_id", "status", "channel", "language", "q"])}`),
      getConversation: async (id) => get(`conversations/${seg(id, "conversation id")}`),
      audioUrl: (conversation) => {
        const audio = conversation?.audio;
        return typeof audio === "string" && audio !== "" ? resolve(audio) : null;
      },
      getTranslation: async (id, to = "ru") => get(`conversations/${seg(id, "conversation id")}/translation${query({ to }, ["to"])}`),
      listChecklists: async () => get("checklists"),
      getChecklistVersion: async (checklistId, version2) => get(`checklists/${seg(checklistId, "checklist id")}/versions/${seg(version2, "version")}`),
      createChecklist: async (body) => post("checklists", body),
      saveChecklistVersion: async (checklistId, body) => post(`checklists/${seg(checklistId, "checklist id")}/versions`, body),
      startEvaluations: async ({ conversations, checklist_id, version: version2, mode = "reuse", dry_run = false } = {}) => post("evaluations", { conversations, checklist_id, version: version2, mode, dry_run }),
      getJob: async (id) => get(`jobs/${seg(id, "job id")}`),
      retryJob: async (id) => post(`jobs/${seg(id, "job id")}/retry`),
      listEvaluations: async (filters = {}) => get(`evaluations${query(filters, ["conversation", "checklist_id"])}`),
      getEvaluation: async (id) => get(`evaluations/${seg(id, "evaluation id")}`),
      fileAppeal: async ({ evaluation_id, criterion_id, comment } = {}) => post("appeals", { evaluation_id, criterion_id, comment }),
      listAppeals: async (filters = {}) => get(`appeals${query(filters, ["status"])}`),
      getAppeal: async (id) => get(`appeals/${seg(id, "appeal id")}`),
      decideAppeal: async (id, { outcome, answer, reason } = {}) => post(`appeals/${seg(id, "appeal id")}/decision`, { outcome, answer, reason }),
      getComparison: async (params = {}) => get(
        `comparisons${query(params, [
          "from_checklist",
          "from_version",
          "to_checklist",
          "to_version",
          "group_id",
          "conversations"
        ])}`
      ),
      getAccuracy: async () => get("reports/accuracy"),
      getAnalytics: async () => get("analytics"),
      exportCsvUrl: (groupId) => `${base}/export.csv${query({ group_id: groupId }, ["group_id"])}`
    };
  }

  // src/domain/fingerprint.js
  function canonicalJson(value) {
    if (Array.isArray(value)) {
      return "[" + value.map((item) => canonicalJson(item === void 0 ? null : item)).join(",") + "]";
    }
    if (value !== null && typeof value === "object") {
      const keys = Object.keys(value).filter((key) => value[key] !== void 0).sort();
      return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
    }
    return JSON.stringify(value);
  }
  var toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  var PRIMES = [];
  for (let n = 2; PRIMES.length < 64; n += 1) {
    if (PRIMES.every((p) => n % p !== 0)) PRIMES.push(n);
  }
  var frac32 = (x) => Math.floor((x - Math.floor(x)) * 4294967296) >>> 0;
  var K = PRIMES.map((p) => frac32(Math.cbrt(p)));
  var H0 = PRIMES.slice(0, 8).map((p) => frac32(Math.sqrt(p)));
  function sha256HexPure(str) {
    const bytes = new TextEncoder().encode(String(str));
    const length = bytes.length;
    const padded = new Uint8Array(length + 9 + 63 >> 6 << 6);
    padded.set(bytes);
    padded[length] = 128;
    const view = new DataView(padded.buffer);
    const bits = length * 8;
    view.setUint32(padded.length - 8, Math.floor(bits / 4294967296));
    view.setUint32(padded.length - 4, bits >>> 0);
    const h2 = Uint32Array.from(H0);
    const w = new Uint32Array(64);
    const rotr = (x, n) => x >>> n | x << 32 - n;
    for (let offset = 0; offset < padded.length; offset += 64) {
      for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
      for (let i = 16; i < 64; i += 1) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ w[i - 15] >>> 3;
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ w[i - 2] >>> 10;
        w[i] = w[i - 16] + s0 + w[i - 7] + s1 | 0;
      }
      let [a, b, c, d, e, f, g, hh] = h2;
      for (let i = 0; i < 64; i += 1) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = e & f ^ ~e & g;
        const t1 = hh + S1 + ch + K[i] + w[i] | 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = a & b ^ a & c ^ b & c;
        const t2 = S0 + maj | 0;
        hh = g;
        g = f;
        f = e;
        e = d + t1 | 0;
        d = c;
        c = b;
        b = a;
        a = t1 + t2 | 0;
      }
      h2[0] += a;
      h2[1] += b;
      h2[2] += c;
      h2[3] += d;
      h2[4] += e;
      h2[5] += f;
      h2[6] += g;
      h2[7] += hh;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    h2.forEach((word, i) => outView.setUint32(i * 4, word));
    return toHex(out);
  }
  async function sha256Hex(str) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (subtle) {
      const digest = await subtle.digest("SHA-256", new TextEncoder().encode(String(str)));
      return toHex(new Uint8Array(digest));
    }
    return sha256HexPure(str);
  }
  var orNull = (value) => value === void 0 ? null : value;
  function fingerprint(criterion) {
    const c = criterion || {};
    const subset = {
      title: orNull(c.title),
      wording: orNull(c.wording),
      answer_type: orNull(c.answer_type),
      scale_steps: (Array.isArray(c.scale_steps) ? c.scale_steps : []).map((step) => ({
        value: orNull(step && step.value),
        label: orNull(step && step.label)
      })),
      na_allowed: orNull(c.na_allowed),
      na_condition: orNull(c.na_condition),
      kind: orNull(c.kind),
      kinds: Array.isArray(c.kinds) ? c.kinds : [],
      guidance: orNull(c.guidance)
    };
    return sha256Hex(canonicalJson(subset));
  }
  function transcriptHash(transcript) {
    const lines = (Array.isArray(transcript) ? transcript : []).map((m) => ({
      timestamp: orNull(m && m.timestamp),
      speaker: orNull(m && m.speaker),
      text: orNull(m && m.text)
    }));
    return sha256Hex(canonicalJson(lines));
  }

  // src/domain/time.js
  var CLOCK_MS = /^(\d{1,3}):([0-5]\d)$/;
  var CLOCK_HMS = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/;
  var ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
  var UNKNOWN = Object.freeze({ kind: "unknown" });
  function parseTimestamp(ts) {
    if (typeof ts !== "string") return { ...UNKNOWN };
    const text2 = ts.trim();
    let m = CLOCK_MS.exec(text2);
    if (m) return { kind: "clock", seconds: Number(m[1]) * 60 + Number(m[2]) };
    m = CLOCK_HMS.exec(text2);
    if (m) return { kind: "clock", seconds: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) };
    m = ISO.exec(text2);
    if (!m) return { ...UNKNOWN };
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const second = m[6] === void 0 ? 0 : Number(m[6]);
    if (year < 1e3 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
      return { ...UNKNOWN };
    }
    if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return { ...UNKNOWN };
    let offsetMinutes = 0;
    const zone = m[8];
    if (zone && zone.toUpperCase() !== "Z") {
      const digits = zone.slice(1).replace(":", "");
      const zh = Number(digits.slice(0, 2));
      const zm = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
      if (zh > 23 || zm > 59) return { ...UNKNOWN };
      offsetMinutes = (zone[0] === "-" ? -1 : 1) * (zh * 60 + zm);
    }
    const fractionMs = m[7] ? Number("0." + m[7]) * 1e3 : 0;
    const epochMs = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 6e4 + fractionMs;
    return { kind: "iso", epochMs };
  }
  function offsets(transcript) {
    const lines = Array.isArray(transcript) ? transcript : [];
    const parsed = lines.map((m) => parseTimestamp(m == null ? void 0 : m.timestamp));
    const base = parsed.find((p) => p.kind !== "unknown");
    if (!base) return parsed.map(() => null);
    return parsed.map((p) => {
      if (p.kind !== base.kind) return null;
      return p.kind === "clock" ? p.seconds - base.seconds : (p.epochMs - base.epochMs) / 1e3;
    });
  }

  // src/domain/normalize.js
  var HANDOVER = /^(Эскалация на оператора|Чат операторға жіберілді|Chat transferred to an agent|Агент присоединился к разговору)/;
  var IDENTITY = /^(Личность клиента подтверждена|Клиенттің жеке басы расталды|Customer identity verified)/;
  var ENDINGS = [
    ["operator_closed", /^(Оператор закрыл чат|Оператор чатты жапты|Agent closed the chat)/],
    ["client_left", /^(Клиент покинул чат|Customer left the chat)/],
    ["connection_lost", /^(Соединение с клиентом прервано|Клиентпен байланыс үзілді|Connection to customer lost)/],
    ["client_ended_call", /^Клиент завершил разговор/]
  ];
  var textOf = (m) => m && typeof m.text === "string" ? m.text : "";
  var speakerOf = (m) => m ? m.speaker : void 0;
  var diff = (off, from, to) => {
    const a = off[from];
    const b = off[to];
    return a == null || b == null || b < a ? null : b - a;
  };
  function computeFacts(transcript) {
    const lines = Array.isArray(transcript) ? transcript : [];
    const off = offsets(lines);
    let handover = -1;
    let identity = -1;
    let ending = "normal";
    lines.forEach((m, i) => {
      if (speakerOf(m) !== "system") return;
      const text2 = textOf(m);
      if (handover < 0 && HANDOVER.test(text2)) handover = i;
      if (identity < 0 && IDENTITY.test(text2)) identity = i;
      for (const [kind, pattern] of ENDINGS) if (pattern.test(text2)) ending = kind;
    });
    let joined = -1;
    for (let i = handover + 1; i < lines.length; i += 1) {
      if (speakerOf(lines[i]) === "operator") {
        joined = i;
        break;
      }
    }
    let longestWait = null;
    if (joined >= 0) {
      let pending2 = -1;
      for (let i = handover >= 0 ? handover + 1 : joined; i < lines.length; i += 1) {
        const speaker = speakerOf(lines[i]);
        if (speaker === "client" && pending2 < 0) {
          pending2 = i;
        } else if (speaker === "operator" && pending2 >= 0) {
          const wait = diff(off, pending2, i);
          if (wait !== null && (longestWait === null || wait > longestWait)) longestWait = wait;
          pending2 = -1;
        }
      }
    }
    return {
      operator_joined_index: joined >= 0 ? joined : null,
      first_reaction_seconds: handover >= 0 && joined >= 0 ? diff(off, handover, joined) : null,
      longest_wait_seconds: longestWait,
      identity_verified_index: identity >= 0 ? identity : null,
      ending
    };
  }
  var asText = (value) => typeof value === "string" ? value : value == null ? "" : String(value);
  function cleanLine(raw) {
    if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
      return { ...raw, timestamp: asText(raw.timestamp), speaker: asText(raw.speaker), text: asText(raw.text) };
    }
    return { timestamp: "", speaker: "", text: asText(raw) };
  }
  function markDuplicates(lines) {
    return lines.map((m, i) => {
      const prev = lines[i - 1];
      const same = i > 0 && m.timestamp === prev.timestamp && m.speaker === prev.speaker && m.text === prev.text;
      return same || m.duplicate === true ? { ...m, duplicate: true } : m;
    });
  }
  function normalizeRecord(record, groupId, options = {}) {
    const { audio_url: _signedLink, transcript: rawTranscript, ...rest } = record;
    const id = `${groupId}:${record.conversation_id}`;
    const transcript = markDuplicates((Array.isArray(rawTranscript) ? rawTranscript : []).map(cleanLine));
    const isCall = record.channel === "voice call";
    const path = isCall && options.audioPathFor ? options.audioPathFor(record.conversation_id, id) : null;
    const audio = path || null;
    return {
      ...rest,
      id,
      group_id: groupId,
      status: "new",
      transcript,
      facts: computeFacts(transcript),
      audio,
      audio_unavailable_reason: audio ? null : isCall ? "needs_import" : "none"
    };
  }
  var UploadError = class extends Error {
    /** @param {string} code */
    constructor(code) {
      super(code);
      this.name = "UploadError";
      this.code = code;
    }
  };
  var isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  var nonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
  var RECORD_KEYS = ["conversation_id", "channel", "language", "transcript"];
  function locate(data) {
    if (Array.isArray(data)) return { list: data, groupHint: null };
    if (!isObject(data)) return { list: [], groupHint: null };
    const hint = (holder) => nonEmptyString(holder.dataset_group_id) ? holder.dataset_group_id : null;
    if (Array.isArray(data.records)) return { list: data.records, groupHint: hint(data) };
    if (isObject(data.data) && Array.isArray(data.data.records)) {
      return { list: data.data.records, groupHint: hint(data.data) ?? hint(data) };
    }
    if (RECORD_KEYS.some((key) => key in data)) return { list: [data], groupHint: null };
    return { list: [], groupHint: null };
  }
  function parseUpload(text2) {
    let data;
    try {
      data = JSON.parse(String(text2).replace(/^\uFEFF/, ""));
    } catch {
      throw new UploadError("not_json");
    }
    const { list, groupHint } = locate(data);
    if (list.length === 0) throw new UploadError("no_records");
    list.forEach((record, index) => {
      const ok = isObject(record) && nonEmptyString(record.conversation_id) && nonEmptyString(record.channel) && nonEmptyString(record.language) && Array.isArray(record.transcript);
      if (!ok) throw new UploadError(`bad_record:${index}`);
    });
    return { records: list, groupHint };
  }

  // src/domain/rational.js
  var DECIMAL = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
  function gcd(a, b) {
    let x = a < 0n ? -a : a;
    let y = b < 0n ? -b : b;
    while (y !== 0n) {
      [x, y] = [y, x % y];
    }
    return x;
  }
  function make(n, d) {
    if (d === 0n) throw new RangeError("division by zero");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d);
    return g > 1n ? { n: n / g, d: d / g } : { n, d };
  }
  function parse(text2) {
    const m = DECIMAL.exec(text2.trim());
    const intPart = m?.[2] ?? "";
    const fracPart = m?.[3] ?? "";
    if (!m || intPart + fracPart === "") {
      throw new TypeError(`not a decimal number: ${JSON.stringify(text2)}`);
    }
    let n = BigInt(intPart + fracPart);
    let d = 10n ** BigInt(fracPart.length);
    const exp = m[4] === void 0 ? 0 : Number(m[4]);
    if (!Number.isSafeInteger(exp) || Math.abs(exp) > 1e4) {
      throw new RangeError(`exponent out of range: ${JSON.stringify(text2)}`);
    }
    if (exp > 0) n *= 10n ** BigInt(exp);
    else if (exp < 0) d *= 10n ** BigInt(-exp);
    if (m[1] === "-") n = -n;
    return make(n, d);
  }
  function rat(x) {
    if (typeof x === "bigint") return make(x, 1n);
    if (typeof x === "number") {
      if (!Number.isFinite(x)) throw new TypeError(`not a finite number: ${x}`);
      return parse(String(x));
    }
    if (typeof x === "string") return parse(x);
    throw new TypeError(`cannot make a rational from ${typeof x}`);
  }
  var add = (a, b) => make(a.n * b.d + b.n * a.d, a.d * b.d);
  var mul = (a, b) => make(a.n * b.n, a.d * b.d);
  var div = (a, b) => {
    if (b.n === 0n) throw new RangeError("division by zero");
    return make(a.n * b.d, a.d * b.n);
  };
  var isZero = (a) => a.n === 0n;
  function hundredths(a) {
    const neg = a.n < 0n;
    const n = neg ? -a.n : a.n;
    const q = (200n * n + a.d) / (2n * a.d);
    return neg ? -q : q;
  }
  function round2(a) {
    return Number(hundredths(a)) / 100 + 0;
  }

  // src/domain/scoring.js
  var ZERO = rat(0);
  var HUNDRED = rat(100);
  var isStep = (answer) => answer !== null && typeof answer === "object" && !Array.isArray(answer) && Object.keys(answer).length === 1 && Object.hasOwn(answer, "step");
  function validateAnswer(criterion, answer) {
    if (answer === "na") return criterion.na_allowed ? null : "na_not_allowed";
    if (answer === "yes" || answer === "no") {
      return criterion.answer_type === "yes_no" ? null : "bad_answer";
    }
    if (isStep(answer)) {
      if (criterion.answer_type !== "scale") return "bad_answer";
      const inScale = (criterion.scale_steps ?? []).some((s) => s.value === answer.step);
      return typeof answer.step === "number" && inScale ? null : "step_not_in_scale";
    }
    return "bad_answer";
  }
  function fraction(criterion, answer) {
    if (answer === "yes") return rat(1);
    if (answer === "no") return ZERO;
    const top = criterion.scale_steps.reduce(
      (max, s) => s.value > max ? s.value : max,
      criterion.scale_steps[0].value
    );
    const topRat = rat(top);
    return isZero(topRat) ? ZERO : div(rat(answer.step), topRat);
  }
  var percentOf = (num, den) => round2(mul(div(num, den), HUNDRED));
  function score(version2, answers) {
    const entries = version2.criteria.map((criterion) => {
      const given = answers[criterion.id];
      const answer = given === void 0 || given === null ? null : given.answer;
      if (answer !== null && answer !== void 0) {
        const problem = validateAnswer(criterion, answer);
        if (problem) throw new RangeError(`criterion ${criterion.id}: ${problem}`);
      }
      const scored = criterion.kind !== "gross_error";
      const weight = scored ? rat(criterion.weight ?? 0) : ZERO;
      const applicable = scored && answer !== null && answer !== void 0 && answer !== "na" && weight.n > 0n;
      return { criterion, given, answer: answer ?? null, weight, applicable };
    });
    let weightSum = ZERO;
    for (const e of entries) if (e.applicable) weightSum = add(weightSum, e.weight);
    let total = ZERO;
    const perSection = /* @__PURE__ */ new Map();
    for (const e of entries) {
      if (!e.applicable) continue;
      const frac = fraction(e.criterion, e.answer);
      e.effective = div(mul(e.weight, HUNDRED), weightSum);
      e.points = mul(frac, e.effective);
      total = add(total, e.points);
      const acc = perSection.get(e.criterion.section_id) ?? {
        points: ZERO,
        available: ZERO,
        earned: ZERO,
        weight: ZERO
      };
      acc.points = add(acc.points, e.points);
      acc.available = add(acc.available, e.effective);
      acc.earned = add(acc.earned, mul(frac, e.weight));
      acc.weight = add(acc.weight, e.weight);
      perSection.set(e.criterion.section_id, acc);
    }
    const kinds = [];
    let flag = false;
    for (const e of entries) {
      if (e.criterion.kind !== "gross_error" || e.answer !== "yes") continue;
      flag = true;
      for (const kind of e.given.kinds ?? []) if (!kinds.includes(kind)) kinds.push(kind);
    }
    return {
      results: entries.map((e) => ({
        criterion_id: e.criterion.id,
        answer: e.answer,
        points: e.applicable ? round2(e.points) : null,
        effective_weight: e.applicable ? round2(e.effective) : null
      })),
      total: weightSum.n > 0n ? round2(total) : null,
      sections: version2.sections.map((s) => {
        const acc = perSection.get(s.id);
        return {
          section_id: s.id,
          points: acc ? round2(acc.points) : null,
          available: acc ? round2(acc.available) : null,
          percent: acc ? percentOf(acc.earned, acc.weight) : null
        };
      }),
      gross_error: { flag, kinds }
    };
  }
  var decidedAt = (appeal) => {
    const t2 = Date.parse(appeal.decision.decided_at ?? "");
    return Number.isNaN(t2) ? -Infinity : t2;
  };
  function finalAnswers(evaluation, decidedAppeals) {
    const changed = /* @__PURE__ */ new Map();
    for (const appeal of decidedAppeals ?? []) {
      if (appeal.evaluation_id !== evaluation.id) continue;
      if (appeal.decision?.outcome !== "changed") continue;
      const prior = changed.get(appeal.criterion_id);
      if (!prior || decidedAt(appeal) >= decidedAt(prior)) changed.set(appeal.criterion_id, appeal);
    }
    const out = {};
    for (const r of evaluation.results) {
      let answer = r.answer;
      if (r.final_answer !== void 0 && r.final_answer !== null) answer = r.final_answer;
      else if (changed.has(r.criterion_id)) answer = changed.get(r.criterion_id).decision.answer;
      out[r.criterion_id] = { answer };
      if (Array.isArray(r.kinds) && r.kinds.length > 0) out[r.criterion_id].kinds = r.kinds;
    }
    return out;
  }

  // src/api/mock/checklists.js
  var ChecklistBodyError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "ChecklistBodyError";
    }
  };
  var isText = (v) => typeof v === "string" && v.trim() !== "";
  var need = (ok, message) => {
    if (!ok) throw new ChecklistBodyError(message);
  };
  function nextCriterionId(taken) {
    let n = taken.size + 1;
    while (taken.has(`c${String(n).padStart(2, "0")}`)) n += 1;
    return `c${String(n).padStart(2, "0")}`;
  }
  async function completeBody(body, fallback = null) {
    const b = body ?? {};
    const name = b.name ?? fallback?.name;
    need(isText(name), "name is required");
    const channel = b.channel ?? fallback?.channel ?? "any";
    need(["any", "chat", "call"].includes(channel), "channel must be any, chat or call");
    const sections = structuredClone(b.sections ?? fallback?.sections ?? []);
    need(Array.isArray(sections) && sections.length > 0, "at least one section is required");
    sections.forEach((s, i) => {
      need(s && isText(s.id) && typeof s.title === "string", `section ${i}: id and title are required`);
      if (!Number.isInteger(s.order)) s.order = i + 1;
    });
    const sectionIds = new Set(sections.map((s) => s.id));
    need(sectionIds.size === sections.length, "section ids must be unique");
    const rawCriteria = structuredClone(b.criteria ?? fallback?.criteria ?? []);
    need(Array.isArray(rawCriteria) && rawCriteria.length > 0, "at least one criterion is required");
    const taken = new Set(rawCriteria.map((c) => c?.id).filter(isText));
    const seen = /* @__PURE__ */ new Set();
    const criteria = [];
    for (const [i, raw] of rawCriteria.entries()) {
      need(raw !== null && typeof raw === "object", `criterion ${i}: not an object`);
      const c = { ...raw };
      if (!isText(c.id)) c.id = nextCriterionId(taken);
      taken.add(c.id);
      need(!seen.has(c.id), `criterion ${c.id}: duplicate id`);
      seen.add(c.id);
      const where = `criterion ${c.id}`;
      need(sectionIds.has(c.section_id), `${where}: unknown section_id`);
      need(isText(c.title), `${where}: title is required`);
      c.answer_type ?? (c.answer_type = "yes_no");
      need(c.answer_type === "yes_no" || c.answer_type === "scale", `${where}: answer_type must be yes_no or scale`);
      c.kind ?? (c.kind = "scored");
      need(c.kind === "scored" || c.kind === "gross_error", `${where}: kind must be scored or gross_error`);
      c.scale_steps = c.answer_type === "scale" ? c.scale_steps ?? [] : [];
      if (c.answer_type === "scale") {
        need(Array.isArray(c.scale_steps) && c.scale_steps.length >= 2, `${where}: a scale needs at least two steps`);
        need(c.scale_steps.every((s) => Number.isFinite(s?.value) && typeof s.label === "string"), `${where}: steps are {value, label}`);
        c.scale_steps.sort((a, b2) => a.value - b2.value);
        need(new Set(c.scale_steps.map((s) => s.value)).size === c.scale_steps.length, `${where}: duplicate step values`);
      }
      c.weight = c.kind === "gross_error" ? 0 : c.weight ?? 0;
      need(Number.isFinite(c.weight) && c.weight >= 0, `${where}: weight must be a number from 0`);
      c.na_allowed = c.na_allowed === true;
      c.na_condition = c.na_allowed ? c.na_condition ?? null : null;
      c.kinds = c.kind === "gross_error" && Array.isArray(c.kinds) ? c.kinds : [];
      c.wording = typeof c.wording === "string" ? c.wording : "";
      c.guidance = typeof c.guidance === "string" && c.guidance !== "" ? c.guidance : null;
      if (!Number.isInteger(c.order)) c.order = i + 1;
      if (c.model === void 0 || c.model === null) delete c.model;
      c.fingerprint = await fingerprint(c);
      criteria.push(c);
    }
    return {
      name,
      description: b.description !== void 0 ? b.description : fallback?.description ?? null,
      channel,
      guidance: typeof b.guidance === "string" ? b.guidance : fallback?.guidance ?? "",
      // the contract: a string, "" when none
      rounding: Number.isInteger(b.rounding) ? b.rounding : fallback?.rounding ?? 2,
      sections,
      criteria
    };
  }

  // src/api/mock/datasets.js
  function callOffsets(transcript) {
    return offsets(transcript).flatMap(
      (seconds, index) => seconds === null ? [] : [{ message_index: index, seconds: Math.max(0, Math.round(seconds * 10) / 10) }]
    );
  }
  function toConversation(record, groupId, { audioBase, createdAt }) {
    const base = audioBase ? audioBase.endsWith("/") ? audioBase : `${audioBase}/` : null;
    const conversation = normalizeRecord(record, groupId, {
      audioPathFor: (conversationId) => groupId === "DEV" && base ? `${base}${conversationId}.mp3` : null
    });
    const isCall = conversation.channel === "voice call";
    return {
      ...conversation,
      created_at: createdAt,
      info: conversation.info ?? null,
      audio_offsets: Array.isArray(conversation.audio_offsets) ? conversation.audio_offsets : isCall ? callOffsets(conversation.transcript) : [],
      voice_measurements: Array.isArray(conversation.voice_measurements) ? conversation.voice_measurements : []
    };
  }
  var pad = (n) => String(n).padStart(2, "0");
  function compactTimestamp(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  }

  // ../checklists/official-chat-v1.json
  var official_chat_v1_default = {
    checklist_id: "official-chat",
    version: 1,
    name: "\u0427\u0435\u043A-\u043B\u0438\u0441\u0442 \u043A\u0430\u0447\u0435\u0441\u0442\u0432\u0430 \u0447\u0430\u0442\u043E\u0432",
    description: "\u0412\u043E\u0441\u0435\u043C\u044C \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0435\u0432 \u0434\u043B\u044F \u043E\u0446\u0435\u043D\u043A\u0438 \u0440\u0430\u0431\u043E\u0442\u044B \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0430 \u043F\u043E \u043F\u0435\u0440\u0435\u043F\u0438\u0441\u043A\u0435",
    channel: "any",
    locked: true,
    rounding: 2,
    guidance: "\u041A\u0430\u043A \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u044C\u0441\u044F \u0447\u0435\u043A-\u043B\u0438\u0441\u0442\u043E\u043C\n\n\u041F\u0430\u043C\u044F\u0442\u043A\u0430 \u043F\u0435\u0440\u0435\u0434 \u043F\u0435\u0440\u0432\u043E\u0439 \u043E\u0446\u0435\u043D\u043A\u043E\u0439\n\n\u0427\u0442\u043E \u0442\u0430\u043A\u043E\u0435 \u0447\u0435\u043A-\u043B\u0438\u0441\u0442?\n\u042D\u0442\u043E \u043D\u0430\u0431\u043E\u0440 \u043E\u0431\u0449\u0438\u0445 \u043F\u0440\u0430\u0432\u0438\u043B \u043E\u0446\u0435\u043D\u043A\u0438. \u041E\u0434\u0438\u043D \u0438 \u0442\u043E\u0442 \u0436\u0435 \u0447\u0435\u043A-\u043B\u0438\u0441\u0442 \u043F\u0440\u0438\u043C\u0435\u043D\u044F\u0435\u0442\u0441\u044F \u043A \u0447\u0430\u0442\u0430\u043C \u043D\u0430 \u0440\u0443\u0441\u0441\u043A\u043E\u043C, \u043A\u0430\u0437\u0430\u0445\u0441\u043A\u043E\u043C \u0438 \u0430\u043D\u0433\u043B\u0438\u0439\u0441\u043A\u043E\u043C. \u041A\u0440\u0438\u0442\u0435\u0440\u0438\u0439 \u043E\u0442\u0432\u0435\u0447\u0430\u0435\u0442 \u043D\u0430 \u043E\u0442\u0434\u0435\u043B\u044C\u043D\u044B\u0439 \u0432\u043E\u043F\u0440\u043E\u0441 \u043E \u0440\u0430\u0431\u043E\u0442\u0435 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0430, \u0430 \u0432\u0435\u0441 \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442 \u0435\u0433\u043E \u0432\u043A\u043B\u0430\u0434 \u0432 \u0438\u0442\u043E\u0433.\n\n\u0427\u0435\u043C \xAB\u041D\u0435\u0442\xBB \u043E\u0442\u043B\u0438\u0447\u0430\u0435\u0442\u0441\u044F \u043E\u0442 N/A?\n\xAB\u041D\u0435\u0442\xBB \u2014 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435 \u0431\u044B\u043B\u043E \u043D\u0443\u0436\u043D\u043E, \u043D\u043E \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440 \u0435\u0433\u043E \u043F\u0440\u043E\u043F\u0443\u0441\u0442\u0438\u043B \u0438\u043B\u0438 \u0432\u044B\u043F\u043E\u043B\u043D\u0438\u043B \u043D\u0435\u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u043E. N/A \u2014 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0439 \u043D\u0435\u043F\u0440\u0438\u043C\u0435\u043D\u0438\u043C \u043F\u043E \u0443\u0441\u043B\u043E\u0432\u0438\u044E \u043D\u0430 \u0441\u0442\u0440. 1. \u041E\u0431\u0449\u0438\u0439 \u0432\u043E\u043F\u0440\u043E\u0441 \u043E \u0442\u0430\u0440\u0438\u0444\u0430\u0445 \u043D\u0435 \u0442\u0440\u0435\u0431\u0443\u0435\u0442 \u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0446\u0438\u0438. \u0415\u0441\u043B\u0438 \u0442\u0440\u0435\u0431\u043E\u0432\u0430\u043B\u0430\u0441\u044C \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0430 \u043B\u0438\u0447\u043D\u043E\u0441\u0442\u0438 \u043F\u0435\u0440\u0435\u0434 \u0437\u0430\u0449\u0438\u0449\u0451\u043D\u043D\u044B\u043C \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435\u043C \u0438 \u043E\u043D\u0430 \u043D\u0435 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0430 \u0432 \u0447\u0430\u0442\u0435, \u0441\u0442\u0430\u0432\u044C\u0442\u0435 \xAB\u041D\u0435\u0442\xBB.\n\n\u041D\u0430 \u0447\u0442\u043E \u0441\u0441\u044B\u043B\u0430\u0442\u044C\u0441\u044F \u043F\u0440\u0438 \u043E\u0446\u0435\u043D\u043A\u0435?\n\u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u043A\u043E\u043D\u043A\u0440\u0435\u0442\u043D\u0443\u044E \u0440\u0435\u043F\u043B\u0438\u043A\u0443 \u0438\u043B\u0438 \u0441\u0438\u0441\u0442\u0435\u043C\u043D\u043E\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u0438 \u043A\u043E\u0440\u043E\u0442\u043A\u043E \u043F\u043E\u044F\u0441\u043D\u0438\u0442\u0435, \u0447\u0442\u043E \u043E\u043D\u043E \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0430\u0435\u0442. \u0414\u043B\u044F \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u043D\u043E\u0433\u043E \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F \u0443\u043A\u0430\u0436\u0438\u0442\u0435 \u043C\u0435\u0441\u0442\u043E, \u0433\u0434\u0435 \u043E\u043D\u043E \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C. \u0414\u043B\u044F N/A \u043E\u0431\u044A\u044F\u0441\u043D\u0438\u0442\u0435, \u043A\u0430\u043A\u043E\u0435 \u0443\u0441\u043B\u043E\u0432\u0438\u0435 \u043D\u0435\u043F\u0440\u0438\u043C\u0435\u043D\u0438\u043C\u043E\u0441\u0442\u0438 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043E.\n\n\u041A\u0430\u043A \u0440\u0430\u0437\u0434\u0435\u043B\u0438\u0442\u044C \u043A\u043E\u043D\u0441\u0443\u043B\u044C\u0442\u0430\u0446\u0438\u044E \u0438 \u0432\u0435\u0434\u0435\u043D\u0438\u0435 \u0434\u0438\u0430\u043B\u043E\u0433\u0430?\n\u041A\u043E\u043D\u0441\u0443\u043B\u044C\u0442\u0430\u0446\u0438\u044F \u043E\u0446\u0435\u043D\u0438\u0432\u0430\u0435\u0442, \u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u043E \u0438 \u043F\u043E\u043B\u043D\u043E \u043B\u0438 \u0440\u0435\u0448\u0451\u043D \u0437\u0430\u043F\u0440\u043E\u0441. \u0412\u0435\u0434\u0435\u043D\u0438\u0435 \u0434\u0438\u0430\u043B\u043E\u0433\u0430 \u043E\u0446\u0435\u043D\u0438\u0432\u0430\u0435\u0442, \u043D\u0430\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u043F\u043E\u043D\u044F\u0442\u043D\u043E \u0438 \u043F\u043E\u0441\u043B\u0435\u0434\u043E\u0432\u0430\u0442\u0435\u043B\u044C\u043D\u043E \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440 \u043E\u0431\u0449\u0430\u043B\u0441\u044F. \u042F\u0441\u043D\u044B\u0439 \u043E\u0442\u0432\u0435\u0442 \u043D\u0430 \u043E\u0434\u0438\u043D \u0438\u0437 \u0434\u0432\u0443\u0445 \u0432\u0430\u0436\u043D\u044B\u0445 \u0432\u043E\u043F\u0440\u043E\u0441\u043E\u0432 \u043C\u043E\u0436\u0435\u0442 \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u0432\u044B\u0441\u043E\u043A\u0438\u0439 \u0431\u0430\u043B\u043B \u0437\u0430 \u0432\u0435\u0434\u0435\u043D\u0438\u0435 \u0434\u0438\u0430\u043B\u043E\u0433\u0430 \u0438 \u0447\u0430\u0441\u0442\u0438\u0447\u043D\u044B\u0439 \u0437\u0430 \u043A\u043E\u043D\u0441\u0443\u043B\u044C\u0442\u0430\u0446\u0438\u044E.\n\n\u0427\u0442\u043E \u0441\u0447\u0438\u0442\u0430\u0442\u044C \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u0435\u043C \u0443\u0441\u043B\u0443\u0433\u0438 \u0432 \u043E\u0431\u0445\u043E\u0434 \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u0438?\n\u0421\u0442\u0430\u0432\u044C\u0442\u0435 \u0444\u043B\u0430\u0433, \u0435\u0441\u043B\u0438 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440 \u043F\u0440\u0435\u0434\u043B\u0430\u0433\u0430\u0435\u0442 \u043F\u0435\u0440\u0435\u0432\u0435\u0441\u0442\u0438 \u0434\u0435\u043D\u044C\u0433\u0438 \u0435\u043C\u0443 \u043B\u0438\u0447\u043D\u043E \u0434\u043B\u044F \u0438\u043D\u0432\u0435\u0441\u0442\u0438\u0440\u043E\u0432\u0430\u043D\u0438\u044F \u0438\u043B\u0438 \u043F\u0440\u043E\u0441\u0438\u0442 \u043B\u0438\u0447\u043D\u044B\u0439 \u043D\u043E\u043C\u0435\u0440 \u043A\u043B\u0438\u0435\u043D\u0442\u0430, \u0447\u0442\u043E\u0431\u044B \u043E\u043A\u0430\u0437\u0430\u0442\u044C \u043F\u043B\u0430\u0442\u043D\u0443\u044E \u043A\u043E\u043D\u0441\u0443\u043B\u044C\u0442\u0430\u0446\u0438\u044E \u0432 \u0447\u0430\u0441\u0442\u043D\u043E\u043C \u043F\u043E\u0440\u044F\u0434\u043A\u0435. \u0414\u043E\u0441\u0442\u0430\u0442\u043E\u0447\u043D\u043E \u0441\u0430\u043C\u043E\u0433\u043E \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u0432 \u043F\u0435\u0440\u0435\u043F\u0438\u0441\u043A\u0435. \u0421\u043E\u0433\u043B\u0430\u0441\u0438\u0435 \u043A\u043B\u0438\u0435\u043D\u0442\u0430 \u0438\u043B\u0438 \u043F\u0435\u0440\u0435\u0432\u043E\u0434 \u0434\u0435\u043D\u0435\u0433 \u0434\u043B\u044F \u043E\u0442\u043C\u0435\u0442\u043A\u0438 \u043D\u0435 \u0442\u0440\u0435\u0431\u0443\u044E\u0442\u0441\u044F.\n\n\u041A\u0430\u043A \u0432\u044B\u0433\u043B\u044F\u0434\u0438\u0442 \u043E\u0431\u043E\u0441\u043D\u043E\u0432\u0430\u043D\u0438\u0435?\n\xAB\u0417\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u0435 \u2014 \u041D\u0435\u0442. \u041F\u043E\u0441\u043B\u0435 \u043E\u0442\u0432\u0435\u0442\u0430 \u043D\u0430 \u0432\u043E\u043F\u0440\u043E\u0441 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440 \u0437\u0430\u043A\u0440\u044B\u043B \u0447\u0430\u0442 \u0431\u0435\u0437 \u043F\u0440\u043E\u0449\u0430\u043D\u0438\u044F. \u041E\u0441\u043D\u043E\u0432\u0430\u043D\u0438\u0435 \u2014 \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u044F\u044F \u0440\u0435\u043F\u043B\u0438\u043A\u0430 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0430 \u0438 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u043E \u0437\u0430\u043A\u0440\u044B\u0442\u0438\u0438 \u0447\u0430\u0442\u0430\xBB.\n\n\u0427\u0422\u041E \u0423\u041A\u0410\u0417\u0410\u0422\u042C \u0412 \u0420\u0415\u0417\u0423\u041B\u042C\u0422\u0410\u0422\u0415\n\u041F\u043E \u043A\u0430\u0436\u0434\u043E\u043C\u0443 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044E \u0443\u043A\u0430\u0436\u0438\u0442\u0435 \u043E\u0442\u0432\u0435\u0442 \u0438\u043B\u0438 \u0431\u0430\u043B\u043B, \u043A\u043E\u0440\u043E\u0442\u043A\u043E\u0435 \u043E\u0431\u043E\u0441\u043D\u043E\u0432\u0430\u043D\u0438\u0435 \u0438 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0430\u044E\u0449\u0438\u0439 \u0444\u0440\u0430\u0433\u043C\u0435\u043D\u0442. \u0412 \u043A\u043E\u043D\u0446\u0435 \u0437\u0430\u043F\u0438\u0448\u0438\u0442\u0435 \u0438\u0442\u043E\u0433\u043E\u0432\u044B\u0439 \u0431\u0430\u043B\u043B \u0438 \u043E\u0442\u043C\u0435\u0442\u043A\u0443 \u043E \u0433\u0440\u0443\u0431\u044B\u0445 \u043E\u0448\u0438\u0431\u043A\u0430\u0445.\n\n\u0412 \u044D\u0442\u043E\u043C \u0437\u0430\u0434\u0430\u043D\u0438\u0438 \u043F\u043E\u0440\u043E\u0433 \u043F\u0435\u0440\u0432\u043E\u0439 \u0440\u0435\u0430\u043A\u0446\u0438\u0438 \u0432 3 \u043C\u0438\u043D\u0443\u0442\u044B, \u0442\u0435\u0433\u0438 \u0438 \u0432\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u0432 \u043E\u0446\u0435\u043D\u043A\u0443 \u043D\u0435 \u0432\u0445\u043E\u0434\u044F\u0442.",
    sections: [
      {
        id: "start",
        title: "\u041D\u0430\u0447\u0430\u043B\u043E \u0438 \u043F\u043E\u043D\u0438\u043C\u0430\u043D\u0438\u0435 \u0437\u0430\u043F\u0440\u043E\u0441\u0430",
        order: 1
      },
      {
        id: "safety",
        title: "\u0411\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u044C \u0438 \u0440\u0435\u0448\u0435\u043D\u0438\u0435",
        order: 2
      },
      {
        id: "conduct",
        title: "\u0412\u0435\u0434\u0435\u043D\u0438\u0435 \u0438 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u0435 \u0434\u0438\u0430\u043B\u043E\u0433\u0430",
        order: 3
      },
      {
        id: "gross",
        title: "\u0413\u0440\u0443\u0431\u044B\u0435 \u043D\u0430\u0440\u0443\u0448\u0435\u043D\u0438\u044F",
        order: 4
      }
    ],
    criteria: [
      {
        id: "c01",
        section_id: "start",
        order: 1,
        title: "\u0423\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u0435 \u043A\u043E\u043D\u0442\u0430\u043A\u0442\u0430",
        wording: "\u0414\u0430 \u2014 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440 \u043F\u043E\u0437\u0434\u043E\u0440\u043E\u0432\u0430\u043B\u0441\u044F \u043D\u0430 \u044F\u0437\u044B\u043A\u0435 \u043A\u043B\u0438\u0435\u043D\u0442\u0430 \u0438 \u043F\u0440\u0435\u0434\u0441\u0442\u0430\u0432\u0438\u043B\u0441\u044F \u0432 \u043F\u0435\u0440\u0432\u043E\u043C \u043E\u0442\u0432\u0435\u0442\u0435.",
        answer_type: "yes_no",
        scale_steps: [],
        weight: 10,
        na_allowed: false,
        na_condition: null,
        kind: "scored",
        kinds: [],
        guidance: null
      },
      {
        id: "c02",
        section_id: "start",
        order: 2,
        title: "\u0412\u044B\u044F\u0432\u043B\u0435\u043D\u0438\u0435 \u043F\u043E\u0442\u0440\u0435\u0431\u043D\u043E\u0441\u0442\u0438",
        wording: "\u0414\u0430 \u2014 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440 \u0443\u0447\u0451\u043B \u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0435 \u0434\u0435\u0442\u0430\u043B\u0438 \u0438 \u0443\u0442\u043E\u0447\u043D\u0438\u043B \u043D\u0435\u0434\u043E\u0441\u0442\u0430\u044E\u0449\u0435\u0435 \u0434\u043E \u043E\u0442\u0432\u0435\u0442\u0430.",
        answer_type: "yes_no",
        scale_steps: [],
        weight: 15,
        na_allowed: true,
        na_condition: "N/A \u2014 \u0434\u0430\u043D\u043D\u044B\u0445 \u0434\u043B\u044F \u043E\u0442\u0432\u0435\u0442\u0430 \u0445\u0432\u0430\u0442\u0430\u043B\u043E \u0441 \u0441\u0430\u043C\u043E\u0433\u043E \u043D\u0430\u0447\u0430\u043B\u0430.",
        kind: "scored",
        kinds: [],
        guidance: null
      },
      {
        id: "c03",
        section_id: "safety",
        order: 3,
        title: "\u0418\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0446\u0438\u044F",
        wording: "\u0414\u0430 \u2014 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0430 \u043B\u0438\u0447\u043D\u043E\u0441\u0442\u0438 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0430 \u0434\u043E \u0440\u0430\u0441\u043A\u0440\u044B\u0442\u0438\u044F \u0434\u0430\u043D\u043D\u044B\u0445 \u0438\u043B\u0438 \u0437\u0430\u0449\u0438\u0449\u0451\u043D\u043D\u043E\u0433\u043E \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F.",
        answer_type: "yes_no",
        scale_steps: [],
        weight: 20,
        na_allowed: true,
        na_condition: "N/A \u2014 \u0437\u0430\u043F\u0440\u043E\u0441 \u043D\u0435 \u0442\u0440\u0435\u0431\u043E\u0432\u0430\u043B \u0438\u0434\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0446\u0438\u0438.",
        kind: "scored",
        kinds: [],
        guidance: null
      },
      {
        id: "c04",
        section_id: "safety",
        order: 4,
        title: "\u041A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u0430\u044F \u0438 \u043F\u043E\u043B\u043D\u0430\u044F \u043A\u043E\u043D\u0441\u0443\u043B\u044C\u0442\u0430\u0446\u0438\u044F",
        wording: "\u041E\u0446\u0435\u043D\u0438\u0442\u0435 \u043E\u0442\u0432\u0435\u0442 \u0438\u043B\u0438 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u0448\u0430\u0433 \u043F\u043E \u0448\u043A\u0430\u043B\u0435 \u043D\u0430 \u0441\u0442\u0440. 2.",
        answer_type: "scale",
        scale_steps: [
          {
            value: 0,
            label: "\u041E\u0442\u0432\u0435\u0442\u0430 \u043F\u043E \u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0443 \u043D\u0435\u0442 \u0438\u043B\u0438 \u043A\u043B\u044E\u0447\u0435\u0432\u0430\u044F \u0440\u0435\u043A\u043E\u043C\u0435\u043D\u0434\u0430\u0446\u0438\u044F \u043E\u0448\u0438\u0431\u043E\u0447\u043D\u0430."
          },
          {
            value: 5,
            label: "\u0415\u0441\u0442\u044C \u043E\u0431\u0449\u0430\u044F \u043F\u043E\u0434\u0441\u043A\u0430\u0437\u043A\u0430, \u043D\u043E \u043A\u043B\u0438\u0435\u043D\u0442\u0443 \u0432\u0441\u0451 \u0435\u0449\u0451 \u043D\u0435\u043F\u043E\u043D\u044F\u0442\u043D\u043E, \u043A\u0430\u043A \u0434\u0435\u0439\u0441\u0442\u0432\u043E\u0432\u0430\u0442\u044C."
          },
          {
            value: 10,
            label: "\u0427\u0430\u0441\u0442\u044C \u0437\u0430\u043F\u0440\u043E\u0441\u0430 \u0437\u0430\u043A\u0440\u044B\u0442\u0430, \u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0435\u043D\u043D\u044B\u0439 \u0432\u043E\u043F\u0440\u043E\u0441 \u043E\u0441\u0442\u0430\u043B\u0441\u044F \u043E\u0442\u043A\u0440\u044B\u0442\u044B\u043C."
          },
          {
            value: 15,
            label: "\u041E\u0441\u043D\u043E\u0432\u043D\u043E\u0439 \u0432\u043E\u043F\u0440\u043E\u0441 \u0440\u0435\u0448\u0451\u043D, \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u0430 \u0432\u0442\u043E\u0440\u043E\u0441\u0442\u0435\u043F\u0435\u043D\u043D\u0430\u044F \u0434\u0435\u0442\u0430\u043B\u044C."
          },
          {
            value: 20,
            label: "\u0412\u0441\u0435 \u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0435\u043D\u043D\u044B\u0435 \u0432\u043E\u043F\u0440\u043E\u0441\u044B \u0437\u0430\u043A\u0440\u044B\u0442\u044B \u0438\u043B\u0438 \u0434\u0430\u043D \u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u0448\u0430\u0433."
          }
        ],
        weight: 20,
        na_allowed: true,
        na_condition: "N/A \u2014 \u0447\u0430\u0442 \u0437\u0430\u043A\u043E\u043D\u0447\u0438\u043B\u0441\u044F \u0434\u043E \u0442\u043E\u0433\u043E, \u043A\u0430\u043A \u043A\u043B\u0438\u0435\u043D\u0442 \u0441\u0444\u043E\u0440\u043C\u0443\u043B\u0438\u0440\u043E\u0432\u0430\u043B \u0437\u0430\u043F\u0440\u043E\u0441.",
        kind: "scored",
        kinds: [],
        guidance: null
      },
      {
        id: "c05",
        section_id: "conduct",
        order: 5,
        title: "\u042D\u043C\u043F\u0430\u0442\u0438\u044F \u0438 \u043A\u043B\u0438\u0435\u043D\u0442\u043E\u043E\u0440\u0438\u0435\u043D\u0442\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u043E\u0441\u0442\u044C",
        wording: "\u0414\u0430 \u2014 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440 \u0432\u0435\u0436\u043B\u0438\u0432 \u0438, \u0435\u0441\u043B\u0438 \u043A\u043B\u0438\u0435\u043D\u0442 \u0432\u044B\u0440\u0430\u0437\u0438\u043B \u043D\u0435\u0434\u043E\u0432\u043E\u043B\u044C\u0441\u0442\u0432\u043E \u0438\u043B\u0438 \u043E\u043F\u0438\u0441\u0430\u043B \u043D\u0435\u0443\u0434\u043E\u0431\u0441\u0442\u0432\u043E, \u043E\u0442\u0440\u0435\u0430\u0433\u0438\u0440\u043E\u0432\u0430\u043B \u043D\u0430 \u043A\u043E\u043D\u043A\u0440\u0435\u0442\u043D\u0443\u044E \u043F\u0440\u043E\u0431\u043B\u0435\u043C\u0443.",
        answer_type: "yes_no",
        scale_steps: [],
        weight: 15,
        na_allowed: false,
        na_condition: null,
        kind: "scored",
        kinds: [],
        guidance: null
      },
      {
        id: "c06",
        section_id: "conduct",
        order: 6,
        title: "\u0423\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0438\u0435 \u0434\u0438\u0430\u043B\u043E\u0433\u043E\u043C, \u0441\u043A\u043E\u0440\u043E\u0441\u0442\u044C \u0438 \u0433\u0440\u0430\u043C\u043E\u0442\u043D\u043E\u0441\u0442\u044C",
        wording: "\u041E\u0446\u0435\u043D\u0438\u0442\u0435 \u044F\u0441\u043D\u043E\u0441\u0442\u044C, \u043F\u043E\u0440\u044F\u0434\u043E\u043A \u043E\u0442\u0432\u0435\u0442\u043E\u0432 \u0438 \u043F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u0435 \u043E\u0431 \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0438 \u043F\u043E \u0448\u043A\u0430\u043B\u0435 \u043D\u0430 \u0441\u0442\u0440. 2.",
        answer_type: "scale",
        scale_steps: [
          {
            value: 0,
            label: "\u0418\u0437-\u0437\u0430 \u0431\u0435\u0441\u0441\u0432\u044F\u0437\u043D\u044B\u0445 \u0438\u043B\u0438 \u043F\u0440\u043E\u0442\u0438\u0432\u043E\u0440\u0435\u0447\u0438\u0432\u044B\u0445 \u0440\u0435\u043F\u043B\u0438\u043A \u0445\u043E\u0434 \u0434\u0438\u0430\u043B\u043E\u0433\u0430 \u043D\u0435\u043F\u043E\u043D\u044F\u0442\u0435\u043D."
          },
          {
            value: 4,
            label: "\u041A\u043B\u0438\u0435\u043D\u0442\u0443 \u043F\u0440\u0438\u0445\u043E\u0434\u0438\u0442\u0441\u044F \u043F\u0435\u0440\u0435\u0441\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u0442\u044C \u0438\u0437-\u0437\u0430 \u0444\u043E\u0440\u043C\u0443\u043B\u0438\u0440\u043E\u0432\u043E\u043A \u0438\u043B\u0438 \u043F\u043E\u0440\u044F\u0434\u043A\u0430 \u043E\u0442\u0432\u0435\u0442\u043E\u0432."
          },
          {
            value: 7,
            label: "\u041E\u0434\u0438\u043D \u0437\u0430\u043C\u0435\u0442\u043D\u044B\u0439 \u0441\u0431\u043E\u0439, \u043D\u043E \u043A\u043B\u0438\u0435\u043D\u0442 \u043C\u043E\u0436\u0435\u0442 \u043F\u043E\u043D\u044F\u0442\u044C \u043E\u0442\u0432\u0435\u0442 \u0438 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u044C."
          },
          {
            value: 10,
            label: "\u041E\u0442\u0432\u0435\u0442\u044B \u044F\u0441\u043D\u044B\u0435 \u0438 \u0441\u0432\u044F\u0437\u043D\u044B\u0435. \u0415\u0441\u043B\u0438 \u0431\u044B\u043B\u043E \u044F\u0432\u043D\u043E\u0435 \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0435, \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440 \u043F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0434\u0438\u043B."
          }
        ],
        weight: 15,
        na_allowed: false,
        na_condition: null,
        kind: "scored",
        kinds: [],
        guidance: null
      },
      {
        id: "c07",
        section_id: "conduct",
        order: 7,
        title: "\u0417\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u0435",
        wording: "\u0414\u0430 \u2014 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440 \u043F\u043E\u0434\u0432\u0451\u043B \u0438\u0442\u043E\u0433 \u0438\u043B\u0438 \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0438\u043B \u0434\u0430\u043B\u044C\u043D\u0435\u0439\u0448\u0443\u044E \u043F\u043E\u043C\u043E\u0449\u044C \u0438 \u043F\u043E\u043F\u0440\u043E\u0449\u0430\u043B\u0441\u044F.",
        answer_type: "yes_no",
        scale_steps: [],
        weight: 5,
        na_allowed: true,
        na_condition: "N/A \u2014 \u0447\u0430\u0442 \u043E\u0431\u043E\u0440\u0432\u0430\u043B\u0441\u044F \u0434\u043E \u0432\u043E\u0437\u043C\u043E\u0436\u043D\u043E\u0441\u0442\u0438 \u0435\u0433\u043E \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u0442\u044C.",
        kind: "scored",
        kinds: [],
        guidance: null
      },
      {
        id: "c08",
        section_id: "gross",
        order: 8,
        title: "\u0413\u0440\u0443\u0431\u044B\u0435 \u043E\u0448\u0438\u0431\u043A\u0438",
        wording: "\u0414\u0430 \u2014 \u0432\u044B\u044F\u0432\u043B\u0435\u043D\u043E \u043E\u0441\u043A\u043E\u0440\u0431\u043B\u0435\u043D\u0438\u0435 \u043A\u043B\u0438\u0435\u043D\u0442\u0430, \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u0435 \u043F\u043B\u0430\u0442\u043D\u043E\u0439 \u0443\u0441\u043B\u0443\u0433\u0438 \u0432 \u043E\u0431\u0445\u043E\u0434 \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u0438 \u0438\u043B\u0438 \u0440\u0430\u0441\u043A\u0440\u044B\u0442\u0438\u0435 \u043A\u043E\u043D\u0444\u0438\u0434\u0435\u043D\u0446\u0438\u0430\u043B\u044C\u043D\u043E\u0439 \u0438\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u0438. \u041D\u0435\u0442 \u2014 \u043D\u0438 \u043E\u0434\u043D\u043E \u0438\u0437 \u0442\u0440\u0451\u0445 \u043D\u0435 \u0432\u044B\u044F\u0432\u043B\u0435\u043D\u043E.",
        answer_type: "yes_no",
        scale_steps: [],
        weight: 0,
        na_allowed: false,
        na_condition: null,
        kind: "gross_error",
        kinds: [
          "insult",
          "paid_service_outside_company",
          "confidential_disclosure"
        ],
        guidance: null
      }
    ]
  };

  // ../contract/examples/conversation.chat-ru.json
  var conversation_chat_ru_default = {
    id: "example:p1-ru-001",
    created_at: "2026-11-07T08:55:00Z",
    group_id: "example",
    conversation_id: "p1-ru-001",
    channel: "agent chat",
    language: "RU",
    transcript: [
      {
        timestamp: "00:00",
        speaker: "client",
        text: "\u0417\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439\u0442\u0435! \u0425\u043E\u0447\u0443 \u0443\u0437\u043D\u0430\u0442\u044C, \u043A\u0430\u043A \u043F\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u044C \u0431\u0440\u043E\u043A\u0435\u0440\u0441\u043A\u0438\u0439 \u0441\u0447\u0451\u0442 \u0441 \u043A\u0430\u0440\u0442\u044B \u0434\u0440\u0443\u0433\u043E\u0433\u043E \u0431\u0430\u043D\u043A\u0430."
      },
      {
        timestamp: "00:01",
        speaker: "client",
        text: "\u0417\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439\u0442\u0435! \u0425\u043E\u0447\u0443 \u0443\u0437\u043D\u0430\u0442\u044C, \u043A\u0430\u043A \u043F\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u044C \u0431\u0440\u043E\u043A\u0435\u0440\u0441\u043A\u0438\u0439 \u0441\u0447\u0451\u0442 \u0441 \u043A\u0430\u0440\u0442\u044B \u0434\u0440\u0443\u0433\u043E\u0433\u043E \u0431\u0430\u043D\u043A\u0430.",
        duplicate: true
      },
      {
        timestamp: "00:03",
        speaker: "bot",
        text: "\u0412\u0430\u0448 \u0437\u0430\u043F\u0440\u043E\u0441 \u043F\u0435\u0440\u0435\u0434\u0430\u043D \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0443. \u0421\u0440\u0435\u0434\u043D\u0435\u0435 \u0432\u0440\u0435\u043C\u044F \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u044F \u2014 1 \u043C\u0438\u043D\u0443\u0442\u0430."
      },
      {
        timestamp: "00:05",
        speaker: "system",
        text: "\u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440 \u043F\u0440\u0438\u0441\u043E\u0435\u0434\u0438\u043D\u0438\u043B\u0441\u044F \u043A \u0447\u0430\u0442\u0443."
      },
      {
        timestamp: "00:31",
        speaker: "operator",
        text: "\u0417\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439\u0442\u0435! \u041C\u0435\u043D\u044F \u0437\u043E\u0432\u0443\u0442 \u0410\u0439\u0433\u0435\u0440\u0438\u043C, \u044F \u043F\u043E\u043C\u043E\u0433\u0443 \u0432\u0430\u043C \u0441 \u043F\u043E\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435\u043C."
      },
      {
        timestamp: "00:33",
        speaker: "operator",
        text: "\u0414\u043B\u044F \u043D\u0430\u0447\u0430\u043B\u0430 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u0435, \u043F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430, \u043A\u043E\u0434\u043E\u0432\u043E\u0435 \u0441\u043B\u043E\u0432\u043E \u0438\u0437 \u0432\u0430\u0448\u0435\u0433\u043E \u043F\u0440\u043E\u0444\u0438\u043B\u044F."
      },
      {
        timestamp: "01:10",
        speaker: "client",
        text: "\u041A\u043E\u0434\u043E\u0432\u043E\u0435 \u0441\u043B\u043E\u0432\u043E \u2014 \u0420\u043E\u043C\u0430\u0448\u043A\u0430."
      },
      {
        timestamp: "01:14",
        speaker: "operator",
        text: "\u0421\u043F\u0430\u0441\u0438\u0431\u043E, \u043B\u0438\u0447\u043D\u043E\u0441\u0442\u044C \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0430. \u041F\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u044C \u0441\u0447\u0451\u0442 \u0441 \u043A\u0430\u0440\u0442\u044B \u0434\u0440\u0443\u0433\u043E\u0433\u043E \u0431\u0430\u043D\u043A\u0430 \u043C\u043E\u0436\u043D\u043E \u0432 \u0440\u0430\u0437\u0434\u0435\u043B\u0435 \xAB\u041F\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u044C\xBB \u043C\u043E\u0431\u0438\u043B\u044C\u043D\u043E\u0433\u043E \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u044F."
      },
      {
        timestamp: "01:50",
        speaker: "client",
        text: "\u0410 \u0441\u0440\u043E\u043A\u0438 \u0437\u0430\u0447\u0438\u0441\u043B\u0435\u043D\u0438\u044F \u043A\u0430\u043A\u0438\u0435? \u0412 \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0438 \u043D\u0435 \u043D\u0430\u0448\u0451\u043B, \u043D\u0435\u0443\u0434\u043E\u0431\u043D\u043E."
      },
      {
        timestamp: "01:55",
        speaker: "operator",
        text: "\u041E\u0431\u044B\u0447\u043D\u043E \u0434\u0435\u043D\u044C\u0433\u0438 \u043F\u0440\u0438\u0445\u043E\u0434\u044F\u0442 \u0432 \u0442\u0435\u0447\u0435\u043D\u0438\u0435 \u043E\u0434\u043D\u043E\u0433\u043E \u0440\u0430\u0431\u043E\u0447\u0435\u0433\u043E \u0434\u043D\u044F, \u0442\u043E\u0447\u043D\u044B\u0439 \u0441\u0440\u043E\u043A \u0437\u0430\u0432\u0438\u0441\u0438\u0442 \u043E\u0442 \u0431\u0430\u043D\u043A\u0430-\u044D\u043C\u0438\u0442\u0435\u043D\u0442\u0430."
      },
      {
        timestamp: "02:20",
        speaker: "client",
        text: "\u0418 \u0435\u0449\u0451 \u043D\u0443\u0436\u043D\u0430 \u0441\u043F\u0440\u0430\u0432\u043A\u0430 \u0434\u043B\u044F \u043D\u0430\u043B\u043E\u0433\u043E\u0432\u043E\u0439. \u042D\u0442\u043E \u0432\u043E\u0437\u043C\u043E\u0436\u043D\u043E?"
      },
      {
        timestamp: "02:25",
        speaker: "operator",
        text: "\u0421\u043F\u0440\u0430\u0432\u043A\u0438 \u0433\u043E\u0442\u043E\u0432\u0438\u0442 \u043E\u0442\u0434\u0435\u043B \u043E\u0431\u0441\u043B\u0443\u0436\u0438\u0432\u0430\u043D\u0438\u044F, \u0441\u0435\u0439\u0447\u0430\u0441 \u043F\u0435\u0440\u0435\u0434\u0430\u043C \u0432\u0430\u0448 \u0447\u0430\u0442 \u043A\u043E\u043B\u043B\u0435\u0433\u0435."
      },
      {
        timestamp: "02:28",
        speaker: "system",
        text: "\u0427\u0430\u0442 \u043F\u0435\u0440\u0435\u0434\u0430\u043D \u0441\u043F\u0435\u0446\u0438\u0430\u043B\u0438\u0441\u0442\u0443 \u043E\u0442\u0434\u0435\u043B\u0430 \u043E\u0431\u0441\u043B\u0443\u0436\u0438\u0432\u0430\u043D\u0438\u044F."
      },
      {
        timestamp: "02:40",
        speaker: "operator",
        text: "\u0414\u043E\u0431\u0440\u044B\u0439 \u0434\u0435\u043D\u044C! \u0421\u043F\u0440\u0430\u0432\u043A\u0443 \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u0438\u043C \u0437\u0430 \u0434\u0432\u0430 \u0440\u0430\u0431\u043E\u0447\u0438\u0445 \u0434\u043D\u044F, \u043D\u0430\u043F\u0438\u0448\u0438\u0442\u0435 \u043F\u0435\u0440\u0438\u043E\u0434 \u0438 \u0430\u0434\u0440\u0435\u0441 \u044D\u043B\u0435\u043A\u0442\u0440\u043E\u043D\u043D\u043E\u0439 \u043F\u043E\u0447\u0442\u044B."
      },
      {
        timestamp: "03:05",
        speaker: "client",
        text: "\u0421\u043F\u0430\u0441\u0438\u0431\u043E, \u0432\u0441\u0451 \u043F\u043E\u043D\u044F\u0442\u043D\u043E."
      },
      {
        timestamp: "03:08",
        speaker: "operator",
        text: "\u0420\u0430\u0434\u044B \u0431\u044B\u043B\u0438 \u043F\u043E\u043C\u043E\u0447\u044C. \u0425\u043E\u0440\u043E\u0448\u0435\u0433\u043E \u0434\u043D\u044F, \u0434\u043E \u0441\u0432\u0438\u0434\u0430\u043D\u0438\u044F!"
      }
    ],
    audio: null,
    audio_unavailable_reason: "none",
    status: "evaluated",
    facts: {
      operator_joined_index: 3,
      first_reaction_seconds: 31,
      longest_wait_seconds: 31,
      identity_verified_index: 7,
      ending: "normal"
    },
    info: {
      topic: "\u041F\u043E\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435 \u0431\u0440\u043E\u043A\u0435\u0440\u0441\u043A\u043E\u0433\u043E \u0441\u0447\u0451\u0442\u0430 \u0438 \u0441\u043F\u0440\u0430\u0432\u043A\u0430 \u0434\u043B\u044F \u043D\u0430\u043B\u043E\u0433\u043E\u0432\u043E\u0439",
      mood_start: "\u043D\u0435\u0439\u0442\u0440\u0430\u043B\u044C\u043D\u043E\u0435",
      mood_end: "\u043F\u043E\u0437\u0438\u0442\u0438\u0432\u043D\u043E\u0435",
      outcome: "resolved"
    },
    audio_offsets: [],
    voice_measurements: []
  };

  // ../contract/examples/conversation.call-ru.json
  var conversation_call_ru_default = {
    id: "example:p4-ru-001",
    created_at: "2026-11-07T08:55:00Z",
    group_id: "example",
    conversation_id: "p4-ru-001",
    channel: "voice call",
    language: "RU",
    transcript: [
      {
        timestamp: "2026-11-02T10:15:03+05:00",
        speaker: "operator",
        text: "\u0410\u043B\u043B\u043E."
      },
      {
        timestamp: "2026-11-02T10:15:05+05:00",
        speaker: "client",
        text: "\u0417\u0434\u0440\u0430\u0432\u0441\u0442\u0432\u0443\u0439\u0442\u0435, \u043F\u043E\u0434\u0441\u043A\u0430\u0436\u0438\u0442\u0435, \u043A\u0430\u043A\u0430\u044F \u0443 \u0432\u0430\u0441 \u043A\u043E\u043C\u0438\u0441\u0441\u0438\u044F \u0437\u0430 \u0441\u0434\u0435\u043B\u043A\u0438 \u0441 \u0430\u043A\u0446\u0438\u044F\u043C\u0438?"
      },
      {
        timestamp: "2026-11-02T10:15:11+05:00",
        speaker: "operator",
        text: "\u0423\u0442\u043E\u0447\u043D\u0438\u0442\u0435, \u043F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430, \u0432\u0430\u0441 \u0438\u043D\u0442\u0435\u0440\u0435\u0441\u0443\u044E\u0442 \u0441\u0434\u0435\u043B\u043A\u0438 \u043D\u0430 \u0432\u043D\u0443\u0442\u0440\u0435\u043D\u043D\u0435\u043C \u0438\u043B\u0438 \u043D\u0430 \u0437\u0430\u0440\u0443\u0431\u0435\u0436\u043D\u043E\u043C \u0440\u044B\u043D\u043A\u0435?"
      },
      {
        timestamp: "2026-11-02T10:15:18+05:00",
        speaker: "client",
        text: "\u041D\u0430 \u0437\u0430\u0440\u0443\u0431\u0435\u0436\u043D\u043E\u043C. \u0421\u043A\u043E\u043B\u044C\u043A\u043E \u0441\u043E\u0441\u0442\u0430\u0432\u0438\u0442 \u043A\u043E\u043C\u0438\u0441\u0441\u0438\u044F?"
      },
      {
        timestamp: "2026-11-02T10:15:26+05:00",
        speaker: "operator",
        text: "\u041A\u043E\u043C\u0438\u0441\u0441\u0438\u044F \u0437\u0430\u0432\u0438\u0441\u0438\u0442 \u043E\u0442 \u0442\u0430\u0440\u0438\u0444\u043D\u043E\u0433\u043E \u043F\u043B\u0430\u043D\u0430. \u0422\u043E\u0447\u043D\u044B\u0445 \u0446\u0438\u0444\u0440 \u0443 \u043C\u0435\u043D\u044F \u0441\u0435\u0439\u0447\u0430\u0441 \u043D\u0435\u0442."
      },
      {
        timestamp: "2026-11-02T10:15:34+05:00",
        speaker: "client",
        text: "\u0410 \u0433\u0434\u0435 \u043D\u0430 \u0441\u0430\u0439\u0442\u0435 \u043F\u043E\u0441\u043C\u043E\u0442\u0440\u0435\u0442\u044C \u0442\u0430\u0440\u0438\u0444\u044B?"
      },
      {
        timestamp: "2026-11-02T10:15:38+05:00",
        speaker: "operator",
        text: "\u0412\u044B \u0441\u0430\u043C\u0438 \u043D\u0435 \u043F\u043E\u043D\u0438\u043C\u0430\u0435\u0442\u0435, \u0447\u0442\u043E \u0441\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u0435\u0442\u0435. \u042D\u0442\u043E \u0433\u043B\u0443\u043F\u044B\u0439 \u0432\u043E\u043F\u0440\u043E\u0441, \u043D\u0430\u0439\u0434\u0438\u0442\u0435 \u0441\u0430\u043C\u0438."
      },
      {
        timestamp: "2026-11-02T10:15:46+05:00",
        speaker: "client",
        text: "\u041D\u0435 \u043D\u0430\u0434\u043E \u0442\u0430\u043A \u0441\u043E \u043C\u043D\u043E\u0439 \u0440\u0430\u0437\u0433\u043E\u0432\u0430\u0440\u0438\u0432\u0430\u0442\u044C."
      },
      {
        timestamp: "2026-11-02T10:15:49+05:00",
        speaker: "operator",
        text: "\u0412\u0441\u0451, \u0443 \u043C\u0435\u043D\u044F \u0434\u0440\u0443\u0433\u0438\u0435 \u0437\u0432\u043E\u043D\u043A\u0438. \u0414\u043E \u0441\u0432\u0438\u0434\u0430\u043D\u0438\u044F."
      }
    ],
    audio: null,
    audio_unavailable_reason: "needs_import",
    status: "disputed",
    facts: {
      operator_joined_index: 0,
      first_reaction_seconds: 6,
      longest_wait_seconds: 8,
      identity_verified_index: null,
      ending: "normal"
    },
    info: {
      topic: "\u041A\u043E\u043C\u0438\u0441\u0441\u0438\u044F \u0437\u0430 \u0441\u0434\u0435\u043B\u043A\u0438 \u043D\u0430 \u0437\u0430\u0440\u0443\u0431\u0435\u0436\u043D\u043E\u043C \u0440\u044B\u043D\u043A\u0435",
      mood_start: "\u043D\u0435\u0439\u0442\u0440\u0430\u043B\u044C\u043D\u043E\u0435",
      mood_end: "\u0440\u0430\u0437\u0434\u0440\u0430\u0436\u0451\u043D\u043D\u043E\u0435",
      outcome: "unresolved"
    },
    audio_offsets: [
      {
        message_index: 0,
        seconds: 0
      },
      {
        message_index: 1,
        seconds: 2
      },
      {
        message_index: 2,
        seconds: 8
      },
      {
        message_index: 3,
        seconds: 15
      },
      {
        message_index: 4,
        seconds: 23
      },
      {
        message_index: 5,
        seconds: 31
      },
      {
        message_index: 6,
        seconds: 35
      },
      {
        message_index: 7,
        seconds: 43
      },
      {
        message_index: 8,
        seconds: 46
      }
    ],
    voice_measurements: [
      {
        message_index: 0,
        from_seconds: 0,
        to_seconds: 1.4,
        pitch_range: 2.4,
        rate_wpm: 60,
        pauses: 0,
        overlap: 0
      },
      {
        message_index: 2,
        from_seconds: 8,
        to_seconds: 13.6,
        pitch_range: 5.8,
        rate_wpm: 142,
        pauses: 0.6,
        overlap: 0
      },
      {
        message_index: 4,
        from_seconds: 23,
        to_seconds: 28.8,
        pitch_range: 4.1,
        rate_wpm: 131,
        pauses: 1.3,
        overlap: 0
      },
      {
        message_index: 6,
        from_seconds: 35,
        to_seconds: 41.2,
        pitch_range: 9.6,
        rate_wpm: 168,
        pauses: 0,
        overlap: 0.8
      },
      {
        message_index: 8,
        from_seconds: 46,
        to_seconds: 49.5,
        pitch_range: 7.2,
        rate_wpm: 176,
        pauses: 0,
        overlap: 0
      }
    ]
  };

  // src/api/mock/fixtures.js
  var OFFICIAL_SEED = official_chat_v1_default;
  var DEFAULT_CHECKLIST = Object.freeze({
    checklist_id: official_chat_v1_default.checklist_id,
    version: official_chat_v1_default.version
  });
  var MODEL = "mock";
  var OWN_FIELDS = ["id", "created_at", "group_id", "status", "facts", "audio", "audio_unavailable_reason"];
  function exampleRecords() {
    return [conversation_chat_ru_default, conversation_call_ru_default].map((conversation) => {
      const record = structuredClone(conversation);
      for (const field of OWN_FIELDS) delete record[field];
      return record;
    });
  }

  // src/domain/prng.js
  function fnv1a32(str) {
    let h2 = 2166136261;
    for (const byte of new TextEncoder().encode(String(str))) {
      h2 ^= byte;
      h2 = Math.imul(h2, 16777619) >>> 0;
    }
    return h2 >>> 0;
  }
  function seeded(str) {
    let a = fnv1a32(str);
    return function next() {
      a = a + 1831565813 | 0;
      let t2 = Math.imul(a ^ a >>> 15, 1 | a);
      t2 = t2 + Math.imul(t2 ^ t2 >>> 7, 61 | t2) ^ t2;
      return ((t2 ^ t2 >>> 14) >>> 0) / 4294967296;
    };
  }

  // src/api/mock/grader.js
  var RATES = Object.freeze({
    na: 0.2,
    // N/A, where the criterion allows it
    grossYes: 0.05,
    // a gross error found
    lowConfidence: 0.1,
    // confidence "low", which also sets needs_review
    yes: 0.75,
    // "yes" on a yes/no criterion
    referenceFlip: 0.15,
    // the reference grader disagrees
    secondOpinionDiffers: 0.6
    // the second opinion differs from the graded answer
  });
  var DEMO = "\u0414\u0435\u043C\u043E-\u043E\u0446\u0435\u043D\u043A\u0430:";
  var sameAnswer = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  var sortedSteps = (criterion) => [...criterion.scale_steps ?? []].sort((a, b) => a.value - b.value);
  var stripNaPrefix = (text2) => String(text2 ?? "").replace(/^N\/A\s*[—–-]\s*/i, "");
  var capitalize = (text2) => text2.charAt(0).toUpperCase() + text2.slice(1);
  var stripYesPrefix = (text2) => String(text2 ?? "").replace(/^Да\s*[—–-]\s*/, "");
  function answerLabel(answer) {
    if (answer === "yes") return "\u0414\u0430";
    if (answer === "no") return "\u041D\u0435\u0442";
    if (answer === "na") return "N/A";
    if (answer !== null && typeof answer === "object") return `\u0448\u0430\u0433 ${answer.step}`;
    return "";
  }
  function allowedAnswers(criterion) {
    const base = criterion.answer_type === "scale" ? sortedSteps(criterion).map((s) => ({ step: s.value })) : ["yes", "no"];
    return criterion.na_allowed ? [...base, "na"] : base;
  }
  var alternative = (criterion, answer, u) => {
    const options = allowedAnswers(criterion).filter((a) => !sameAnswer(a, answer));
    return options.length === 0 ? answer : options[Math.min(options.length - 1, Math.floor(u * options.length))];
  };
  function operatorLines(transcript) {
    const all = [];
    const fresh = [];
    transcript.forEach((line, index) => {
      if (line.speaker !== "operator") return;
      all.push(index);
      if (!line.duplicate) fresh.push(index);
    });
    return fresh.length > 0 ? fresh : all;
  }
  var evidenceAt = (transcript, index, role) => ({ message_index: index, quote: transcript[index].text, role });
  function gradeCriterion(conversation, criterion) {
    const rng = seeded(`${conversation.id}${criterion.fingerprint}`);
    const [uNa, uAnswer, uLow, uMedium, uLine, uKind] = [rng(), rng(), rng(), rng(), rng(), rng()];
    const steps = sortedSteps(criterion);
    const top = steps.length > 0 ? steps[steps.length - 1].value : null;
    const isScale = criterion.answer_type === "scale" && steps.length > 0;
    const isGross = criterion.kind === "gross_error";
    let answer;
    if (criterion.na_allowed && uNa < RATES.na) answer = "na";
    else if (isScale) {
      const position = Math.max(0, steps.length - 1 - Math.floor(uAnswer * uAnswer * steps.length));
      answer = { step: steps[position].value };
    } else if (isGross) answer = uAnswer < RATES.grossYes ? "yes" : "no";
    else answer = uAnswer < RATES.yes ? "yes" : "no";
    const kinds = isGross && answer === "yes" && (criterion.kinds ?? []).length > 0 ? [criterion.kinds[Math.min(criterion.kinds.length - 1, Math.floor(uKind * criterion.kinds.length))]] : [];
    const missed = !isGross && (answer === "no" || isScale && answer !== "na" && answer.step < top);
    const flagged = isGross && answer === "yes";
    const lines = conversation.transcript ?? [];
    const last = lines.length - 1;
    const operators = operatorLines(lines);
    let evidence = [];
    let checkedRange = null;
    if (lines.length > 0 && operators.length === 0) {
      evidence = [evidenceAt(lines, last, "expected_here")];
      checkedRange = { from: 0, to: last };
    } else if (operators.length > 0) {
      const pick = Math.min(operators.length - 1, Math.floor(uLine * operators.length));
      const other = operators.length > 1 ? operators[(pick + 1) % operators.length] : null;
      const range = { from: operators[0], to: last };
      if (isGross && !flagged) {
        checkedRange = range;
      } else if (missed) {
        evidence = [evidenceAt(lines, operators[pick], "expected_here")];
        if (isScale && answer.step > steps[0].value && other !== null) evidence.push(evidenceAt(lines, other, "supports"));
        checkedRange = range;
      } else {
        evidence = [evidenceAt(lines, operators[pick], "supports")];
        if (other !== null && uMedium < 0.5) evidence.push(evidenceAt(lines, other, "supports"));
      }
      evidence.sort((a, b) => a.message_index - b.message_index);
    }
    const confidence = uLow < RATES.lowConfidence ? "low" : uMedium < 0.35 ? "medium" : "high";
    const stepRow = isScale && answer !== "na" ? steps.find((s) => s.value === answer.step) : null;
    let explanation;
    if (answer === "na") {
      explanation = `${DEMO} \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0439 \xAB${criterion.title}\xBB \u043D\u0435\u043F\u0440\u0438\u043C\u0435\u043D\u0438\u043C. ${capitalize(stripNaPrefix(criterion.na_condition))}`;
    } else if (isGross) {
      explanation = flagged ? `${DEMO} \u0432 \u0440\u0435\u043F\u043B\u0438\u043A\u0435 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0430 \u0432\u044B\u044F\u0432\u043B\u0435\u043D\u043E \u043D\u0430\u0440\u0443\u0448\u0435\u043D\u0438\u0435 (${kinds.join(", ") || "\u0432\u0438\u0434 \u043D\u0435 \u0443\u043A\u0430\u0437\u0430\u043D"}).` : `${DEMO} \u0433\u0440\u0443\u0431\u044B\u0445 \u043D\u0430\u0440\u0443\u0448\u0435\u043D\u0438\u0439 \u0432 \u0440\u0435\u043F\u043B\u0438\u043A\u0430\u0445 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0430 \u043D\u0435 \u0432\u044B\u044F\u0432\u043B\u0435\u043D\u043E.`;
    } else if (isScale) {
      explanation = `${DEMO} \u0448\u0430\u0433 ${answer.step} \u0438\u0437 ${top}. ${stepRow?.label ?? ""}`.trim();
    } else if (answer === "yes") {
      explanation = `${DEMO} \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0439 \xAB${criterion.title}\xBB \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D: \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440 \u0434\u0435\u0439\u0441\u0442\u0432\u043E\u0432\u0430\u043B \u0442\u0430\u043A, \u043A\u0430\u043A \u0442\u0440\u0435\u0431\u0443\u0435\u0442 \u0444\u043E\u0440\u043C\u0443\u043B\u0438\u0440\u043E\u0432\u043A\u0430.`;
    } else {
      explanation = `${DEMO} \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0439 \xAB${criterion.title}\xBB \u043D\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D: \u0432 \u0434\u0438\u0430\u043B\u043E\u0433\u0435 \u043D\u0435\u0442 \u043D\u0443\u0436\u043D\u043E\u0433\u043E \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0430.`;
    }
    let coaching = null;
    if (flagged) {
      coaching = `\u0414\u0435\u043C\u043E-\u043F\u043E\u0434\u0441\u043A\u0430\u0437\u043A\u0430: \u0438\u0441\u043A\u043B\u044E\u0447\u0438\u0442\u0435 \u0442\u0430\u043A\u0438\u0435 \u0440\u0435\u043F\u043B\u0438\u043A\u0438. \u041E\u0442\u0432\u0435\u0447\u0430\u0439\u0442\u0435 \u0432\u0435\u0436\u043B\u0438\u0432\u043E \u0438 \u0442\u043E\u043B\u044C\u043A\u043E \u043F\u043E \u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0443 \u0432\u043E\u043F\u0440\u043E\u0441\u0430 \u043A\u043B\u0438\u0435\u043D\u0442\u0430.`;
    } else if (missed && isScale) {
      coaching = `\u0414\u0435\u043C\u043E-\u043F\u043E\u0434\u0441\u043A\u0430\u0437\u043A\u0430: \u0447\u0442\u043E\u0431\u044B \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u043C\u0430\u043A\u0441\u0438\u043C\u0443\u043C \u043F\u043E \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044E \xAB${criterion.title}\xBB, \u0434\u043E\u0431\u0435\u0439\u0442\u0435\u0441\u044C: ${steps[steps.length - 1].label}`;
    } else if (missed) {
      coaching = `\u0414\u0435\u043C\u043E-\u043F\u043E\u0434\u0441\u043A\u0430\u0437\u043A\u0430: \u043F\u043E \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044E \xAB${criterion.title}\xBB \u043D\u0443\u0436\u043D\u043E, \u0447\u0442\u043E\u0431\u044B ${stripYesPrefix(criterion.wording).replace(/\.$/, "")}.`;
    }
    return {
      criterion_id: criterion.id,
      answer,
      final_answer: answer,
      kinds,
      points: null,
      effective_weight: null,
      explanation,
      evidence,
      checked_range: checkedRange,
      na_reason: answer === "na" ? `\u0423\u0441\u043B\u043E\u0432\u0438\u0435 \u043D\u0435\u043F\u0440\u0438\u043C\u0435\u043D\u0438\u043C\u043E\u0441\u0442\u0438 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u043E: ${stripNaPrefix(criterion.na_condition)}` : null,
      confidence,
      needs_review: confidence === "low",
      coaching,
      reused: false,
      carried_decision: null
    };
  }
  function gradeReference(conversation, version2) {
    return version2.criteria.map((criterion) => {
      const modelAnswer = gradeCriterion(conversation, criterion).answer;
      const rng = seeded(`${conversation.id}${criterion.fingerprint}|reference`);
      const flip = rng() < RATES.referenceFlip;
      const pick = rng();
      return { criterion_id: criterion.id, answer: flip ? alternative(criterion, modelAnswer, pick) : modelAnswer };
    });
  }
  function secondOpinion(conversation, criterion, current2) {
    const rng = seeded(`${conversation.id}${criterion.fingerprint}|second`);
    const differs = rng() < RATES.secondOpinionDiffers;
    const answer = differs ? alternative(criterion, current2, rng()) : current2;
    const same = sameAnswer(answer, current2);
    const reasoning = same ? `\u0414\u0435\u043C\u043E-\u0432\u0442\u043E\u0440\u043E\u0435 \u043C\u043D\u0435\u043D\u0438\u0435: \u0438\u0441\u0445\u043E\u0434\u043D\u0430\u044F \u043E\u0446\u0435\u043D\u043A\u0430 \xAB${answerLabel(current2)}\xBB \u043F\u043E \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044E \xAB${criterion.title}\xBB \u0432\u044B\u0433\u043B\u044F\u0434\u0438\u0442 \u0432\u0435\u0440\u043D\u043E\u0439.` : `\u0414\u0435\u043C\u043E-\u0432\u0442\u043E\u0440\u043E\u0435 \u043C\u043D\u0435\u043D\u0438\u0435: \u043F\u043E \u0440\u0435\u043F\u043B\u0438\u043A\u0430\u043C \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0430 \u043E\u0442\u0432\u0435\u0442 \xAB${answerLabel(answer)}\xBB \u043F\u043E\u0434\u0445\u043E\u0434\u0438\u0442 \u043B\u0443\u0447\u0448\u0435, \u0447\u0435\u043C \xAB${answerLabel(current2)}\xBB.`;
    return { answer, reasoning };
  }
  var MOODS = ["\u043D\u0435\u0439\u0442\u0440\u0430\u043B\u044C\u043D\u043E\u0435", "\u043F\u043E\u0437\u0438\u0442\u0438\u0432\u043D\u043E\u0435", "\u0440\u0430\u0437\u0434\u0440\u0430\u0436\u0451\u043D\u043D\u043E\u0435", "\u0442\u0440\u0435\u0432\u043E\u0436\u043D\u043E\u0435"];
  var OUTCOMES = ["resolved", "passed_to_specialists", "unresolved"];
  function mockInfo(conversation) {
    const rng = seeded(`${conversation.id}|info`);
    const first = (conversation.transcript ?? []).find((m) => m.speaker === "client" && m.text.trim() !== "");
    const text2 = first ? first.text.trim().replace(/\s+/g, " ") : "";
    const topic = text2.length > 80 ? `${text2.slice(0, 79).trimEnd()}\u2026` : text2 || null;
    return {
      topic,
      mood_start: MOODS[Math.floor(rng() * MOODS.length)],
      mood_end: MOODS[Math.floor(rng() * MOODS.length)],
      outcome: conversation.facts?.ending === "client_left" ? "client_left" : OUTCOMES[Math.floor(rng() * OUTCOMES.length)]
    };
  }

  // src/api/mock/evaluation.js
  var MODEL_FIELDS = ["answer", "kinds", "explanation", "evidence", "checked_range", "na_reason", "confidence", "needs_review", "coaching"];
  var pickModelFields = (result) => Object.fromEntries(MODEL_FIELDS.map((key) => [key, structuredClone(result[key])]));
  function collectReusable(evaluations, evalMeta, conversationId, hash) {
    const found = /* @__PURE__ */ new Map();
    for (let i = evaluations.length - 1; i >= 0; i -= 1) {
      const ev = evaluations[i];
      if (ev.conversation !== conversationId || ev.status !== "done") continue;
      const meta = evalMeta[ev.id];
      if (!meta || meta.hash !== hash) continue;
      for (const [criterionId, fp] of Object.entries(meta.fps)) {
        if (found.has(fp)) continue;
        const result = ev.results.find((r) => r.criterion_id === criterionId);
        if (result) found.set(fp, result);
      }
    }
    return found;
  }
  function countCalls(version2, reusable, mode) {
    const reused = mode === "full" ? 0 : version2.criteria.filter((c) => reusable.has(c.fingerprint)).length;
    return { modelCalls: version2.criteria.length - reused, reused };
  }
  function carriedAppeal(criterion, conversationId, hash, appeals, evalMeta) {
    let best = null;
    const at = (appeal) => Date.parse(appeal.decision.decided_at) || 0;
    for (const appeal of appeals) {
      if (appeal.status !== "decided" || !appeal.decision) continue;
      if (appeal.conversation !== conversationId || appeal.criterion_id !== criterion.id) continue;
      const meta = evalMeta[appeal.evaluation_id];
      if (!meta || meta.hash !== hash || meta.fps[appeal.criterion_id] !== criterion.fingerprint) continue;
      if (validateAnswer(criterion, appeal.decision.answer) !== null) continue;
      if (best === null || at(appeal) >= at(best)) best = appeal;
    }
    return best;
  }
  function recompute(evaluation, version2) {
    const modelAnswers = Object.fromEntries(
      evaluation.results.map((r) => [r.criterion_id, { answer: r.answer, ...r.kinds.length > 0 ? { kinds: r.kinds } : {} }])
    );
    const original = score(version2, modelAnswers);
    const final = score(version2, finalAnswers(evaluation, []));
    const byId = new Map(final.results.map((r) => [r.criterion_id, r]));
    for (const result of evaluation.results) {
      const row = byId.get(result.criterion_id);
      result.points = row.points;
      result.effective_weight = row.effective_weight;
    }
    evaluation.original_total = original.total;
    evaluation.final_total = final.total;
    evaluation.sections = final.sections;
    const gross = evaluation.results.filter((r) => version2.criteria.find((c) => c.id === r.criterion_id)?.kind === "gross_error");
    const shown = gross.find((r) => r.final_answer === "yes") ?? gross[0];
    evaluation.gross_error = {
      flag: final.gross_error.flag,
      kinds: final.gross_error.kinds,
      explanation: shown ? shown.explanation : null,
      evidence: shown ? structuredClone(shown.evidence) : []
    };
    return evaluation;
  }
  function buildEvaluation({ id, createdAt, conversation, version: version2, hash, mode, reusable, appeals, evalMeta }) {
    const results = version2.criteria.map((criterion) => {
      const prior = mode === "full" ? void 0 : reusable.get(criterion.fingerprint);
      const model = prior ? { ...pickModelFields(prior), reused: true } : { ...gradeCriterion(conversation, criterion), reused: false };
      const appeal = carriedAppeal(criterion, conversation.id, hash, appeals, evalMeta);
      return {
        ...model,
        criterion_id: criterion.id,
        final_answer: structuredClone(appeal ? appeal.decision.answer : model.answer),
        points: null,
        effective_weight: null,
        carried_decision: appeal ? { appeal_id: appeal.id, evaluation_id: appeal.evaluation_id } : null
      };
    });
    const evaluation = {
      id,
      created_at: createdAt,
      conversation: conversation.id,
      checklist_id: version2.checklist_id,
      version: version2.version,
      status: "done",
      source: "mock",
      model: MODEL,
      cost_usd: 0,
      results,
      original_total: null,
      final_total: null,
      sections: [],
      gross_error: { flag: false, kinds: [], explanation: null, evidence: [] }
    };
    recompute(evaluation, version2);
    return {
      evaluation,
      meta: { hash, fps: Object.fromEntries(version2.criteria.map((c) => [c.id, c.fingerprint])) }
    };
  }

  // src/api/mock/persist.js
  var STORAGE_KEY = "cqa-mock-v1";
  var SCHEMA = 1;
  var ARRAYS = ["checklists", "evaluations", "appeals", "jobs"];
  var OBJECTS = ["seq", "conversations", "hashes", "evalMeta", "appealMeta", "jobMeta", "translations"];
  var emptyState = () => ({
    schema: SCHEMA,
    seq: {},
    // id counters per prefix
    conversations: {},
    // id -> conversation (not the dev ones)
    hashes: {},
    // id -> transcript hash, for every conversation seen
    checklists: [],
    // [{checklist_id, versions: [checklist version, ...]}]
    evaluations: [],
    // in creation order
    evalMeta: {},
    // evaluation id -> {hash, fps: {criterion_id: fingerprint}}
    appeals: [],
    appealMeta: {},
    // appeal id -> {ready_at}
    jobs: [],
    jobMeta: {},
    // job id -> {checklist_id, version, mode, cursor}
    translations: {}
    // "id|to" -> messages
  });
  var isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  function resolveStorage(option) {
    if (option !== void 0) return option;
    try {
      const ls = globalThis.localStorage;
      if (!ls) return null;
      const probe = `${STORAGE_KEY}-probe`;
      ls.setItem(probe, "1");
      ls.removeItem(probe);
      return ls;
    } catch {
      return null;
    }
  }
  function load(backend, key) {
    if (!backend) return emptyState();
    try {
      const parsed = JSON.parse(backend.getItem(key));
      if (!isPlainObject(parsed) || parsed.schema !== SCHEMA) return emptyState();
      if (!ARRAYS.every((k) => Array.isArray(parsed[k])) || !OBJECTS.every((k) => isPlainObject(parsed[k]))) {
        return emptyState();
      }
      return { ...emptyState(), ...parsed };
    } catch {
      return emptyState();
    }
  }
  function openStore({ storage, key = STORAGE_KEY } = {}) {
    const backend = resolveStorage(storage);
    const state = load(backend, key);
    const volatile = {};
    let dirty = false;
    let failed = false;
    return {
      state,
      volatile,
      /** True while writes to the backend succeed. */
      get persistent() {
        return backend !== null && !failed;
      },
      /** Marks the state changed; `flush()` writes it. */
      touch() {
        dirty = true;
      },
      flush() {
        if (!dirty) return;
        dirty = false;
        if (!backend) return;
        try {
          backend.setItem(key, JSON.stringify(state));
          failed = false;
        } catch {
          failed = true;
        }
      },
      /** "ev-0007": a counter per prefix, kept in the state so ids continue after a reload. */
      nextId(prefix) {
        state.seq[prefix] = (state.seq[prefix] ?? 0) + 1;
        dirty = true;
        return `${prefix}-${String(state.seq[prefix]).padStart(4, "0")}`;
      }
    };
  }

  // src/domain/csv.js
  var BOM = "\uFEFF";
  var SEPARATOR = ";";
  var EOL = "\r\n";
  var NEEDS_QUOTES = /[;"\r\n]/;
  function csvField(value) {
    if (value === null || value === void 0) return "";
    const text2 = String(value);
    return NEEDS_QUOTES.test(text2) ? `"${text2.replaceAll('"', '""')}"` : text2;
  }
  function toCsv(rows, columns) {
    const cols = columns.map((c) => typeof c === "string" ? { key: c, header: c } : c);
    const lines = [cols.map((c) => csvField(c.header ?? c.key))];
    for (const row of rows) {
      lines.push(cols.map((c) => csvField(typeof c.value === "function" ? c.value(row) : row?.[c.key])));
    }
    return BOM + lines.map((line) => line.join(SEPARATOR) + EOL).join("");
  }

  // src/api/mock/reports.js
  var REFERENCE_NOTE = "\u0414\u0435\u043C\u043E: \u044D\u0442\u0430\u043B\u043E\u043D \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043D";
  var hundredths2 = (x) => Math.round(x * 100);
  var fromHundredths = (n) => n / 100;
  var round22 = (x) => fromHundredths(hundredths2(x));
  var sameAnswer2 = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  var rate = (part, whole) => whole === 0 ? 0 : round22(part / whole);
  function buildComparison(ctx, { from, to, groupId, conversations }) {
    const header = (ref) => ({ checklist_id: ref.checklist_id, version: ref.version, name: ctx.version(ref.checklist_id, ref.version).name });
    const wanted = conversations ? new Set(conversations) : null;
    const rows = [];
    for (const conv of ctx.conversations()) {
      if (wanted && !wanted.has(conv.id)) continue;
      if (!wanted && groupId && conv.group_id !== groupId) continue;
      const before = ctx.latestEvaluation(conv.id, from.checklist_id, from.version);
      const after = ctx.latestEvaluation(conv.id, to.checklist_id, to.version);
      if (!before || !after) continue;
      const delta = before.final_total === null || after.final_total === null ? null : fromHundredths(hundredths2(after.final_total) - hundredths2(before.final_total));
      rows.push({
        conversation: conv.id,
        conversation_id: conv.conversation_id,
        group_id: conv.group_id,
        old_total: before.final_total,
        new_total: after.final_total,
        delta
      });
    }
    const deltas = rows.map((r) => r.delta).filter((d) => d !== null);
    return {
      from: header(from),
      to: header(to),
      summary: {
        total: rows.length,
        changed: deltas.filter((d) => d !== 0).length,
        avg_delta: deltas.length === 0 ? null : fromHundredths(Math.round(deltas.reduce((a, d) => a + hundredths2(d), 0) / deltas.length))
      },
      rows
    };
  }
  function buildAccuracy(ctx) {
    const version2 = ctx.version(ctx.defaultChecklist.checklist_id, ctx.defaultChecklist.version);
    const byCriterion = new Map(version2.criteria.map((c) => [c.id, { criterion_id: c.id, title: c.title, hit: 0, n: 0 }]));
    const byLanguage = /* @__PURE__ */ new Map();
    const byChannel = /* @__PURE__ */ new Map();
    const disagreements = [];
    let hit = 0;
    let n = 0;
    let missing = 0;
    let disputed = 0;
    const tick = (map, key, field, matched) => {
      const row = map.get(key) ?? { [field]: key, hit: 0, n: 0 };
      row.n += 1;
      if (matched) row.hit += 1;
      map.set(key, row);
    };
    for (const conv of ctx.conversations()) {
      const evaluation = ctx.latestEvaluation(conv.id, version2.checklist_id, version2.version);
      if (!evaluation) {
        missing += version2.criteria.length;
        continue;
      }
      const reference = new Map(gradeReference(conv, version2).map((r) => [r.criterion_id, r.answer]));
      for (const result of evaluation.results) {
        if (!byCriterion.has(result.criterion_id)) continue;
        const hasAppeal = ctx.appeals.some((a) => a.evaluation_id === evaluation.id && a.criterion_id === result.criterion_id);
        if (hasAppeal) {
          disputed += 1;
          continue;
        }
        const expected = reference.get(result.criterion_id);
        const matched = sameAnswer2(expected, result.answer);
        n += 1;
        if (matched) hit += 1;
        else disagreements.push({ conversation: conv.id, conversation_id: conv.conversation_id, criterion_id: result.criterion_id, reference: expected, evaluated: result.answer });
        const row = byCriterion.get(result.criterion_id);
        row.n += 1;
        if (matched) row.hit += 1;
        tick(byLanguage, conv.language, "language", matched);
        tick(byChannel, conv.channel, "channel", matched);
      }
    }
    const strip = ({ hit: h2, n: count, ...rest }) => ({ ...rest, agreement: rate(h2, count), n: count });
    return {
      reference_note: REFERENCE_NOTE,
      model: MODEL,
      overall: { agreement: rate(hit, n), n },
      by_criterion: [...byCriterion.values()].filter((r) => r.n > 0).map(strip),
      by_language: [...byLanguage.values()].map(strip),
      by_channel: [...byChannel.values()].map(strip),
      missing,
      disputed_excluded: disputed,
      disagreements
    };
  }
  var average = (totals) => totals.length === 0 ? null : fromHundredths(Math.round(totals.reduce((a, t2) => a + hundredths2(t2), 0) / totals.length));
  function buildAnalytics(ctx) {
    const version2 = ctx.version(ctx.defaultChecklist.checklist_id, ctx.defaultChecklist.version);
    const scored = version2.criteria.filter((c) => c.kind !== "gross_error");
    const topOf = (c) => c.answer_type === "scale" ? Math.max(...c.scale_steps.map((s) => s.value)) : null;
    const stats = new Map(scored.map((c) => [c.id, { c, n: 0, na: 0, fail: 0 }]));
    const byLanguage = /* @__PURE__ */ new Map();
    const byChannel = /* @__PURE__ */ new Map();
    const grossKinds = /* @__PURE__ */ new Map();
    const grossConversations = [];
    for (const conv of ctx.conversations()) {
      const evaluation = ctx.latestEvaluation(conv.id, version2.checklist_id, version2.version);
      if (!evaluation) continue;
      for (const result of evaluation.results) {
        const s = stats.get(result.criterion_id);
        if (!s) continue;
        const answer = result.final_answer;
        s.n += 1;
        if (answer === "na") s.na += 1;
        else if (answer === "no" || typeof answer === "object" && answer.step < topOf(s.c)) s.fail += 1;
      }
      for (const [map, key, field] of [[byLanguage, conv.language, "language"], [byChannel, conv.channel, "channel"]]) {
        const row = map.get(key) ?? { [field]: key, totals: [], n: 0 };
        row.n += 1;
        if (evaluation.final_total !== null) row.totals.push(evaluation.final_total);
        map.set(key, row);
      }
      if (evaluation.gross_error.flag) {
        grossConversations.push(conv.id);
        for (const kind of evaluation.gross_error.kinds) grossKinds.set(kind, (grossKinds.get(kind) ?? 0) + 1);
      }
    }
    const strip = ({ totals, n, ...rest }) => ({ ...rest, avg_total: average(totals), n });
    return {
      by_criterion: [...stats.values()].filter((s) => s.n > 0).map((s) => ({ criterion_id: s.c.id, title: s.c.title, fail_rate: rate(s.fail, s.n - s.na), na_rate: rate(s.na, s.n), n: s.n })),
      by_language: [...byLanguage.values()].map(strip),
      by_channel: [...byChannel.values()].map(strip),
      gross_errors: {
        count: grossConversations.length,
        by_kind: [...grossKinds].map(([kind, count]) => ({ kind, count })),
        conversations: grossConversations
      }
    };
  }
  var decimal = (n) => n === null || n === void 0 ? "" : String(n).replace(".", ",");
  var CHANNELS = { "agent chat": "\u0447\u0430\u0442", "voice call": "\u0437\u0432\u043E\u043D\u043E\u043A" };
  function buildCsv(ctx, groupId) {
    const version2 = ctx.version(ctx.defaultChecklist.checklist_id, ctx.defaultChecklist.version) ?? { name: "", criteria: [] };
    const columns = [
      { key: "group_id", header: "\u0413\u0440\u0443\u043F\u043F\u0430" },
      { key: "conversation_id", header: "\u0414\u0438\u0430\u043B\u043E\u0433" },
      { key: "channel", header: "\u041A\u0430\u043D\u0430\u043B", value: (r) => CHANNELS[r.conv.channel] ?? r.conv.channel },
      { key: "language", header: "\u042F\u0437\u044B\u043A", value: (r) => r.conv.language },
      { key: "checklist", header: "\u0427\u0435\u043A-\u043B\u0438\u0441\u0442", value: (r) => r.ev ? `${version2.name} v${r.ev.version}` : "" },
      { key: "total", header: "\u0418\u0442\u043E\u0433", value: (r) => decimal(r.ev?.final_total) },
      { key: "original", header: "\u0418\u0442\u043E\u0433 \u043C\u043E\u0434\u0435\u043B\u0438", value: (r) => decimal(r.ev?.original_total) },
      { key: "gross", header: "\u0413\u0440\u0443\u0431\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430", value: (r) => r.ev ? r.ev.gross_error.flag ? "\u0414\u0430" : "\u041D\u0435\u0442" : "" },
      { key: "kinds", header: "\u0412\u0438\u0434\u044B \u043D\u0430\u0440\u0443\u0448\u0435\u043D\u0438\u0439", value: (r) => r.ev?.gross_error.kinds.join(", ") ?? "" }
    ];
    for (const criterion of version2.criteria) {
      const result = (r) => r.ev?.results.find((x) => x.criterion_id === criterion.id);
      columns.push({ key: `${criterion.id}-answer`, header: `${criterion.title}: \u043E\u0442\u0432\u0435\u0442`, value: (r) => answerLabel(result(r)?.final_answer) });
      if (criterion.kind !== "gross_error") {
        columns.push({ key: `${criterion.id}-points`, header: `${criterion.title}: \u0431\u0430\u043B\u043B\u044B`, value: (r) => decimal(result(r)?.points) });
      }
    }
    columns.push({ key: "source", header: "\u0418\u0441\u0442\u043E\u0447\u043D\u0438\u043A", value: (r) => r.ev ? "\u0434\u0435\u043C\u043E-\u043E\u0446\u0435\u043D\u043A\u0430" : "" });
    const rows = ctx.conversations().filter((conv) => !groupId || conv.group_id === groupId).map((conv) => ({ ...conv, conv, ev: ctx.latestEvaluation(conv.id, version2.checklist_id, version2.version) }));
    return toCsv(rows, columns);
  }

  // src/api/mock/index.js
  var ROLES2 = /* @__PURE__ */ new Set(["controller", "reviewer"]);
  var STATUS = Object.freeze({
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
    no_records: 422
  });
  function fail(code, message) {
    const status = STATUS[code] ?? (code.startsWith("bad_record:") ? 422 : CLIENT_CODES.includes(code) ? null : 500);
    return new ApiError(code, message, { status });
  }
  function weightWarnings(criteria) {
    const sum = Number(criteria.filter((c) => c.kind === "scored").reduce((total, c) => total + c.weight, 0).toFixed(6));
    return sum === 100 ? [] : [`weights_sum_${sum}`];
  }
  var text = (value) => typeof value === "string" ? value.trim() : "";
  function createMockApi(options = {}) {
    const {
      devDataUrl = null,
      devAudioBase = null,
      mockModelKey = true,
      mockDelayMs = 600,
      mockFault = {},
      role = () => "controller",
      storage,
      fetchImpl = globalThis.fetch,
      now = () => Date.now()
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
      if (!ROLES2.has(value)) throw new TypeError(`createMockApi: role() returned ${JSON.stringify(value)}`);
      return value;
    };
    const lookupConversation = (id) => volatile[id] ?? state.conversations[id];
    function allConversations() {
      const byId = new Map(Object.entries(state.conversations));
      for (const [id, conv] of Object.entries(volatile)) byId.set(id, conv);
      return [...byId.values()];
    }
    const findChecklist = (id) => state.checklists.find((c) => c.checklist_id === id);
    const latestVersion = (row) => row.versions[row.versions.length - 1];
    function findVersion(checklistId, version2) {
      const row = findChecklist(checklistId);
      const number = Number(version2);
      return row ? row.versions.find((v) => v.version === number) : void 0;
    }
    const findEvaluation = (id) => state.evaluations.find((e) => e.id === id);
    const findAppeal = (id) => state.appeals.find((a) => a.id === id);
    function latestEvaluation(conversationId, checklistId, version2) {
      for (let i = state.evaluations.length - 1; i >= 0; i -= 1) {
        const ev = state.evaluations[i];
        if (ev.conversation !== conversationId || ev.status !== "done" || ev.checklist_id !== checklistId) continue;
        if (version2 !== void 0 && ev.version !== Number(version2)) continue;
        return ev;
      }
      return void 0;
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
        needs_review: ev.results.some((r) => r.needs_review)
      };
    }
    async function seedOfficial() {
      if (findChecklist(OFFICIAL_SEED.checklist_id)) return;
      const criteria = await Promise.all(
        OFFICIAL_SEED.criteria.map(async (c) => ({ ...structuredClone(c), fingerprint: await fingerprint(c) }))
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
            criteria
          }
        ]
      });
      store.touch();
    }
    const ready = seedOfficial().then(() => store.flush());
    ready.catch(() => {
    });
    async function fetchDevRecords() {
      if (typeof fetchImpl !== "function") throw fail("network", "No fetch available for the dev data");
      let body;
      try {
        const doFetch = fetchImpl;
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
          throw fail(error.code === "not_json" ? "invalid_request" : error.code, `Unusable upload: ${error.code}`);
        }
        throw error;
      }
    }
    async function importRecords(groupId, records, { isVolatile }) {
      let imported = 0;
      let updated = 0;
      let unchanged = 0;
      const createdAt = iso(now());
      for (const record of records) {
        const conv = toConversation(record, groupId, { audioBase: devAudioBase, createdAt });
        const hash = await transcriptHash(conv.transcript);
        const known = state.hashes[conv.id];
        if (known === void 0) imported += 1;
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
    const exampleIds = new Set(exampleRecords().map((r) => r.conversation_id));
    async function resolveConversation(id) {
      const key = text(id);
      const found = lookupConversation(key);
      if (found) return found;
      const cut = key.indexOf(":");
      const group = key.slice(0, cut);
      if (cut > 0 && (group === "DEV" && devDataUrl || exampleIds.has(key.slice(cut + 1)))) {
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
        const current2 = statusOf(conv.id);
        if (group_id && conv.group_id !== group_id) continue;
        if (status && current2 !== status) continue;
        if (channel && conv.channel !== channel) continue;
        if (language && conv.language !== language) continue;
        if (needle) {
          const haystack = [conv.id, conv.info?.topic ?? "", ...conv.transcript.map((m) => m.text)].join("\n").toLowerCase();
          if (!haystack.includes(needle)) continue;
        }
        const { transcript: _omitted, ...item } = conv;
        items.push({ ...item, status: current2, final: finalOf(conv.id) });
      }
      return items;
    }
    async function getTranslation(id, to = "ru") {
      const conv = await resolveConversation(id);
      const key = `${conv.id}|${to}`;
      if (!state.translations[key]) {
        state.translations[key] = conv.transcript.map((m, i) => ({ message_index: i, text: `[\u0434\u0435\u043C\u043E-\u043F\u0435\u0440\u0435\u0432\u043E\u0434] ${m.text}` }));
        store.touch();
      }
      return { conversation: conv.id, to, messages: state.translations[key] };
    }
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
      versions: row.versions.map((v) => ({ version: v.version, created_at: v.created_at, author_role: v.author_role }))
    });
    function withWarnings(version2) {
      const warnings = weightWarnings(version2.criteria);
      return warnings.length > 0 ? { ...version2, warnings } : version2;
    }
    async function listChecklists() {
      return state.checklists.map(summaryOf);
    }
    async function getChecklistVersion(checklistId, version2) {
      const found = findVersion(checklistId, version2);
      if (!found) throw fail("not_found", `No checklist version ${checklistId} v${version2}`);
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
        { ...body, name: body?.name ?? (source ? `${source.name} (\u043A\u043E\u043F\u0438\u044F)` : void 0) },
        source
      );
      const checklistId = store.nextId("ck");
      const version2 = {
        id: store.nextId("chv"),
        created_at: iso(now()),
        checklist_id: checklistId,
        version: 1,
        ...completed,
        locked: false,
        based_on: basedOn,
        author_role: authorRole
      };
      state.checklists.push({ checklist_id: checklistId, versions: [version2] });
      store.touch();
      return withWarnings(version2);
    }
    async function saveChecklistVersion(checklistId, body = {}) {
      const authorRole = currentRole();
      const row = findChecklist(checklistId);
      if (!row) throw fail("not_found", `No checklist ${checklistId}`);
      const previous = latestVersion(row);
      if (previous.locked) throw fail("checklist_locked", `Checklist ${checklistId} is locked; save a copy with based_on instead`);
      const completed = await bodyOrReject(body, previous);
      const version2 = {
        id: store.nextId("chv"),
        created_at: iso(now()),
        checklist_id: checklistId,
        version: previous.version + 1,
        ...completed,
        locked: false,
        based_on: previous.based_on,
        author_role: authorRole
      };
      row.versions.push(version2);
      store.touch();
      return withWarnings(version2);
    }
    function addEvaluation(conv, version2, mode, createdAt) {
      const hash = state.hashes[conv.id];
      const { evaluation, meta } = buildEvaluation({
        id: store.nextId("ev"),
        createdAt,
        conversation: conv,
        version: version2,
        hash,
        mode,
        reusable: collectReusable(state.evaluations, state.evalMeta, conv.id, hash),
        appeals: state.appeals,
        evalMeta: state.evalMeta
      });
      state.evaluations.push(evaluation);
      state.evalMeta[evaluation.id] = meta;
      if (conv.info === null) conv.info = mockInfo(conv);
      return evaluation;
    }
    function finishItem(job, item, dueMs) {
      const meta = state.jobMeta[job.id];
      const conv = lookupConversation(item.conversation);
      const version2 = findVersion(meta.checklist_id, meta.version);
      if (!conv || !version2) {
        item.status = "failed";
        item.error = "\u0414\u0438\u0430\u043B\u043E\u0433 \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043D: \u0438\u043C\u043F\u043E\u0440\u0442\u0438\u0440\u0443\u0439\u0442\u0435 \u0433\u0440\u0443\u043F\u043F\u0443 \u0435\u0449\u0451 \u0440\u0430\u0437.";
      } else if (conv.transcript.length === 0) {
        item.status = "failed";
        item.error = "\u041F\u0443\u0441\u0442\u043E\u0439 \u0434\u0438\u0430\u043B\u043E\u0433: \u043E\u0446\u0435\u043D\u0438\u0432\u0430\u0442\u044C \u043D\u0435\u0447\u0435\u0433\u043E.";
      } else {
        item.evaluation_id = addEvaluation(conv, version2, meta.mode, iso(Math.min(dueMs, now()))).id;
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
    async function startEvaluations({ conversations, checklist_id, version: version2, mode = "reuse", dry_run = false } = {}) {
      if (!Array.isArray(conversations) || conversations.length === 0) {
        throw fail("invalid_request", "conversations must be a non-empty array");
      }
      if (mode !== "reuse" && mode !== "full") throw fail("invalid_request", 'mode must be "reuse" or "full"');
      const checklist = findVersion(checklist_id, version2);
      if (!checklist) throw fail("not_found", `No checklist version ${checklist_id} v${version2}`);
      const convs = [];
      for (const id of [...new Set(conversations)]) convs.push(await resolveConversation(id));
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
        items: convs.map((c) => ({ conversation: c.id, status: "queued", error: null, evaluation_id: null }))
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
      return state.evaluations.filter((e) => (!conversation || e.conversation === conversation) && (!checklist_id || e.checklist_id === checklist_id)).reverse();
    }
    async function getEvaluation(id) {
      const ev = findEvaluation(id);
      if (!ev) throw fail("not_found", `No evaluation ${id}`);
      return ev;
    }
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
        decision: null
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
      const version2 = findVersion(ev.checklist_id, ev.version);
      const criterion = version2.criteria.find((c) => c.id === appeal.criterion_id);
      const result = ev.results.find((r) => r.criterion_id === appeal.criterion_id);
      let decided = structuredClone(result.answer);
      if (outcome === "changed") {
        const problem = validateAnswer(criterion, answer);
        if (problem) throw fail(problem, `The answer does not fit criterion ${criterion.id}: ${problem}`);
        decided = structuredClone(answer);
      }
      appeal.status = "decided";
      appeal.decision = { outcome, answer: decided, reason: text(reason), role: deciderRole, decided_at: iso(now()) };
      result.final_answer = structuredClone(decided);
      result.carried_decision = null;
      recompute(ev, version2);
      store.touch();
      return ev;
    }
    const reportContext = () => ({
      conversations: allConversations,
      latestEvaluation,
      version: findVersion,
      appeals: state.appeals,
      defaultChecklist: DEFAULT_CHECKLIST
    });
    async function getComparison(params = {}) {
      const { from_checklist, from_version, to_checklist, to_version, group_id, conversations } = params ?? {};
      if (!from_checklist || !to_checklist || from_version === void 0 || to_version === void 0) {
        throw fail("invalid_request", "from_checklist, from_version, to_checklist and to_version are required");
      }
      const from = findVersion(from_checklist, from_version);
      const to = findVersion(to_checklist, to_version);
      if (!from || !to) throw fail("not_found", "A checklist version in the comparison does not exist");
      const list = conversations === void 0 || conversations === "" ? null : Array.isArray(conversations) ? conversations : String(conversations).split(",");
      return buildComparison(reportContext(), { from, to, groupId: group_id, conversations: list });
    }
    const getAccuracy = async () => buildAccuracy(reportContext());
    const getAnalytics = async () => buildAnalytics(reportContext());
    const csvUrls = /* @__PURE__ */ new Map();
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
      getConfig: method("getConfig", async () => ({
        models: [MODEL],
        prices: { [MODEL]: { input_per_mtok_usd: 0, output_per_mtok_usd: 0 } },
        model_key_configured: hasKey,
        default_checklist: { ...DEFAULT_CHECKLIST }
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
      exportCsvUrl
    };
  }

  // src/api/index.js
  function createApi(options = {}) {
    const { api, ...rest } = options ?? {};
    if (api === "http") return createHttpApi(rest);
    if (api === "mock") return createMockApi(rest);
    throw new Error(`createApi: unsupported api ${JSON.stringify(api)} (use "http" or "mock")`);
  }

  // src/context.js
  var ROLES3 = ["controller", "reviewer"];
  var THEMES = ["light", "dark"];
  var MODES = ["standalone", "embedded"];
  var APIS = ["http", "mock"];
  var METHOD = /^[A-Za-z][A-Za-z0-9_]*$/;
  var CODE = /^[a-z][a-z0-9_]*$/;
  var oneOf = (allowed, candidates) => candidates.find((value) => allowed.includes(value));
  var firstText = (candidates) => {
    for (const value of candidates) {
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
    return void 0;
  };
  function parseMockFault(values) {
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
  function groupOf(conversationId) {
    if (typeof conversationId !== "string") return null;
    const colon = conversationId.indexOf(":");
    return colon > 0 ? conversationId.slice(0, colon) : null;
  }
  function readContext(search, config, options) {
    const params = new URLSearchParams(typeof search === "string" ? search : "");
    const cfg = config && typeof config === "object" ? config : {};
    const opt = options && typeof options === "object" ? options : {};
    const urlValue = (key) => params.get(key) ?? void 0;
    const chain = (key) => [opt[key], urlValue(key), cfg[key]];
    const conversationId = firstText(chain("conversationId")) ?? null;
    const testHooks = cfg.testHooks === true;
    let mockModelKey = cfg.mockModelKey === void 0 ? true : Boolean(cfg.mockModelKey);
    let mockFault = {};
    if (testHooks) {
      const key = urlValue("mockModelKey");
      if (key === "0") mockModelKey = false;
      else if (key === "1") mockModelKey = true;
      mockFault = parseMockFault(params.getAll("mockFault"));
    }
    const delay = Number(cfg.mockDelayMs);
    return {
      api: oneOf(APIS, chain("api")) ?? "http",
      apiBase: firstText(chain("apiBase")) ?? "api",
      conversationId,
      role: oneOf(ROLES3, chain("role")) ?? "controller",
      theme: oneOf(THEMES, chain("theme")) ?? "light",
      // true when the host or the URL named the theme: only then does it beat a stored choice
      themeExplicit: oneOf(THEMES, [opt.theme, urlValue("theme")]) !== void 0,
      mode: conversationId ? "embedded" : oneOf(MODES, chain("mode")) ?? "standalone",
      devDataUrl: firstText([cfg.devDataUrl]) ?? null,
      devAudioBase: firstText([cfg.devAudioBase]) ?? null,
      mockModelKey,
      mockDelayMs: Number.isFinite(delay) && delay >= 0 ? delay : 600,
      mockFault,
      testHooks
    };
  }
  function extractConversationId(formContext, config) {
    const field = firstText([config?.dynamicsConversationField]) ?? "cqa_conversationid";
    try {
      const value = formContext?.getAttribute?.(field)?.getValue?.();
      return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
    } catch {
      return null;
    }
  }

  // src/state/store.js
  function createStore(initial = {}) {
    let state = { ...initial };
    const listeners = /* @__PURE__ */ new Set();
    return {
      get: () => state,
      // `partial` is an object, or a function of the current state returning one.
      set(partial) {
        const previous = state;
        state = { ...state, ...typeof partial === "function" ? partial(state) : partial };
        for (const listener of [...listeners]) {
          if (!listeners.has(listener)) continue;
          try {
            listener(state, previous);
          } catch (error) {
            console.error(error);
          }
        }
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }
    };
  }
  function watch(store, select, fn) {
    let previous = select(store.get());
    return store.subscribe((state) => {
      const next = select(state);
      if (Object.is(next, previous)) return;
      const old = previous;
      previous = next;
      fn(next, old);
    });
  }
  var isCompact = (state) => state.mode === "embedded" && Boolean(state.conversationId);

  // src/ui/router.js
  var COMPARE_KEYS = ["from_checklist", "from_version", "to_checklist", "to_version", "group_id"];
  var VERSION = /^\d+$/;
  var NAV_OF = {
    workspace: "workspace",
    checklists: "checklists",
    checklist: "checklists",
    editor: "checklists",
    compare: "checklists",
    appeals: "appeals",
    appeal: "appeals",
    analytics: "analytics",
    accuracy: "accuracy"
  };
  var navFor = (routeName) => NAV_OF[routeName] ?? null;
  var sameRoute = (a, b) => a?.name === b?.name && JSON.stringify(a?.params ?? {}) === JSON.stringify(b?.params ?? {});
  var route = (name, params = {}) => ({ name, params });
  function parseRoute(hash) {
    const raw = typeof hash === "string" ? hash : "";
    const body = raw.startsWith("#") ? raw.slice(1) : raw;
    const queryAt = body.indexOf("?");
    const path = (queryAt < 0 ? body : body.slice(0, queryAt)).replace(/^\/+/, "").replace(/\/+$/, "");
    const search = queryAt < 0 ? "" : body.slice(queryAt + 1);
    const notFound = route("notfound", { path: raw });
    let segments;
    try {
      segments = path === "" ? [] : path.split("/").map(decodeURIComponent);
    } catch {
      return notFound;
    }
    if (segments.some((segment) => segment === "")) return notFound;
    const [head, a, b, c] = segments;
    const n = segments.length;
    if (n === 0) return route("workspace");
    if (head === "c" && n === 2) return route("workspace", { id: a });
    if (head === "checklists") {
      if (n === 1) return route("checklists");
      if (n === 3 && VERSION.test(b)) return route("checklist", { checklistId: a, version: b });
      if (n === 4 && VERSION.test(b) && c === "edit") return route("editor", { checklistId: a, version: b });
      return notFound;
    }
    if (head === "appeals") {
      if (n === 1) return route("appeals");
      if (n === 2) return route("appeal", { id: a });
      return notFound;
    }
    if (head === "compare" && n === 1) {
      const query2 = new URLSearchParams(search);
      const params = {};
      for (const key of COMPARE_KEYS) {
        const value = query2.get(key);
        if (value) params[key] = value;
      }
      return route("compare", params);
    }
    if ((head === "analytics" || head === "accuracy") && n === 1) return route(head);
    return notFound;
  }
  var encoded = (params, key) => {
    const value = params?.[key];
    if (value === void 0 || value === null || value === "") throw new TypeError(`href: missing ${key}`);
    return encodeURIComponent(String(value));
  };
  function href(name, params = {}) {
    switch (name) {
      case "workspace":
        return params?.id ? `#/c/${encoded(params, "id")}` : "#/";
      case "checklists":
        return "#/checklists";
      case "checklist":
        return `#/checklists/${encoded(params, "checklistId")}/${encoded(params, "version")}`;
      case "editor":
        return `#/checklists/${encoded(params, "checklistId")}/${encoded(params, "version")}/edit`;
      case "appeals":
        return "#/appeals";
      case "appeal":
        return `#/appeals/${encoded(params, "id")}`;
      case "compare": {
        const query2 = new URLSearchParams();
        for (const key of COMPARE_KEYS) {
          const value = params?.[key];
          if (value !== void 0 && value !== null && value !== "") query2.set(key, String(value));
        }
        const text2 = query2.toString();
        return text2 ? `#/compare?${text2}` : "#/compare";
      }
      case "analytics":
        return "#/analytics";
      case "accuracy":
        return "#/accuracy";
      default:
        throw new TypeError(`href: unknown route ${JSON.stringify(name)}`);
    }
  }

  // src/i18n/ru.js
  var messages = {
    "app.title": "\u041A\u0430\u0447\u0435\u0441\u0442\u0432\u043E \u0434\u0438\u0430\u043B\u043E\u0433\u043E\u0432",
    "brand.name": "FREEDOM",
    "nav.label": "\u0420\u0430\u0437\u0434\u0435\u043B\u044B",
    "nav.workspace": "\u041E\u0446\u0435\u043D\u043A\u0430",
    "nav.checklists": "\u0427\u0435\u043A-\u043B\u0438\u0441\u0442\u044B",
    "nav.appeals": "\u0410\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u0438",
    "nav.compare": "\u0421\u0440\u0430\u0432\u043D\u0435\u043D\u0438\u0435",
    "nav.analytics": "\u041E\u0442\u0447\u0451\u0442\u044B",
    "nav.accuracy": "\u0422\u043E\u0447\u043D\u043E\u0441\u0442\u044C",
    "role.label": "\u0420\u043E\u043B\u044C",
    "role.current": "\u0420\u043E\u043B\u044C: {role}",
    "role.controller": "\u041A\u043E\u043D\u0442\u0440\u043E\u043B\u0451\u0440",
    "role.reviewer": "\u041F\u0440\u043E\u0432\u0435\u0440\u044F\u044E\u0449\u0438\u0439",
    "theme.toggle": "\u0422\u0451\u043C\u043D\u0430\u044F \u0442\u0435\u043C\u0430",
    "dataset.label": "\u041D\u0430\u0431\u043E\u0440",
    "dataset.title": "\u0422\u0435\u043A\u0443\u0449\u0438\u0439 \u043D\u0430\u0431\u043E\u0440 \u0434\u0430\u043D\u043D\u044B\u0445",
    "workspace.queue": "\u041E\u0447\u0435\u0440\u0435\u0434\u044C",
    "workspace.queueClose": "\u0417\u0430\u043A\u0440\u044B\u0442\u044C \u043E\u0447\u0435\u0440\u0435\u0434\u044C",
    "workspace.tab.transcript": "\u0414\u0438\u0430\u043B\u043E\u0433",
    "workspace.tab.scorecard": "\u041E\u0446\u0435\u043D\u043A\u0430",
    "workspace.scorecard": "\u041E\u0446\u0435\u043D\u043A\u0430 \u0434\u0438\u0430\u043B\u043E\u0433\u0430",
    "workspace.pick": "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0434\u0438\u0430\u043B\u043E\u0433 \u0432 \u043E\u0447\u0435\u0440\u0435\u0434\u0438",
    "queue.search": "\u041F\u043E\u0438\u0441\u043A \u043F\u043E ID \u0438\u043B\u0438 \u0442\u0435\u043A\u0441\u0442\u0443 \u0434\u0438\u0430\u043B\u043E\u0433\u0430",
    "queue.searchLabel": "\u041F\u043E\u0438\u0441\u043A \u043F\u043E \u043E\u0447\u0435\u0440\u0435\u0434\u0438",
    "queue.filters": "\u0424\u0438\u043B\u044C\u0442\u0440\u044B \u043E\u0447\u0435\u0440\u0435\u0434\u0438",
    "queue.filter.all": "\u0412\u0441\u0435",
    "queue.filter.chats": "\u0427\u0430\u0442\u044B",
    "queue.filter.calls": "\u0417\u0432\u043E\u043D\u043A\u0438",
    "queue.filter.disputed": "\u0421\u043F\u043E\u0440\u043D\u044B\u0435",
    "queue.filter.new": "\u041D\u043E\u0432\u044B\u0435",
    "queue.language": "\u042F\u0437\u044B\u043A \u0434\u0438\u0430\u043B\u043E\u0433\u0430",
    "queue.language.all": "\u0412\u0441\u0435 \u044F\u0437\u044B\u043A\u0438",
    "queue.list": "\u0414\u0438\u0430\u043B\u043E\u0433\u0438",
    "queue.shown": "\u041F\u043E\u043A\u0430\u0437\u0430\u043D\u043E {shown} \u0438\u0437 {total}",
    "queue.loading": "\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u044E \u043E\u0447\u0435\u0440\u0435\u0434\u044C\u2026",
    "queue.importing": "\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u044E \u043D\u0430\u0431\u043E\u0440 {group}\u2026",
    "queue.loadFailed": "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u043E\u0447\u0435\u0440\u0435\u0434\u044C",
    "queue.retry": "\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u044C",
    "queue.empty": "\u041E\u0447\u0435\u0440\u0435\u0434\u044C \u043F\u0443\u0441\u0442\u0430",
    "queue.emptyNote": "\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u0435 \u043D\u0430\u0431\u043E\u0440 \u0434\u0430\u043D\u043D\u044B\u0445, \u0438 \u0434\u0438\u0430\u043B\u043E\u0433\u0438 \u043F\u043E\u044F\u0432\u044F\u0442\u0441\u044F \u0437\u0434\u0435\u0441\u044C.",
    "queue.noMatch": "\u041D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E",
    "queue.noMatchNote": "\u0418\u0437\u043C\u0435\u043D\u0438\u0442\u0435 \u043F\u043E\u0438\u0441\u043A \u0438\u043B\u0438 \u0444\u0438\u043B\u044C\u0442\u0440\u044B.",
    "queue.select": "\u0412\u044B\u0431\u0440\u0430\u0442\u044C \u0434\u0438\u0430\u043B\u043E\u0433 {id}",
    "queue.channel.chat": "\u0447\u0430\u0442",
    "queue.channel.call": "\u0437\u0432\u043E\u043D\u043E\u043A",
    "queue.group": "\u041D\u0430\u0431\u043E\u0440 \u0434\u0430\u043D\u043D\u044B\u0445: {group}",
    "queue.language.title": "\u042F\u0437\u044B\u043A \u0434\u0438\u0430\u043B\u043E\u0433\u0430",
    "queue.score.none": "\u043D\u0435 \u043E\u0446\u0435\u043D\u0451\u043D",
    "queue.score.notCalculated": "\u043D\u0435 \u0440\u0430\u0441\u0441\u0447\u0438\u0442\u044B\u0432\u0430\u0435\u0442\u0441\u044F",
    "queue.tag.appeal": "\u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u044F",
    "queue.tag.appeals": "\u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u0438: {n}",
    "queue.tag.grossError": "\u0433\u0440\u0443\u0431\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430",
    "queue.tag.needsReview": "\u043D\u0430 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0443",
    "queue.tag.needsReviewTitle": "\u041C\u043E\u0434\u0435\u043B\u044C \u043D\u0435 \u0443\u0432\u0435\u0440\u0435\u043D\u0430 \u0432 \u0447\u0430\u0441\u0442\u0438 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0435\u0432",
    "view.soon": "\u0420\u0430\u0437\u0434\u0435\u043B \u0435\u0449\u0451 \u043D\u0435 \u0433\u043E\u0442\u043E\u0432.",
    "notfound.title": "\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u0430",
    "notfound.home": "\u041A \u043E\u0446\u0435\u043D\u043A\u0435 \u0434\u0438\u0430\u043B\u043E\u0433\u043E\u0432",
    "toast.retry": "\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u044C",
    "toast.close": "\u0417\u0430\u043A\u0440\u044B\u0442\u044C",
    "error.network": "\u041D\u0435\u0442 \u0441\u0432\u044F\u0437\u0438 \u0441 \u0441\u0435\u0440\u0432\u0435\u0440\u043E\u043C. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435 \u0438 \u043F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435.",
    "error.timeout": "\u0421\u0435\u0440\u0432\u0435\u0440 \u043D\u0435 \u043E\u0442\u0432\u0435\u0442\u0438\u043B \u0432\u043E\u0432\u0440\u0435\u043C\u044F. \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u043F\u043E\u043F\u044B\u0442\u043A\u0443.",
    "error.bad_response": "\u0421\u0435\u0440\u0432\u0435\u0440 \u0432\u0435\u0440\u043D\u0443\u043B \u043D\u0435\u043E\u0436\u0438\u0434\u0430\u043D\u043D\u044B\u0439 \u043E\u0442\u0432\u0435\u0442.",
    "error.model_key_missing": "\u041D\u0443\u0436\u0435\u043D \u043A\u043B\u044E\u0447 \u043C\u043E\u0434\u0435\u043B\u0438: \u043D\u043E\u0432\u0443\u044E \u043E\u0446\u0435\u043D\u043A\u0443 \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u043D\u0435\u043B\u044C\u0437\u044F.",
    "error.invalid_request": "\u0417\u0430\u043F\u0440\u043E\u0441 \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D \u043D\u0435\u0432\u0435\u0440\u043D\u043E. \u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0434\u0430\u043D\u043D\u044B\u0435.",
    "error.na_not_allowed": "\u0414\u043B\u044F \u044D\u0442\u043E\u0433\u043E \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044F \u043E\u0442\u0432\u0435\u0442 \xABN/A\xBB \u043D\u0435\u0434\u043E\u043F\u0443\u0441\u0442\u0438\u043C.",
    "error.step_not_in_scale": "\u0422\u0430\u043A\u043E\u0433\u043E \u0448\u0430\u0433\u0430 \u043D\u0435\u0442 \u0432 \u0448\u043A\u0430\u043B\u0435 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044F.",
    "error.bad_answer": "\u041D\u0435\u0434\u043E\u043F\u0443\u0441\u0442\u0438\u043C\u044B\u0439 \u043E\u0442\u0432\u0435\u0442 \u0434\u043B\u044F \u044D\u0442\u043E\u0433\u043E \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044F.",
    "error.reason_required": "\u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u043F\u0440\u0438\u0447\u0438\u043D\u0443 \u0440\u0435\u0448\u0435\u043D\u0438\u044F.",
    "error.invalid_checklist": "\u0427\u0435\u043A-\u043B\u0438\u0441\u0442 \u0437\u0430\u043F\u043E\u043B\u043D\u0435\u043D \u043D\u0435\u0432\u0435\u0440\u043D\u043E. \u0418\u0441\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u043E\u0442\u043C\u0435\u0447\u0435\u043D\u043D\u044B\u0435 \u043F\u043E\u043B\u044F.",
    "error.appeal_already_decided": "\u041F\u043E \u044D\u0442\u043E\u0439 \u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u0438 \u0443\u0436\u0435 \u043F\u0440\u0438\u043D\u044F\u0442\u043E \u0440\u0435\u0448\u0435\u043D\u0438\u0435.",
    "error.appeal_already_open": "\u041F\u043E \u044D\u0442\u043E\u043C\u0443 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044E \u0443\u0436\u0435 \u0435\u0441\u0442\u044C \u043E\u0442\u043A\u0440\u044B\u0442\u0430\u044F \u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u044F.",
    "error.checklist_locked": "\u042D\u0442\u0430 \u0432\u0435\u0440\u0441\u0438\u044F \u0447\u0435\u043A-\u043B\u0438\u0441\u0442\u0430 \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D\u0430. \u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u0435 \u0435\u0451 \u043A\u0430\u043A \u043D\u043E\u0432\u044B\u0439 \u0447\u0435\u043A-\u043B\u0438\u0441\u0442.",
    "error.organizer_url_missing": "\u041D\u0435 \u0437\u0430\u0434\u0430\u043D \u0430\u0434\u0440\u0435\u0441 \u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A\u0430 \u0434\u0430\u043D\u043D\u044B\u0445: \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0433\u0440\u0443\u043F\u043F\u0443 \u043D\u0435\u043B\u044C\u0437\u044F.",
    "error.role_not_allowed": "\u042D\u0442\u043E \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u0434\u043B\u044F \u0432\u0430\u0448\u0435\u0439 \u0440\u043E\u043B\u0438.",
    "error.not_found": "\u041D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E: \u0437\u0430\u043F\u0438\u0441\u044C \u0443\u0434\u0430\u043B\u0435\u043D\u0430 \u0438\u043B\u0438 \u0441\u0441\u044B\u043B\u043A\u0430 \u0443\u0441\u0442\u0430\u0440\u0435\u043B\u0430.",
    "error.organizer_error": "\u0418\u0441\u0442\u043E\u0447\u043D\u0438\u043A \u0434\u0430\u043D\u043D\u044B\u0445 \u043D\u0435 \u043E\u0442\u0432\u0435\u0442\u0438\u043B. \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u043F\u043E\u043F\u044B\u0442\u043A\u0443 \u043F\u043E\u0437\u0436\u0435.",
    "error.no_records": "\u0412 \u0444\u0430\u0439\u043B\u0435 \u043D\u0435\u0442 \u043D\u0438 \u043E\u0434\u043D\u043E\u0439 \u0437\u0430\u043F\u0438\u0441\u0438.",
    "error.bad_record": "\u0412 \u0444\u0430\u0439\u043B\u0435 \u0435\u0441\u0442\u044C \u043D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u0430\u044F \u0437\u0430\u043F\u0438\u0441\u044C.",
    "error.bad_record_at": "\u0417\u0430\u043F\u0438\u0441\u044C \u2116{n} \u0432 \u0444\u0430\u0439\u043B\u0435 \u043D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u0430.",
    "error.internal_error": "\u041E\u0448\u0438\u0431\u043A\u0430 \u043D\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0435. \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u043F\u043E\u043F\u044B\u0442\u043A\u0443 \u043F\u043E\u0437\u0436\u0435.",
    "error.generic": "\u0427\u0442\u043E-\u0442\u043E \u043F\u043E\u0448\u043B\u043E \u043D\u0435 \u0442\u0430\u043A. \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u043F\u043E\u043F\u044B\u0442\u043A\u0443."
  };
  var has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  function format(template, params) {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (placeholder2, name) => has(params, name) ? String(params[name]) : placeholder2);
  }
  function t(key, params) {
    return has(messages, key) ? format(messages[key], params) : key;
  }

  // src/ui/dom.js
  var SVG_NS = "http://www.w3.org/2000/svg";
  var PROPS = /* @__PURE__ */ new Set(["class", "text", "attrs", "data", "on", "style"]);
  function append(parent, children) {
    for (const child of children) {
      if (child === null || child === void 0 || child === false || child === true) continue;
      if (Array.isArray(child)) append(parent, child);
      else parent.append(child);
    }
  }
  function setAttrs(el, attrs) {
    for (const [name, value] of Object.entries(attrs)) {
      if (value === null || value === void 0 || value === false) continue;
      if (name === "style" || /^on/i.test(name)) throw new TypeError(`dom: attribute "${name}" is not allowed`);
      el.setAttribute(name, value === true ? "" : String(value));
    }
  }
  var kebab = (key) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props !== void 0 && props !== null) {
      if (typeof props !== "object" || props instanceof Node || Array.isArray(props)) {
        throw new TypeError("dom: h() props must be a plain object; pass children after it");
      }
      for (const key of Object.keys(props)) {
        if (!PROPS.has(key)) throw new TypeError(`dom: unknown prop "${key}"`);
      }
      const { class: className, text: text2, attrs, data, on, style } = props;
      if (className) el.className = Array.isArray(className) ? className.filter(Boolean).join(" ") : String(className);
      if (text2 !== void 0 && text2 !== null) el.textContent = String(text2);
      if (attrs) setAttrs(el, attrs);
      if (data) {
        for (const [key, value] of Object.entries(data)) {
          if (value !== null && value !== void 0 && value !== false) el.setAttribute(`data-${kebab(key)}`, String(value));
        }
      }
      if (on) {
        for (const [event, handler] of Object.entries(on)) el.addEventListener(event, handler);
      }
      if (style) {
        for (const [property, value] of Object.entries(style)) {
          if (property.startsWith("--")) el.style.setProperty(property, String(value));
          else el.style[property] = value;
        }
      }
    }
    append(el, children);
    return el;
  }
  function svg(tag, attrs, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) setAttrs(el, attrs);
    append(el, children);
    return el;
  }
  function clear(el) {
    el.replaceChildren();
    return el;
  }

  // src/ui/icons.js
  var SHAPES = {
    sun: [
      ["circle", { cx: 12, cy: 12, r: 4 }],
      ["path", { d: "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" }]
    ],
    moon: [["path", { d: "M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z" }]],
    user: [
      ["circle", { cx: 12, cy: 8, r: 4 }],
      ["path", { d: "M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" }]
    ],
    chevron: [["path", { d: "m6 9 6 6 6-6" }]],
    list: [["path", { d: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" }]],
    close: [["path", { d: "M6 6l12 12M18 6 6 18" }]],
    check: [["path", { d: "m5 12.5 4.5 4.5L19 7.5" }]],
    alert: [
      ["path", { d: "M12 3.5 2.5 20h19L12 3.5Z" }],
      ["path", { d: "M12 10v4.5M12 17.5h.01" }]
    ],
    info: [
      ["circle", { cx: 12, cy: 12, r: 9 }],
      ["path", { d: "M12 11v5.5M12 7.5h.01" }]
    ]
  };
  var iconNames = Object.keys(SHAPES);
  function icon(name, { size = 16 } = {}) {
    const shapes = SHAPES[name];
    if (!shapes) throw new TypeError(`icons: unknown icon ${JSON.stringify(name)}`);
    return svg(
      "svg",
      {
        class: "cqa-icon",
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 2,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "aria-hidden": "true",
        focusable: "false"
      },
      ...shapes.map(([tag, attrs]) => svg(tag, attrs))
    );
  }

  // src/ui/toast.js
  function dismissToast(store, id) {
    const toasts = store.get().toasts ?? [];
    if (!toasts.some((entry) => entry.id === id)) return;
    store.set({ toasts: toasts.filter((entry) => entry.id !== id) });
  }
  function renderToasts(store) {
    const box = h("div", { class: "cqa-toasts", attrs: { "aria-live": "polite" }, data: { test: "toasts" } });
    const draw = () => {
      clear(box);
      for (const entry of store.get().toasts ?? []) {
        const actions = [];
        if (entry.retry) {
          actions.push(
            h("button", {
              class: "cqa-toast-btn",
              attrs: { type: "button" },
              data: { test: "toast-retry" },
              text: t("toast.retry"),
              on: {
                click: () => {
                  dismissToast(store, entry.id);
                  entry.retry();
                }
              }
            })
          );
        }
        box.append(
          h(
            "div",
            { class: ["cqa-toast", `cqa-toast--${entry.kind}`], attrs: { role: entry.kind === "error" ? "alert" : "status" }, data: { test: "toast", kind: entry.kind } },
            icon(entry.kind === "error" ? "alert" : "info", { size: 18 }),
            h("span", { class: "cqa-toast-text", text: entry.text }),
            actions,
            h(
              "button",
              { class: "cqa-toast-close", attrs: { type: "button", "aria-label": t("toast.close") }, data: { test: "toast-close" }, on: { click: () => dismissToast(store, entry.id) } },
              icon("close", { size: 14 })
            )
          )
        );
      }
    };
    const unwatch = watch(store, (state) => state.toasts, draw);
    draw();
    return { el: box, destroy: unwatch };
  }

  // src/ui/shell.js
  var NAV = ["workspace", "checklists", "appeals", "analytics", "accuracy"];
  var ROLES4 = ["controller", "reviewer"];
  var normalise = (made) => made instanceof Node ? { el: made } : made;
  function placeholder(title, note) {
    return h("div", { class: "cqa-empty" }, h("b", { class: "cqa-empty-title", text: title }), note ? h("p", { class: "cqa-empty-note", text: note }) : null);
  }
  function roleSwitch(store, track) {
    const label = h("span", { class: "cqa-role-label", data: { test: "role-label" } });
    const button = h(
      "button",
      { class: "cqa-role-btn", attrs: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false" }, data: { test: "role-switch" } },
      h("span", { class: "cqa-role-avatar" }, icon("user", { size: 14 })),
      label,
      icon("chevron", { size: 14 })
    );
    const items = ROLES4.map(
      (role) => h(
        "button",
        {
          class: "cqa-menu-item",
          attrs: { type: "button", role: "menuitemradio", "aria-checked": "false" },
          data: { test: `role-option-${role}`, role },
          on: {
            click: () => {
              store.set({ role });
              close();
              button.focus();
            }
          }
        },
        h("span", { text: t(`role.${role}`) }),
        icon("check", { size: 14 })
      )
    );
    const menu = h("div", { class: "cqa-menu", attrs: { role: "menu", "aria-label": t("role.label") }, data: { test: "role-menu" } }, items);
    menu.hidden = true;
    const wrap = h("div", { class: "cqa-role" }, button, menu);
    function open() {
      menu.hidden = false;
      button.setAttribute("aria-expanded", "true");
      (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0]).focus();
    }
    function close() {
      if (menu.hidden) return;
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }
    button.addEventListener("click", () => menu.hidden ? open() : close());
    wrap.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !menu.hidden) {
        event.stopPropagation();
        close();
        button.focus();
      } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !menu.hidden) {
        event.preventDefault();
        const at = items.indexOf(document.activeElement);
        const step = event.key === "ArrowDown" ? 1 : -1;
        items[(at + step + items.length) % items.length].focus();
      }
    });
    const onOutside = (event) => {
      if (!wrap.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", onOutside);
    track(() => document.removeEventListener("pointerdown", onOutside));
    const paint = (role) => {
      label.textContent = t(`role.${role}`);
      button.setAttribute("aria-label", t("role.current", { role: t(`role.${role}`) }));
      for (const item of items) item.setAttribute("aria-checked", String(item.getAttribute("data-role") === role));
    };
    paint(store.get().role);
    track(watch(store, (state) => state.role, paint));
    return wrap;
  }
  function themeToggle(store, track) {
    const sun = h("span", { class: "cqa-theme-opt" }, icon("sun", { size: 16 }));
    const moon = h("span", { class: "cqa-theme-opt" }, icon("moon", { size: 16 }));
    const button = h(
      "button",
      {
        class: "cqa-theme",
        attrs: { type: "button", role: "switch", "aria-label": t("theme.toggle"), "aria-checked": "false" },
        data: { test: "theme-toggle" },
        on: { click: () => store.set({ theme: store.get().theme === "dark" ? "light" : "dark" }) }
      },
      sun,
      moon
    );
    const paint = (theme) => {
      button.setAttribute("aria-checked", String(theme === "dark"));
      sun.classList.toggle("is-on", theme !== "dark");
      moon.classList.toggle("is-on", theme === "dark");
    };
    paint(store.get().theme);
    track(watch(store, (state) => state.theme, paint));
    return button;
  }
  function datasetBadge(store, track) {
    const value = h("b", { class: "cqa-badge-value" });
    const badge = h(
      "span",
      { class: "cqa-badge", attrs: { title: t("dataset.title") }, data: { test: "dataset-badge" } },
      h("span", { class: "cqa-badge-label", text: t("dataset.label") }),
      " ",
      value
    );
    const paint = (groupId) => {
      value.textContent = groupId ?? "";
    };
    paint(store.get().groupId);
    track(watch(store, (state) => state.groupId, paint));
    return badge;
  }
  function buildHeader(store, compact, track) {
    const prod = h("span", { class: "cqa-prod", text: t("app.title") });
    const right = h("div", { class: "cqa-right" }, compact ? null : datasetBadge(store, track), roleSwitch(store, track), themeToggle(store, track));
    if (compact) return h("header", { class: ["cqa-top", "cqa-top--compact"] }, prod, right);
    const items = NAV.map((name) => h("a", { class: "cqa-nav-item", attrs: { href: href(name) }, data: { test: `nav-${name}` }, text: t(`nav.${name}`) }));
    const paint = (route2) => {
      const active = navFor(route2.name);
      NAV.forEach((name, i) => {
        if (name === active) items[i].setAttribute("aria-current", "page");
        else items[i].removeAttribute("aria-current");
      });
    };
    paint(store.get().route);
    track(watch(store, (state) => state.route, paint));
    return h(
      "header",
      { class: "cqa-top" },
      h("a", { class: "cqa-logo", attrs: { href: href("workspace") }, data: { test: "logo" } }, h("i", { class: "cqa-logo-mark", attrs: { "aria-hidden": "true" } }), h("span", { class: "cqa-logo-word", text: t("brand.name") })),
      prod,
      h("nav", { class: "cqa-nav", attrs: { "aria-label": t("nav.label") } }, items),
      right
    );
  }
  function workspaceView(store, api, route2, panes) {
    const compact = isCompact(store.get());
    const subs = [];
    const track = (fn) => subs.push(fn);
    const queueHost = compact ? null : h("aside", { class: ["cqa-pane", "cqa-pane-queue"], attrs: { id: "cqa-queue", "aria-label": t("workspace.queue") }, data: { test: "queue-pane" } });
    const transcriptHost = h("section", { class: ["cqa-pane", "cqa-pane-transcript"], data: { test: "transcript-pane" } });
    const scorecardHost = h("aside", { class: ["cqa-pane", "cqa-pane-scorecard"], data: { test: "scorecard-pane" } });
    const mounted = /* @__PURE__ */ new Map();
    function fill(host, make2, fallback) {
      mounted.get(host)?.destroy?.();
      mounted.delete(host);
      clear(host);
      const made = make2 ? normalise(make2()) : null;
      if (made) {
        mounted.set(host, made);
        host.append(made.el);
      } else {
        host.append(fallback());
      }
    }
    let id = null;
    function fillConversation(next) {
      id = next;
      const args = { id };
      fill(
        transcriptHost,
        id && panes.transcript ? () => panes.transcript(store, api, args) : null,
        () => placeholder(id ?? t("workspace.pick"), id ? t("view.soon") : null)
      );
      fill(
        scorecardHost,
        id && panes.scorecard ? () => panes.scorecard(store, api, args) : null,
        () => placeholder(t("workspace.scorecard"), id ? t("view.soon") : null)
      );
    }
    if (queueHost) fill(queueHost, panes.queue ? () => panes.queue(store, api) : null, () => placeholder(t("workspace.queue"), t("view.soon")));
    fillConversation(route2.params.id ?? null);
    const toggle = compact ? null : h(
      "button",
      {
        class: "cqa-queue-toggle",
        attrs: { type: "button", "aria-controls": "cqa-queue", "aria-expanded": "false" },
        data: { test: "queue-toggle" },
        on: { click: () => store.set({ queueOpen: !store.get().queueOpen }) }
      },
      icon("list", { size: 16 }),
      h("span", { text: t("workspace.queue") })
    );
    const tabs = ["transcript", "scorecard"].map(
      (pane) => h("button", { class: "cqa-tab", attrs: { type: "button", role: "tab", "aria-selected": "false" }, data: { test: `tab-${pane}` }, text: t(`workspace.tab.${pane}`), on: { click: () => store.set({ pane }) } })
    );
    const bar = h("div", { class: "cqa-ws-bar" }, toggle, h("div", { class: "cqa-tabs", attrs: { role: "tablist" } }, tabs));
    const scrim = compact ? null : h("button", { class: "cqa-scrim", attrs: { type: "button", tabindex: "-1", "aria-label": t("workspace.queueClose") }, data: { test: "queue-scrim" }, on: { click: () => store.set({ queueOpen: false }) } });
    const el = h(
      "div",
      {
        class: ["cqa-ws", compact && "cqa-ws--compact"],
        data: { test: "workspace" },
        on: {
          keydown: (event) => {
            if (event.key === "Escape" && store.get().queueOpen) {
              store.set({ queueOpen: false });
              toggle?.focus();
            }
          }
        }
      },
      bar,
      scrim,
      h("div", { class: "cqa-ws-grid" }, queueHost, transcriptHost, scorecardHost)
    );
    const paint = () => {
      const { queueOpen, pane } = store.get();
      const open = Boolean(queueOpen) && !compact;
      el.classList.toggle("cqa-ws--queue-open", open);
      el.classList.toggle("cqa-ws--pane-scorecard", pane === "scorecard");
      toggle?.setAttribute("aria-expanded", String(open));
      tabs.forEach((tab, i) => tab.setAttribute("aria-selected", String(i === 1 === (pane === "scorecard"))));
    };
    paint();
    track(watch(store, (state) => state.queueOpen, paint));
    track(watch(store, (state) => state.pane, paint));
    return {
      el,
      update(next) {
        const nextId = next.params.id ?? null;
        if (nextId !== id) fillConversation(nextId);
      },
      destroy() {
        subs.forEach((off) => off());
        for (const handle of mounted.values()) handle.destroy?.();
        mounted.clear();
      }
    };
  }
  function pageView(title, note) {
    return h("section", { class: "cqa-view" }, h("h1", { class: "cqa-view-title", text: title }), note ? h("p", { class: "cqa-view-note", text: note }) : null);
  }
  function notFoundView() {
    return h(
      "section",
      { class: "cqa-view", data: { test: "notfound" } },
      h("h1", { class: "cqa-view-title", text: t("notfound.title") }),
      h("p", { class: "cqa-view-note" }, h("a", { class: "cqa-link", attrs: { href: href("workspace") }, text: t("notfound.home") }))
    );
  }
  function defaultView(route2) {
    if (route2.name === "notfound") return notFoundView();
    return pageView(t(`nav.${route2.name === "compare" ? "compare" : navFor(route2.name)}`), t("view.soon"));
  }
  function createShell(store, api, { panes = {}, views = {} } = {}) {
    const el = h("div", { class: "cqa-shell" });
    let teardown = [];
    const track = (fn) => teardown.push(fn);
    function build() {
      teardown.forEach((fn) => fn());
      teardown = [];
      const compact = isCompact(store.get());
      const main = h("div", { class: "cqa-main", attrs: { role: "region", "aria-label": t("app.title") }, data: { test: "main" } });
      let current2 = null;
      const show = (route2) => {
        if (current2 && current2.name === route2.name && current2.view.update) {
          current2.view.update(route2);
          return;
        }
        current2?.view.destroy?.();
        clear(main);
        const make2 = route2.name === "workspace" ? null : views[route2.name];
        const view = route2.name === "workspace" ? workspaceView(store, api, route2, panes) : normalise(make2 ? make2(store, api, route2) : defaultView(route2));
        current2 = { name: route2.name, view };
        main.append(view.el);
      };
      show(store.get().route);
      track(watch(store, (state) => state.route, show));
      track(() => current2?.view.destroy?.());
      const toasts = renderToasts(store);
      track(toasts.destroy);
      el.replaceChildren(buildHeader(store, compact, track), main, toasts.el);
    }
    build();
    const stopCompact = watch(store, isCompact, build);
    return {
      el,
      destroy() {
        stopCompact();
        teardown.forEach((fn) => fn());
        teardown = [];
      }
    };
  }

  // src/app.js
  var THEME_KEY = "cqa-theme";
  var DEFAULT_GROUP = "DEV";
  function readStoredTheme() {
    try {
      const value = window.localStorage.getItem(THEME_KEY);
      return value === "light" || value === "dark" ? value : null;
    } catch {
      return null;
    }
  }
  function storeTheme(theme) {
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
    }
  }
  function mount(el, options = {}) {
    const config = options.config ?? window.CQA_CONFIG ?? {};
    const ctx = readContext(options.search ?? window.location.search, config, options);
    const theme = ctx.themeExplicit || ctx.mode === "embedded" ? ctx.theme : readStoredTheme() ?? ctx.theme;
    const compactRoute = (id) => ({ name: "workspace", params: { id } });
    const store = createStore({
      config,
      role: ctx.role,
      theme,
      mode: ctx.mode,
      conversationId: ctx.conversationId,
      groupId: groupOf(ctx.conversationId) ?? DEFAULT_GROUP,
      route: isCompact({ mode: ctx.mode, conversationId: ctx.conversationId }) ? compactRoute(ctx.conversationId) : parseRoute(window.location.hash),
      toasts: [],
      queueOpen: false,
      // the queue drawer below 900 px
      pane: "transcript"
      // the visible pane below 700 px: "transcript" | "scorecard"
    });
    const roleNow = () => store.get().role;
    const api = createApi(
      ctx.api === "mock" ? { api: "mock", role: roleNow, devDataUrl: ctx.devDataUrl ?? void 0, devAudioBase: ctx.devAudioBase ?? void 0, mockModelKey: ctx.mockModelKey, mockDelayMs: ctx.mockDelayMs, mockFault: ctx.mockFault } : { api: "http", apiBase: ctx.apiBase, role: roleNow }
    );
    el.classList.add("cqa");
    const stops = [];
    stops.push(watch(store, (state) => state.theme, (next) => el.classList.toggle("cqa--dark", next === "dark")));
    el.classList.toggle("cqa--dark", theme === "dark");
    if (ctx.mode !== "embedded") stops.push(watch(store, (state) => state.theme, storeTheme));
    stops.push(watch(store, isCompact, (next) => el.classList.toggle("cqa--compact", next)));
    el.classList.toggle("cqa--compact", isCompact(store.get()));
    const goTo = (route2, extra = {}) => {
      if (sameRoute(route2, store.get().route) && Object.keys(extra).length === 0) return;
      const id = route2.name === "workspace" ? route2.params.id : null;
      store.set({ ...extra, route: route2, groupId: groupOf(id) ?? store.get().groupId, queueOpen: false, pane: "transcript" });
    };
    const onHashChange = () => {
      if (!isCompact(store.get())) goTo(parseRoute(window.location.hash));
    };
    window.addEventListener("hashchange", onHashChange);
    if (ctx.testHooks) window.__cqaTest = { api, store, transcript: null };
    const shell = createShell(store, api, { panes: options.panes, views: options.views });
    el.replaceChildren(shell.el);
    let destroyed = false;
    return {
      // Opens a conversation. Embedded: the page becomes the compact view of that record.
      // Standalone: navigates to it.
      open(conversationId) {
        if (destroyed || typeof conversationId !== "string" || conversationId.trim() === "") return;
        const id = conversationId.trim();
        if (store.get().mode === "embedded") {
          goTo(compactRoute(id), { conversationId: id });
        } else {
          window.location.hash = href("workspace", { id });
          goTo(parseRoute(window.location.hash));
        }
      },
      setRole(role) {
        if (role === "controller" || role === "reviewer") store.set({ role });
      },
      setTheme(next) {
        if (next === "light" || next === "dark") store.set({ theme: next });
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        window.removeEventListener("hashchange", onHashChange);
        stops.forEach((stop) => stop());
        shell.destroy();
        el.replaceChildren();
        el.classList.remove("cqa", "cqa--dark", "cqa--compact");
        if (window.__cqaTest?.store === store) delete window.__cqaTest;
      }
    };
  }

  // src/main.js
  var current = null;
  var pending = null;
  var clientApiContext = null;
  function handOver({ app, config }, formContext) {
    const id = extractConversationId(formContext, config);
    if (id) app.open(id);
  }
  function mount2(el, options) {
    if (current && current.el === el) current.app.destroy();
    const app = mount(el, options);
    current = { app, el, config: options?.config ?? window.CQA_CONFIG ?? {} };
    if (pending) {
      const { formContext } = pending;
      pending = null;
      handOver(current, formContext);
    }
    return app;
  }
  function setClientApiContext(xrm, formContext) {
    clientApiContext = { xrm, formContext };
    if (current) handOver(current, formContext);
    else pending = clientApiContext;
  }
  window.CQA = { mount: mount2, setClientApiContext, version };
  function autostart() {
    const root = document.getElementById("cqa-root");
    if (!root || !root.hasAttribute("data-autostart")) return;
    document.title = t("app.title");
    mount2(root);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autostart);
  else autostart();
})();
