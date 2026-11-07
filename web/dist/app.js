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
    const text3 = search.toString();
    return text3 ? `?${text3}` : "";
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
      let text3;
      try {
        const doFetch = fetchImpl;
        response = await doFetch(`${base}/${path}`, init);
        text3 = await response.text();
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
        data = JSON.parse(text3);
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
      createChecklist: async (checklist) => post("checklists", { checklist }),
      saveChecklistVersion: async (checklistId, checklist) => post(`checklists/${seg(checklistId, "checklist id")}/versions`, { checklist }),
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
    return sha256Hex(canonicalJson(fingerprintSubset(criterion)));
  }
  function fingerprintSubset(criterion) {
    const c = criterion || {};
    return {
      title: orNull(c.title),
      wording: orNull(c.wording),
      answer_type: orNull(c.answer_type),
      scale_steps: (Array.isArray(c.scale_steps) ? c.scale_steps : []).map((step) => ({
        value: orNull(step && step.value),
        label: orNull(step && step.label)
      })),
      na_allowed: orNull(c.na_allowed),
      na_condition: orNull(c.na_condition),
      kind: c.kind ?? "scored",
      kinds: Array.isArray(c.kinds) ? c.kinds : [],
      guidance: orNull(c.guidance)
    };
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
    const text3 = ts.trim();
    let m = CLOCK_MS.exec(text3);
    if (m) return { kind: "clock", seconds: Number(m[1]) * 60 + Number(m[2]) };
    m = CLOCK_HMS.exec(text3);
    if (m) return { kind: "clock", seconds: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) };
    m = ISO.exec(text3);
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
  function formatOffset(sec) {
    if (typeof sec !== "number" || !Number.isFinite(sec)) return "";
    const negative = sec < 0;
    const whole = Math.floor(Math.abs(sec) + 1e-6);
    const h2 = Math.floor(whole / 3600);
    const mm = Math.floor(whole % 3600 / 60);
    const ss = whole % 60;
    const pad2 = (n) => String(n).padStart(2, "0");
    const body = h2 > 0 ? `${h2}:${pad2(mm)}:${pad2(ss)}` : `${mm}:${pad2(ss)}`;
    return negative ? `-${body}` : body;
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
      const text3 = textOf(m);
      if (handover < 0 && HANDOVER.test(text3)) handover = i;
      if (identity < 0 && IDENTITY.test(text3)) identity = i;
      for (const [kind, pattern] of ENDINGS) if (pattern.test(text3)) ending = kind;
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
      const same3 = i > 0 && m.timestamp === prev.timestamp && m.speaker === prev.speaker && m.text === prev.text;
      return same3 || m.duplicate === true ? { ...m, duplicate: true } : m;
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
  function parseUpload(text3) {
    let data;
    try {
      data = JSON.parse(String(text3).replace(/^\uFEFF/, ""));
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
  function parse(text3) {
    const m = DECIMAL.exec(text3.trim());
    const intPart = m?.[2] ?? "";
    const fracPart = m?.[3] ?? "";
    if (!m || intPart + fracPart === "") {
      throw new TypeError(`not a decimal number: ${JSON.stringify(text3)}`);
    }
    let n = BigInt(intPart + fracPart);
    let d = 10n ** BigInt(fracPart.length);
    const exp = m[4] === void 0 ? 0 : Number(m[4]);
    if (!Number.isSafeInteger(exp) || Math.abs(exp) > 1e4) {
      throw new RangeError(`exponent out of range: ${JSON.stringify(text3)}`);
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
  function fmt2(a) {
    const q = hundredths(a);
    const abs = q < 0n ? -q : q;
    const whole = abs / 100n;
    const cents = String(abs % 100n).padStart(2, "0");
    return `${q < 0n ? "-" : ""}${whole}.${cents}`;
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
    let weightSum2 = ZERO;
    for (const e of entries) if (e.applicable) weightSum2 = add(weightSum2, e.weight);
    let total = ZERO;
    const perSection = /* @__PURE__ */ new Map();
    for (const e of entries) {
      if (!e.applicable) continue;
      const frac = fraction(e.criterion, e.answer);
      e.effective = div(mul(e.weight, HUNDRED), weightSum2);
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
      total: weightSum2.n > 0n ? round2(total) : null,
      // In their `order`, as the backend returns them (a stable sort keeps ties in array order).
      sections: [...version2.sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((s) => {
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
  var stripNaPrefix = (text3) => String(text3 ?? "").replace(/^N\/A\s*[—–-]\s*/i, "");
  var capitalize = (text3) => text3.charAt(0).toUpperCase() + text3.slice(1);
  var stripYesPrefix = (text3) => String(text3 ?? "").replace(/^Да\s*[—–-]\s*/, "");
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
    const same3 = sameAnswer(answer, current2);
    const reasoning = same3 ? `\u0414\u0435\u043C\u043E-\u0432\u0442\u043E\u0440\u043E\u0435 \u043C\u043D\u0435\u043D\u0438\u0435: \u0438\u0441\u0445\u043E\u0434\u043D\u0430\u044F \u043E\u0446\u0435\u043D\u043A\u0430 \xAB${answerLabel(current2)}\xBB \u043F\u043E \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044E \xAB${criterion.title}\xBB \u0432\u044B\u0433\u043B\u044F\u0434\u0438\u0442 \u0432\u0435\u0440\u043D\u043E\u0439.` : `\u0414\u0435\u043C\u043E-\u0432\u0442\u043E\u0440\u043E\u0435 \u043C\u043D\u0435\u043D\u0438\u0435: \u043F\u043E \u0440\u0435\u043F\u043B\u0438\u043A\u0430\u043C \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0430 \u043E\u0442\u0432\u0435\u0442 \xAB${answerLabel(answer)}\xBB \u043F\u043E\u0434\u0445\u043E\u0434\u0438\u0442 \u043B\u0443\u0447\u0448\u0435, \u0447\u0435\u043C \xAB${answerLabel(current2)}\xBB.`;
    return { answer, reasoning };
  }
  var MOODS = ["\u043D\u0435\u0439\u0442\u0440\u0430\u043B\u044C\u043D\u043E\u0435", "\u043F\u043E\u0437\u0438\u0442\u0438\u0432\u043D\u043E\u0435", "\u0440\u0430\u0437\u0434\u0440\u0430\u0436\u0451\u043D\u043D\u043E\u0435", "\u0442\u0440\u0435\u0432\u043E\u0436\u043D\u043E\u0435"];
  var OUTCOMES = ["resolved", "passed_to_specialists", "unresolved"];
  function mockInfo(conversation) {
    const rng = seeded(`${conversation.id}|info`);
    const first = (conversation.transcript ?? []).find((m) => m.speaker === "client" && m.text.trim() !== "");
    const text3 = first ? first.text.trim().replace(/\s+/g, " ") : "";
    const topic = text3.length > 80 ? `${text3.slice(0, 79).trimEnd()}\u2026` : text3 || null;
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
    const text3 = String(value);
    return NEEDS_QUOTES.test(text3) ? `"${text3.replaceAll('"', '""')}"` : text3;
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
  var agreement = (part, whole) => whole === 0 ? null : rate(part, whole);
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
    const strip = ({ hit: h2, n: count, ...rest }) => ({ ...rest, agreement: agreement(h2, count), n: count });
    return {
      reference_note: REFERENCE_NOTE,
      model: MODEL,
      overall: { agreement: agreement(hit, n), n },
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

  // src/i18n/ru.js
  var messages = {
    "app.title": "\u041A\u0430\u0447\u0435\u0441\u0442\u0432\u043E \u0434\u0438\u0430\u043B\u043E\u0433\u043E\u0432",
    "brand.name": "Freedom \u2014 \u043D\u0430 \u0433\u043B\u0430\u0432\u043D\u0443\u044E",
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
    "queue.groupFilter": "\u041D\u0430\u0431\u043E\u0440 \u0434\u0430\u043D\u043D\u044B\u0445",
    "queue.group.all": "\u0412\u0441\u0435 \u043D\u0430\u0431\u043E\u0440\u044B",
    "queue.selectAll": "\u0412\u044B\u0431\u0440\u0430\u0442\u044C \u0432\u0441\u0435 \u043F\u043E\u043A\u0430\u0437\u0430\u043D\u043D\u044B\u0435",
    "queue.load": "\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C",
    "queue.export": "\u0421\u043A\u0430\u0447\u0430\u0442\u044C Excel (CSV)",
    "queue.loadTitle": "\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0433\u0440\u0443\u043F\u043F\u0443 \u043F\u043E group_id \u0438\u043B\u0438 \u0444\u0430\u0439\u043B \u0441 \u0434\u0438\u0430\u043B\u043E\u0433\u0430\u043C\u0438",
    "loader.title": "\u0417\u0430\u0433\u0440\u0443\u0437\u043A\u0430 \u0434\u0438\u0430\u043B\u043E\u0433\u043E\u0432",
    "loader.close": "\u0417\u0430\u043A\u0440\u044B\u0442\u044C",
    "loader.group": "\u0413\u0440\u0443\u043F\u043F\u0430 \u043F\u043E group_id",
    "loader.groupHint": "\u0414\u0438\u0430\u043B\u043E\u0433\u0438 \u043F\u0440\u0438\u0434\u0443\u0442 \u043E\u0442 \u043E\u0440\u0433\u0430\u043D\u0438\u0437\u0430\u0442\u043E\u0440\u043E\u0432 \u0447\u0435\u0440\u0435\u0437 \u043D\u0430\u0448 \u0441\u0435\u0440\u0432\u0435\u0440.",
    "loader.groupPlaceholder": "\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, CTRL",
    "loader.import": "\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0433\u0440\u0443\u043F\u043F\u0443",
    "loader.importing": "\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u044E \u0433\u0440\u0443\u043F\u043F\u0443 {group}\u2026",
    "loader.file": "\u0424\u0430\u0439\u043B \u0441 \u0434\u0438\u0430\u043B\u043E\u0433\u0430\u043C\u0438 (JSON)",
    "loader.fileHint": "\u041E\u0434\u043D\u0430 \u0437\u0430\u043F\u0438\u0441\u044C, \u043C\u0430\u0441\u0441\u0438\u0432 \u0437\u0430\u043F\u0438\u0441\u0435\u0439 \u0438\u043B\u0438 \u0432\u0435\u0441\u044C \u043E\u0442\u0432\u0435\u0442 \u043E\u0440\u0433\u0430\u043D\u0438\u0437\u0430\u0442\u043E\u0440\u043E\u0432.",
    "loader.uploading": "\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u044E \u0444\u0430\u0439\u043B {name}\u2026",
    "loader.summary": "\u0412\u0441\u0435\u0433\u043E {total} \xB7 \u043D\u043E\u0432\u044B\u0445 {imported} \xB7 \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u043E {updated} \xB7 \u0431\u0435\u0437 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u0439 {unchanged}",
    "loader.summaryGroup": "\u041D\u0430\u0431\u043E\u0440 {group}",
    "loader.error.not_json": "\u0424\u0430\u0439\u043B \u043D\u0435 \u0432 \u0444\u043E\u0440\u043C\u0430\u0442\u0435 JSON.",
    "loader.error.no_records": "\u0412 \u0444\u0430\u0439\u043B\u0435 \u043D\u0435\u0442 \u043D\u0438 \u043E\u0434\u043D\u043E\u0439 \u0437\u0430\u043F\u0438\u0441\u0438.",
    "loader.error.bad_record": "\u0417\u0430\u043F\u0438\u0441\u044C \u2116{n} \u0432 \u0444\u0430\u0439\u043B\u0435 \u043D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u0430: \u043D\u0443\u0436\u043D\u044B conversation_id, channel, language \u0438 transcript.",
    "loader.error.read": "\u0424\u0430\u0439\u043B \u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0442\u044C.",
    "batch.label": "\u041F\u0430\u043A\u0435\u0442\u043D\u0430\u044F \u043E\u0446\u0435\u043D\u043A\u0430",
    "batch.selected": "\u0412\u044B\u0431\u0440\u0430\u043D\u043E: {n}",
    "batch.checklist": "\u0427\u0435\u043A-\u043B\u0438\u0441\u0442",
    "batch.estimating": "\u0421\u0447\u0438\u0442\u0430\u044E, \u0441\u043A\u043E\u043B\u044C\u043A\u043E \u043D\u0443\u0436\u043D\u043E \u0432\u044B\u0437\u043E\u0432\u043E\u0432\u2026",
    "batch.estimate": "{dialogs} \xB7 {calls} \u043C\u043E\u0434\u0435\u043B\u0438 \xB7 {cached} \u0438\u0437 \u043A\u044D\u0448\u0430",
    "batch.run": "\u041E\u0446\u0435\u043D\u0438\u0442\u044C \u0432\u044B\u0431\u0440\u0430\u043D\u043D\u044B\u0435",
    "batch.clear": "\u0421\u043D\u044F\u0442\u044C \u0432\u044B\u0431\u043E\u0440",
    "batch.keyMissing": "\u043D\u0443\u0436\u0435\u043D \u043A\u043B\u044E\u0447 \u043C\u043E\u0434\u0435\u043B\u0438: \u0447\u0430\u0441\u0442\u044C \u043E\u0442\u0432\u0435\u0442\u043E\u0432 \u043D\u0443\u0436\u043D\u043E \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u0443 \u043C\u043E\u0434\u0435\u043B\u0438",
    "batch.progress": "\u041E\u0446\u0435\u043D\u0435\u043D\u043E {done} \u0438\u0437 {total}",
    "batch.failed": "\u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C: {n}",
    "batch.retry": "\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u044C \u043D\u0435\u0443\u0434\u0430\u0447\u043D\u044B\u0435",
    "batch.done": "\u0413\u043E\u0442\u043E\u0432\u043E: \u043E\u0446\u0435\u043D\u0435\u043D\u043E {done} \u0438\u0437 {total}",
    "batch.starting": "\u0417\u0430\u043F\u0443\u0441\u043A\u0430\u044E \u043E\u0446\u0435\u043D\u043A\u0443\u2026",
    "batch.interrupted": "\u0421\u0432\u044F\u0437\u044C \u0441 \u0441\u0435\u0440\u0432\u0435\u0440\u043E\u043C \u043F\u0440\u0435\u0440\u0432\u0430\u043B\u0430\u0441\u044C \u043D\u0430 {done} \u0438\u0437 {total}: \u043E\u0446\u0435\u043D\u043A\u0430 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u0435\u0442\u0441\u044F \u043D\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0435.",
    "batch.resume": "\u041F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u044C \u0441\u043B\u0435\u0434\u0438\u0442\u044C",
    "batch.dialogs.one": "{n} \u0434\u0438\u0430\u043B\u043E\u0433",
    "batch.dialogs.few": "{n} \u0434\u0438\u0430\u043B\u043E\u0433\u0430",
    "batch.dialogs.many": "{n} \u0434\u0438\u0430\u043B\u043E\u0433\u043E\u0432",
    "batch.calls.one": "{n} \u0432\u044B\u0437\u043E\u0432",
    "batch.calls.few": "{n} \u0432\u044B\u0437\u043E\u0432\u0430",
    "batch.calls.many": "{n} \u0432\u044B\u0437\u043E\u0432\u043E\u0432",
    "checklists.create": "\u0421\u043E\u0437\u0434\u0430\u0442\u044C \u0447\u0435\u043A-\u043B\u0438\u0441\u0442",
    "checklists.note": "\u041E\u0444\u0438\u0446\u0438\u0430\u043B\u044C\u043D\u044B\u0439 \u0447\u0435\u043A-\u043B\u0438\u0441\u0442 \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D: \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F \u0441\u043E\u0445\u0440\u0430\u043D\u044F\u044E\u0442\u0441\u044F \u043A\u0430\u043A \u043D\u043E\u0432\u044B\u0439 \u0447\u0435\u043A-\u043B\u0438\u0441\u0442 \u043D\u0430 \u0435\u0433\u043E \u043E\u0441\u043D\u043E\u0432\u0435. \u0421\u0443\u043C\u043C\u0430 \u0432\u0435\u0441\u043E\u0432 \u043C\u043E\u0436\u0435\u0442 \u043E\u0442\u043B\u0438\u0447\u0430\u0442\u044C\u0441\u044F \u043E\u0442 100 \u2014 \u0438\u0442\u043E\u0433 \u0432\u0441\u0451 \u0440\u0430\u0432\u043D\u043E \u043F\u0435\u0440\u0435\u0441\u0447\u0438\u0442\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u043A 100.",
    "checklists.loading": "\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u044E \u0447\u0435\u043A-\u043B\u0438\u0441\u0442\u044B\u2026",
    "checklists.loadFailed": "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0447\u0435\u043A-\u043B\u0438\u0441\u0442\u044B",
    "checklists.locked": "\u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D",
    "checklists.channel.any": "\u043B\u044E\u0431\u043E\u0439 \u043A\u0430\u043D\u0430\u043B",
    "checklists.channel.chat": "\u0447\u0430\u0442\u044B",
    "checklists.channel.call": "\u0437\u0432\u043E\u043D\u043A\u0438",
    "checklists.version": "v{version} (\u0432\u0435\u0440\u0441\u0438\u0439: {count})",
    "checklists.criteria.one": "{n} \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0439",
    "checklists.criteria.few": "{n} \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044F",
    "checklists.criteria.many": "{n} \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0435\u0432",
    "checklists.weights": "\u0441\u0443\u043C\u043C\u0430 \u0432\u0435\u0441\u043E\u0432 {sum}",
    "checklists.basedOn": "\u043D\u0430 \u043E\u0441\u043D\u043E\u0432\u0435 \xAB{name}\xBB v{version}",
    "checklists.open": "\u041E\u0442\u043A\u0440\u044B\u0442\u044C",
    "checklists.copy": "\u041A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C",
    "editor.loading": "\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u044E \u0447\u0435\u043A-\u043B\u0438\u0441\u0442\u2026",
    "editor.loadFailed": "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0447\u0435\u043A-\u043B\u0438\u0441\u0442",
    "editor.titleNew": "\u041D\u043E\u0432\u044B\u0439 \u0447\u0435\u043A-\u043B\u0438\u0441\u0442",
    "editor.newName": "\u041D\u043E\u0432\u044B\u0439 \u0447\u0435\u043A-\u043B\u0438\u0441\u0442",
    "editor.newNote": "\u0427\u0435\u043A-\u043B\u0438\u0441\u0442 \u0441\u043E\u0437\u0434\u0430\u0451\u0442\u0441\u044F \u043F\u0440\u0438 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0438\u0438.",
    "editor.newSection": "\u041D\u043E\u0432\u044B\u0439 \u0440\u0430\u0437\u0434\u0435\u043B",
    "editor.copyName": "{name} (\u0438\u0437\u043C\u0435\u043D\u0451\u043D\u043D\u044B\u0439)",
    "editor.lockedNote": "\u0412\u0435\u0440\u0441\u0438\u044F \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u043E\u0432\u0430\u043D\u0430: \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0438\u0435 \u0441\u043E\u0437\u0434\u0430\u0441\u0442 \u043D\u043E\u0432\u044B\u0439 \u0447\u0435\u043A-\u043B\u0438\u0441\u0442 \u043D\u0430 \u0435\u0451 \u043E\u0441\u043D\u043E\u0432\u0435.",
    "editor.versionNote": "\u041A\u0430\u0436\u0434\u043E\u0435 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0438\u0435 \u0441\u043E\u0437\u0434\u0430\u0451\u0442 \u043D\u043E\u0432\u0443\u044E \u0432\u0435\u0440\u0441\u0438\u044E; \u043F\u0440\u0435\u0436\u043D\u0438\u0435 \u0432\u0435\u0440\u0441\u0438\u0438 \u0438 \u0438\u0445 \u043E\u0446\u0435\u043D\u043A\u0438 \u043D\u0435 \u043C\u0435\u043D\u044F\u044E\u0442\u0441\u044F.",
    "editor.back": "\u2190 \u0412\u0441\u0435 \u0447\u0435\u043A-\u043B\u0438\u0441\u0442\u044B",
    "editor.apply": "\u041F\u0440\u0438\u043C\u0435\u043D\u0438\u0442\u044C \u043A \u0434\u0438\u0430\u043B\u043E\u0433\u0430\u043C",
    "editor.saved": "\u0421\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E: \xAB{name}\xBB v{version}. \u041F\u0440\u0438\u043C\u0435\u043D\u0438\u0442\u0435 \u0435\u0433\u043E \u043A \u0434\u0438\u0430\u043B\u043E\u0433\u0430\u043C, \u0447\u0442\u043E\u0431\u044B \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u043E\u0446\u0435\u043D\u043A\u0438.",
    "editor.name": "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435",
    "editor.channel": "\u041A\u0430\u043D\u0430\u043B (\u0442\u043E\u043B\u044C\u043A\u043E \u043F\u0440\u0435\u0434\u0432\u044B\u0431\u043E\u0440)",
    "editor.sectionTitle": "\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u0440\u0430\u0437\u0434\u0435\u043B\u0430",
    "editor.critTitle": "\u041A\u0440\u0438\u0442\u0435\u0440\u0438\u0439",
    "editor.wording": "\u0424\u043E\u0440\u043C\u0443\u043B\u0438\u0440\u043E\u0432\u043A\u0430 \u0434\u043B\u044F \u043E\u0446\u0435\u043D\u0449\u0438\u043A\u0430",
    "editor.type": "\u0422\u0438\u043F \u043E\u0442\u0432\u0435\u0442\u0430",
    "editor.type.yes_no": "\u0414\u0430 / \u041D\u0435\u0442",
    "editor.type.scale": "\u0428\u043A\u0430\u043B\u0430",
    "editor.kind": "\u0412\u0438\u0434",
    "editor.kind.scored": "\u041E\u0446\u0435\u043D\u043E\u0447\u043D\u044B\u0439",
    "editor.kind.gross_error": "\u0413\u0440\u0443\u0431\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430 (\u0444\u043B\u0430\u0433, \u0431\u0435\u0437 \u0431\u0430\u043B\u043B\u043E\u0432)",
    "editor.weight": "\u0412\u0435\u0441",
    "editor.section": "\u0420\u0430\u0437\u0434\u0435\u043B",
    "editor.steps": "\u0428\u0430\u0433\u0438 \u0448\u043A\u0430\u043B\u044B: \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435 \u0438 \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435",
    "editor.stepValue": "\u0417\u043D\u0430\u0447\u0435\u043D\u0438\u0435 \u0448\u0430\u0433\u0430",
    "editor.stepLabel": "\u041E\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0448\u0430\u0433\u0430",
    "editor.removeStep": "\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u0448\u0430\u0433",
    "editor.addStep": "+ \u0448\u0430\u0433",
    "editor.naAllowed": "\u041C\u043E\u0436\u043D\u043E \u043E\u0442\u0432\u0435\u0442\u0438\u0442\u044C N/A",
    "editor.naCondition": "\u041A\u043E\u0433\u0434\u0430 \u0441\u0442\u0430\u0432\u0438\u0442\u0441\u044F N/A",
    "editor.kinds": "\u0412\u0438\u0434\u044B \u043D\u0430\u0440\u0443\u0448\u0435\u043D\u0438\u0439 (\u0447\u0435\u0440\u0435\u0437 \u0437\u0430\u043F\u044F\u0442\u0443\u044E)",
    "editor.more": "\u041F\u043E\u0434\u0441\u043A\u0430\u0437\u043A\u0430 \u0438 \u043C\u043E\u0434\u0435\u043B\u044C",
    "editor.guidance": "\u041F\u043E\u0434\u0441\u043A\u0430\u0437\u043A\u0430 \u0434\u043B\u044F \u043C\u043E\u0434\u0435\u043B\u0438",
    "editor.model": "\u041C\u043E\u0434\u0435\u043B\u044C \u0434\u043B\u044F \u044D\u0442\u043E\u0433\u043E \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044F",
    "editor.modelDefault": "\u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E",
    "editor.removeCriterion": "\u0423\u0434\u0430\u043B\u0438\u0442\u044C",
    "editor.addCriterion": "+ \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0439",
    "editor.addSection": "+ \u0440\u0430\u0437\u0434\u0435\u043B",
    "editor.removeSection": "\u0423\u0434\u0430\u043B\u0438\u0442\u044C \u0440\u0430\u0437\u0434\u0435\u043B",
    "editor.removed": "\u0423\u0434\u0430\u043B\u0435\u043D\u044B:",
    "editor.restore": "\u0432\u0435\u0440\u043D\u0443\u0442\u044C",
    "editor.badge.new": "\u043D\u043E\u0432\u044B\u0439",
    "editor.badge.reworded": "\u0438\u0437\u043C\u0435\u043D\u0451\u043D",
    "editor.badge.weight": "\u0442\u043E\u043B\u044C\u043A\u043E \u0432\u0435\u0441",
    "editor.diff": "\u043D\u043E\u0432\u044B\u0445: {added} \xB7 \u0443\u0434\u0430\u043B\u0435\u043D\u043E: {removed} \xB7 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u043E: {reworded} \xB7 \u0442\u043E\u043B\u044C\u043A\u043E \u0432\u0435\u0441: {weight}",
    "editor.weightSum": "\u0421\u0443\u043C\u043C\u0430 \u0432\u0435\u0441\u043E\u0432: {sum}, \u043D\u0435 100. \u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u043C\u043E\u0436\u043D\u043E: \u0438\u0442\u043E\u0433 \u0432\u0441\u0451 \u0440\u0430\u0432\u043D\u043E \u043F\u0435\u0440\u0435\u0441\u0447\u0438\u0442\u0430\u0435\u0442\u0441\u044F \u043A 100.",
    "editor.errorCount": "\u0418\u0441\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u043E\u0442\u043C\u0435\u0447\u0435\u043D\u043D\u044B\u0435 \u043F\u043E\u043B\u044F: {n}",
    "editor.create": "\u0421\u043E\u0437\u0434\u0430\u0442\u044C \u0447\u0435\u043A-\u043B\u0438\u0441\u0442",
    "editor.saveAsNew": "\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u043A\u0430\u043A \u043D\u043E\u0432\u044B\u0439 \u0447\u0435\u043A-\u043B\u0438\u0441\u0442",
    "editor.saveVersion": "\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u0432\u0435\u0440\u0441\u0438\u044E",
    "editor.error.title_required": "\u0417\u0430\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u0435.",
    "editor.error.weight_invalid": "\u0412\u0435\u0441 \u2014 \u0447\u0438\u0441\u043B\u043E \u043E\u0442 0 (\u043C\u043E\u0436\u043D\u043E \u0441 \u0437\u0430\u043F\u044F\u0442\u043E\u0439: 7,5).",
    "editor.error.scale_empty": "\u0423 \u0448\u043A\u0430\u043B\u044B \u0434\u043E\u043B\u0436\u043D\u043E \u0431\u044B\u0442\u044C \u0445\u043E\u0442\u044F \u0431\u044B \u0434\u0432\u0430 \u0448\u0430\u0433\u0430.",
    "editor.error.scale_value_invalid": "\u0417\u043D\u0430\u0447\u0435\u043D\u0438\u0435 \u0448\u0430\u0433\u0430 \u2014 \u0447\u0438\u0441\u043B\u043E.",
    "editor.error.scale_duplicate": "\u0417\u043D\u0430\u0447\u0435\u043D\u0438\u044F \u0448\u0430\u0433\u043E\u0432 \u043D\u0435 \u0434\u043E\u043B\u0436\u043D\u044B \u043F\u043E\u0432\u0442\u043E\u0440\u044F\u0442\u044C\u0441\u044F.",
    "editor.error.na_condition_required": "\u041E\u043F\u0438\u0448\u0438\u0442\u0435, \u043A\u043E\u0433\u0434\u0430 \u0441\u0442\u0430\u0432\u0438\u0442\u0441\u044F N/A.",
    "editor.error.section_missing": "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0440\u0430\u0437\u0434\u0435\u043B.",
    "editor.error.criteria_empty": "\u0414\u043E\u0431\u0430\u0432\u044C\u0442\u0435 \u0445\u043E\u0442\u044F \u0431\u044B \u043E\u0434\u0438\u043D \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0439.",
    "apply.title": "\u041F\u0440\u0438\u043C\u0435\u043D\u0438\u0442\u044C \u043A \u0434\u0438\u0430\u043B\u043E\u0433\u0430\u043C",
    "apply.what": "\xAB{name}\xBB v{version}: \u043D\u0435\u0438\u0437\u043C\u0435\u043D\u0451\u043D\u043D\u044B\u0435 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0438 \u0431\u0435\u0440\u0443\u0442\u0441\u044F \u0438\u0437 \u043F\u0440\u0435\u0436\u043D\u0438\u0445 \u043E\u0442\u0432\u0435\u0442\u043E\u0432, \u0431\u0435\u0437 \u0432\u044B\u0437\u043E\u0432\u0430 \u043C\u043E\u0434\u0435\u043B\u0438.",
    "apply.loading": "\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u044E \u0434\u0438\u0430\u043B\u043E\u0433\u0438\u2026",
    "apply.targets": "\u041A\u0430\u043A\u0438\u0435 \u0434\u0438\u0430\u043B\u043E\u0433\u0438",
    "apply.control": "\u041A\u043E\u043D\u0442\u0440\u043E\u043B\u044C\u043D\u0430\u044F \u0433\u0440\u0443\u043F\u043F\u0430 {group}",
    "apply.controlNone": "\u041A\u043E\u043D\u0442\u0440\u043E\u043B\u044C\u043D\u0430\u044F \u0433\u0440\u0443\u043F\u043F\u0430 (\u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043D\u0430)",
    "apply.dev": "DEV",
    "apply.selected": "\u0412\u044B\u0431\u0440\u0430\u043D\u043D\u044B\u0435 \u0432 \u043E\u0447\u0435\u0440\u0435\u0434\u0438",
    "apply.noAll": "\u041F\u0440\u0438\u043C\u0435\u043D\u0438\u0442\u044C \u043A\u043E \u0432\u0441\u0435\u043C \u0441\u0440\u0430\u0437\u0443 \u043D\u0435\u043B\u044C\u0437\u044F: \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u043D\u0430\u0431\u043E\u0440.",
    "apply.run": "\u0417\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C",
    "apply.close": "\u0417\u0430\u043A\u0440\u044B\u0442\u044C",
    "apply.compare": "\u0421\u0440\u0430\u0432\u043D\u0438\u0442\u044C \u0434\u043E \u0438 \u043F\u043E\u0441\u043B\u0435",
    "player.label": "\u0417\u0430\u043F\u0438\u0441\u044C \u0437\u0432\u043E\u043D\u043A\u0430",
    "player.needsImport": "\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u0435 \u0433\u0440\u0443\u043F\u043F\u0443, \u0447\u0442\u043E\u0431\u044B \u0432\u043A\u043B\u044E\u0447\u0438\u0442\u044C \u0437\u0430\u043F\u0438\u0441\u044C.",
    "player.none": "\u0417\u0430\u043F\u0438\u0441\u0438 \u044D\u0442\u043E\u0433\u043E \u0437\u0432\u043E\u043D\u043A\u0430 \u043D\u0435\u0442.",
    "player.import": "\u0417\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0433\u0440\u0443\u043F\u043F\u0443",
    "player.failed": "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0437\u0430\u043F\u0438\u0441\u044C.",
    "player.retry": "\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u044C",
    "player.seek": "\u041F\u0435\u0440\u0435\u0439\u0442\u0438 \u043A {time} \u0432 \u0437\u0430\u043F\u0438\u0441\u0438",
    "compare.title": "\u0421\u0440\u0430\u0432\u043D\u0435\u043D\u0438\u0435 \u0434\u043E \u0438 \u043F\u043E\u0441\u043B\u0435",
    "compare.note": "\u0421\u0440\u0430\u0432\u043D\u0438\u0432\u0430\u044E\u0442\u0441\u044F \u0438\u0442\u043E\u0433\u043E\u0432\u044B\u0435 \u0431\u0430\u043B\u043B\u044B (\u0441 \u0440\u0435\u0448\u0435\u043D\u0438\u044F\u043C\u0438 \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u044E\u0449\u0438\u0445), \u043F\u043E\u044D\u0442\u043E\u043C\u0443 \u043A\u0430\u0436\u0434\u0430\u044F \u0440\u0430\u0437\u043D\u0438\u0446\u0430 \u0438\u0434\u0451\u0442 \u043E\u0442 \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F \u0447\u0435\u043A-\u043B\u0438\u0441\u0442\u0430.",
    "compare.from": "\u0411\u044B\u043B\u043E",
    "compare.to": "\u0421\u0442\u0430\u043B\u043E",
    "compare.group": "\u0413\u0440\u0443\u043F\u043F\u0430",
    "compare.group.all": "\u0412\u0441\u0435 \u0433\u0440\u0443\u043F\u043F\u044B",
    "compare.choose": "\u2014 \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0432\u0435\u0440\u0441\u0438\u044E \u2014",
    "compare.pickTitle": "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435, \u0447\u0442\u043E \u0441\u0440\u0430\u0432\u043D\u0438\u0442\u044C",
    "compare.pickNote": "\u0414\u0432\u0435 \u0432\u0435\u0440\u0441\u0438\u0438 \u0447\u0435\u043A-\u043B\u0438\u0441\u0442\u0430 (\u0438\u043B\u0438 \u0434\u0432\u0430 \u0447\u0435\u043A-\u043B\u0438\u0441\u0442\u0430): \u0438\u0442\u043E\u0433\u043E\u0432\u044B\u0435 \u0431\u0430\u043B\u043B\u044B \u0434\u0438\u0430\u043B\u043E\u0433\u043E\u0432, \u043E\u0446\u0435\u043D\u0451\u043D\u043D\u044B\u0445 \u043E\u0431\u0435\u0438\u043C\u0438.",
    "compare.loading": "\u0421\u0440\u0430\u0432\u043D\u0438\u0432\u0430\u044E\u2026",
    "compare.loadFailed": "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u0441\u0442\u0440\u043E\u0438\u0442\u044C \u0441\u0440\u0430\u0432\u043D\u0435\u043D\u0438\u0435",
    "compare.retry": "\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u044C",
    "compare.empty": "\u041D\u0435\u0442 \u0434\u0438\u0430\u043B\u043E\u0433\u043E\u0432, \u043E\u0446\u0435\u043D\u0451\u043D\u043D\u044B\u0445 \u043E\u0431\u0435\u0438\u043C\u0438 \u0432\u0435\u0440\u0441\u0438\u044F\u043C\u0438",
    "compare.emptyNote": "\u041F\u0440\u0438\u043C\u0435\u043D\u0438\u0442\u0435 \u043D\u043E\u0432\u0443\u044E \u0432\u0435\u0440\u0441\u0438\u044E \u043A \u0434\u0438\u0430\u043B\u043E\u0433\u0430\u043C (\xAB\u041F\u0440\u0438\u043C\u0435\u043D\u0438\u0442\u044C \u043A \u0434\u0438\u0430\u043B\u043E\u0433\u0430\u043C\xBB \u0432 \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440\u0435 \u0447\u0435\u043A-\u043B\u0438\u0441\u0442\u0430), \u0438 \u0441\u0440\u0430\u0432\u043D\u0435\u043D\u0438\u0435 \u043F\u043E\u044F\u0432\u0438\u0442\u0441\u044F \u0437\u0434\u0435\u0441\u044C.",
    "compare.summary": "{changed} \u0438\u0437 {of} {verb}, \u0432 \u0441\u0440\u0435\u0434\u043D\u0435\u043C {avg}",
    "compare.ofDialogs.one": "{n} \u0434\u0438\u0430\u043B\u043E\u0433\u0430",
    "compare.ofDialogs.few": "{n} \u0434\u0438\u0430\u043B\u043E\u0433\u043E\u0432",
    "compare.ofDialogs.many": "{n} \u0434\u0438\u0430\u043B\u043E\u0433\u043E\u0432",
    "compare.changedVerb.one": "\u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0441\u044F",
    "compare.changedVerb.few": "\u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0438\u0441\u044C",
    "compare.changedVerb.many": "\u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0438\u0441\u044C",
    "compare.table": "\u0414\u0438\u0430\u043B\u043E\u0433\u0438: \u0431\u044B\u043B\u043E, \u0441\u0442\u0430\u043B\u043E, \u0440\u0430\u0437\u043D\u0438\u0446\u0430",
    "compare.col.id": "\u0414\u0438\u0430\u043B\u043E\u0433",
    "compare.col.group": "\u0413\u0440\u0443\u043F\u043F\u0430",
    "compare.col.old": "\u0411\u044B\u043B\u043E",
    "compare.col.new": "\u0421\u0442\u0430\u043B\u043E",
    "compare.col.delta": "\u0394",
    "compare.sortBy": "\u0421\u043E\u0440\u0442\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u043F\u043E \u0441\u0442\u043E\u043B\u0431\u0446\u0443 \xAB{column}\xBB",
    "compare.openTitle": "\u041F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u043E\u0446\u0435\u043D\u043A\u0438 \u0440\u044F\u0434\u043E\u043C",
    "compare.side.label": "\u041E\u0431\u0435 \u043E\u0446\u0435\u043D\u043A\u0438 \u0434\u0438\u0430\u043B\u043E\u0433\u0430 \u0440\u044F\u0434\u043E\u043C",
    "compare.side.title": "\u0414\u0438\u0430\u043B\u043E\u0433 {id}",
    "compare.side.open": "\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u0434\u0438\u0430\u043B\u043E\u0433",
    "compare.side.totals": "{old} \u2192 {new} ({delta})",
    "compare.side.all": "\u041F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u0432\u0441\u0435 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0438",
    "compare.side.criteria": "\u041A\u0440\u0438\u0442\u0435\u0440\u0438\u0438: \u0431\u044B\u043B\u043E \u0438 \u0441\u0442\u0430\u043B\u043E",
    "compare.side.loading": "\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u044E \u043E\u0446\u0435\u043D\u043A\u0438\u2026",
    "compare.side.loadFailed": "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u043E\u0446\u0435\u043D\u043A\u0438",
    "compare.side.none": "\u041E\u0442\u0432\u0435\u0442\u044B \u043F\u043E \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044F\u043C \u043D\u0435 \u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0438\u0441\u044C.",
    "compare.side.absent": "\u043D\u0435\u0442 \u0432 \u044D\u0442\u043E\u0439 \u0432\u0435\u0440\u0441\u0438\u0438",
    "compare.side.noResult": "\u043D\u0435\u0442 \u043E\u0446\u0435\u043D\u043A\u0438",
    "compare.side.onlyOld": "\u0442\u043E\u043B\u044C\u043A\u043E \u0432 \xAB\u0411\u044B\u043B\u043E\xBB",
    "compare.side.onlyNew": "\u0442\u043E\u043B\u044C\u043A\u043E \u0432 \xAB\u0421\u0442\u0430\u043B\u043E\xBB",
    "compare.side.reworded": "\u0431\u044B\u043B\u043E: {title}",
    "transcript.loading": "\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u044E \u0434\u0438\u0430\u043B\u043E\u0433 {id}\u2026",
    "transcript.loadFailed": "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0434\u0438\u0430\u043B\u043E\u0433 {id}",
    "transcript.retry": "\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u044C",
    "transcript.empty": "\u041D\u0435\u0442 \u0440\u0435\u043F\u043B\u0438\u043A",
    "transcript.emptyNote": "\u0412 \u044D\u0442\u043E\u0439 \u0437\u0430\u043F\u0438\u0441\u0438 \u043D\u0435\u0442 \u043D\u0438 \u043E\u0434\u043D\u043E\u0439 \u0440\u0435\u043F\u043B\u0438\u043A\u0438.",
    "transcript.label": "\u0414\u0438\u0430\u043B\u043E\u0433",
    "transcript.lines": "\u0420\u0435\u043F\u043B\u0438\u043A: {n}",
    "transcript.speaker.client": "\u041A\u043B\u0438\u0435\u043D\u0442",
    "transcript.speaker.operator": "\u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440",
    "transcript.speaker.bot": "\u0411\u043E\u0442",
    "transcript.speaker.system": "\u0421\u0438\u0441\u0442\u0435\u043C\u0430",
    "transcript.speaker.other": "\u0414\u0440\u0443\u0433\u043E\u0435",
    "transcript.duplicate": "\u043F\u043E\u0432\u0442\u043E\u0440",
    "transcript.duplicateTitle": "\u041F\u043E\u0432\u0442\u043E\u0440 \u043F\u0440\u0435\u0434\u044B\u0434\u0443\u0449\u0435\u0439 \u0440\u0435\u043F\u043B\u0438\u043A\u0438",
    "transcript.expectedHere": "\u0437\u0434\u0435\u0441\u044C \u043E\u0436\u0438\u0434\u0430\u043B\u043E\u0441\u044C",
    "scorecard.label": "\u041E\u0446\u0435\u043D\u043A\u0430 \u0434\u0438\u0430\u043B\u043E\u0433\u0430",
    "scorecard.checklist": "\u0427\u0435\u043A-\u043B\u0438\u0441\u0442",
    "scorecard.checklistOption": "{name} \xB7 v{version}",
    "scorecard.run": "\u041E\u0446\u0435\u043D\u0438\u0442\u044C",
    "scorecard.rerun": "\u041F\u0435\u0440\u0435\u043E\u0446\u0435\u043D\u0438\u0442\u044C",
    "scorecard.runFull": "\u041F\u0435\u0440\u0435\u043E\u0446\u0435\u043D\u0438\u0442\u044C \u0432\u0441\u0451",
    "scorecard.runFullTitle": "\u0417\u0430\u043D\u043E\u0432\u043E \u043E\u0446\u0435\u043D\u0438\u0442\u044C \u0432\u0441\u0435 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0438, \u043D\u0435 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u044F \u043F\u0440\u0435\u0436\u043D\u0438\u0435 \u0440\u0435\u0437\u0443\u043B\u044C\u0442\u0430\u0442\u044B",
    "scorecard.keyMissing": "\u043D\u0443\u0436\u0435\u043D \u043A\u043B\u044E\u0447 \u043C\u043E\u0434\u0435\u043B\u0438",
    "scorecard.progress": "\u0418\u0434\u0451\u0442 \u043E\u0446\u0435\u043D\u043A\u0430: {done}/{total}",
    "scorecard.starting": "\u0417\u0430\u043F\u0443\u0441\u043A\u0430\u044E \u043E\u0446\u0435\u043D\u043A\u0443\u2026",
    "scorecard.jobFailed": "\u041E\u0446\u0435\u043D\u0438\u0442\u044C \u043D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C",
    "scorecard.retry": "\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u044C",
    "scorecard.loading": "\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u044E \u043E\u0446\u0435\u043D\u043A\u0443\u2026",
    "scorecard.loadFailed": "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u043E\u0446\u0435\u043D\u043A\u0443",
    "scorecard.noChecklist": "\u041D\u0435\u0442 \u043D\u0438 \u043E\u0434\u043D\u043E\u0433\u043E \u0447\u0435\u043A-\u043B\u0438\u0441\u0442\u0430",
    "scorecard.noChecklistNote": "\u0421\u043E\u0437\u0434\u0430\u0439\u0442\u0435 \u0447\u0435\u043A-\u043B\u0438\u0441\u0442 \u0432 \u0440\u0430\u0437\u0434\u0435\u043B\u0435 \xAB\u0427\u0435\u043A-\u043B\u0438\u0441\u0442\u044B\xBB.",
    "scorecard.empty": "\u0414\u0438\u0430\u043B\u043E\u0433 \u0435\u0449\u0451 \u043D\u0435 \u043E\u0446\u0435\u043D\u0451\u043D",
    "scorecard.emptyNote": "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0447\u0435\u043A-\u043B\u0438\u0441\u0442 \u0438 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \xAB\u041E\u0446\u0435\u043D\u0438\u0442\u044C\xBB.",
    "scorecard.demoBadge": "\u0434\u0435\u043C\u043E-\u043E\u0446\u0435\u043D\u043A\u0430",
    "scorecard.demoTitle": "\u041E\u0446\u0435\u043D\u043A\u0443 \u0441\u043E\u0441\u0442\u0430\u0432\u0438\u043B\u0430 \u0434\u0435\u043C\u043E\u043D\u0441\u0442\u0440\u0430\u0446\u0438\u043E\u043D\u043D\u0430\u044F \u043C\u043E\u0434\u0435\u043B\u044C, \u0430 \u043D\u0435 \u043D\u0430\u0441\u0442\u043E\u044F\u0449\u0430\u044F",
    "scorecard.totalLabel": "\u0418\u0442\u043E\u0433 \u043F\u043E \u0447\u0435\u043A-\u043B\u0438\u0441\u0442\u0443",
    "scorecard.totalNone": "\u043D\u0435 \u0440\u0430\u0441\u0441\u0447\u0438\u0442\u044B\u0432\u0430\u0435\u0442\u0441\u044F",
    "scorecard.outOf": "/ 100",
    "scorecard.originalTotal": "\u0431\u044B\u043B\u043E {total}",
    "scorecard.originalTitle": "\u0418\u0442\u043E\u0433 \u043F\u043E \u043E\u0442\u0432\u0435\u0442\u0430\u043C \u043C\u043E\u0434\u0435\u043B\u0438, \u0434\u043E \u0440\u0435\u0448\u0435\u043D\u0438\u0439 \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u044E\u0449\u0435\u0433\u043E",
    "scorecard.grossOn": "\u0433\u0440\u0443\u0431\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430",
    "scorecard.grossOnKinds": "\u0433\u0440\u0443\u0431\u0430\u044F \u043E\u0448\u0438\u0431\u043A\u0430: {kinds}",
    "scorecard.grossOff": "\u0433\u0440\u0443\u0431\u044B\u0445 \u043E\u0448\u0438\u0431\u043E\u043A \u043D\u0435\u0442",
    "scorecard.sections": "\u0418\u0442\u043E\u0433 \u043F\u043E \u0440\u0430\u0437\u0434\u0435\u043B\u0430\u043C",
    "scorecard.sectionScore": "{points} \u0438\u0437 {available} \xB7 {percent} %",
    "scorecard.sectionNone": "\u043D\u0435\u0442 \u043F\u0440\u0438\u043C\u0435\u043D\u0438\u043C\u044B\u0445 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0435\u0432",
    "scorecard.model": "\u041C\u043E\u0434\u0435\u043B\u044C: {model}",
    "scorecard.cost": "\u0441\u0442\u043E\u0438\u043C\u043E\u0441\u0442\u044C ${cost}",
    "scorecard.criteria": "\u041A\u0440\u0438\u0442\u0435\u0440\u0438\u0438",
    "scorecard.answer.yes": "\u0414\u0430",
    "scorecard.answer.no": "\u041D\u0435\u0442",
    "scorecard.answer.na": "N/A",
    "scorecard.answer.step": "\u0448\u0430\u0433 {value}",
    "scorecard.points": "{earned} \u0438\u0437 {max}",
    "scorecard.weight": "\u0432\u0435\u0441 {from} \u2192 {to}",
    "scorecard.naWeight": "\u0432\u0435\u0441 \u0440\u0430\u0441\u043F\u0440\u0435\u0434\u0435\u043B\u0451\u043D \u043F\u043E \u043E\u0441\u0442\u0430\u043B\u044C\u043D\u044B\u043C",
    "scorecard.grossNoScore": "\u043D\u0435 \u0432\u043B\u0438\u044F\u0435\u0442 \u043D\u0430 \u0438\u0442\u043E\u0433",
    "scorecard.modelAnswer": "\u043C\u043E\u0434\u0435\u043B\u044C: {answer}",
    "scorecard.modelAnswerTitle": "\u041E\u0442\u0432\u0435\u0442 \u043C\u043E\u0434\u0435\u043B\u0438 \u0434\u043E \u0440\u0435\u0448\u0435\u043D\u0438\u044F \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u044E\u0449\u0435\u0433\u043E",
    "scorecard.evidenceLine": "\u0440\u0435\u043F\u043B\u0438\u043A\u0430 {n}",
    "scorecard.evidenceShow": "\u041F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u0432 \u0434\u0438\u0430\u043B\u043E\u0433\u0435: \u0440\u0435\u043F\u043B\u0438\u043A\u0430 {n}",
    "scorecard.checkedRange": "\u041F\u0440\u043E\u0432\u0435\u0440\u0435\u043D\u043E: \u0440\u0435\u043F\u043B\u0438\u043A\u0438 {from}\u2013{to}",
    "scorecard.coaching": "\u0427\u0442\u043E \u0443\u043B\u0443\u0447\u0448\u0438\u0442\u044C",
    "scorecard.needsReview": "\u043F\u0440\u043E\u0432\u0435\u0440\u0438\u0442\u044C",
    "scorecard.needsReviewTitle": "\u041C\u043E\u0434\u0435\u043B\u044C \u043D\u0435 \u0443\u0432\u0435\u0440\u0435\u043D\u0430 \u0432 \u044D\u0442\u043E\u043C \u043E\u0442\u0432\u0435\u0442\u0435",
    "scorecard.carried": "\u0440\u0435\u0448\u0435\u043D\u0438\u0435 \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u044E\u0449\u0435\u0433\u043E \u043F\u0435\u0440\u0435\u043D\u0435\u0441\u0435\u043D\u043E",
    "scorecard.carriedTitle": "\u0420\u0435\u0448\u0435\u043D\u0438\u0435 \u043F\u043E \u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u0438 \u043A \u043F\u0440\u0435\u0436\u043D\u0435\u0439 \u043E\u0446\u0435\u043D\u043A\u0435 \u043F\u0435\u0440\u0435\u043D\u0435\u0441\u0435\u043D\u043E \u0441\u044E\u0434\u0430",
    "scorecard.dispute": "\u041E\u0441\u043F\u043E\u0440\u0438\u0442\u044C",
    "scorecard.disputeOpenTag": "\u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u044F \u043E\u0442\u043A\u0440\u044B\u0442\u0430",
    "scorecard.disputeEarlierTag": "\u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u044F \u043A \u043F\u0440\u0435\u0436\u043D\u0435\u0439 \u043E\u0446\u0435\u043D\u043A\u0435",
    "scorecard.disputeEarlierTitle": "\u0410\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u044F \u043F\u043E\u0434\u0430\u043D\u0430 \u043D\u0430 \u043F\u0440\u0435\u0436\u043D\u044E\u044E \u043E\u0446\u0435\u043D\u043A\u0443 \u044D\u0442\u043E\u0433\u043E \u0434\u0438\u0430\u043B\u043E\u0433\u0430 \u0438 \u0435\u0449\u0451 \u043D\u0435 \u0440\u0435\u0448\u0435\u043D\u0430",
    "scorecard.disputeOpenTitle": "\u041F\u043E \u044D\u0442\u043E\u043C\u0443 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044E \u0443\u0436\u0435 \u0435\u0441\u0442\u044C \u043E\u0442\u043A\u0440\u044B\u0442\u0430\u044F \u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u044F",
    "scorecard.info.title": "\u041D\u0435 \u0432\u043B\u0438\u044F\u0435\u0442 \u043D\u0430 \u043E\u0446\u0435\u043D\u043A\u0443",
    "scorecard.info.topic": "\u0422\u0435\u043C\u0430 \u043E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u044F",
    "scorecard.info.mood": "\u041D\u0430\u0441\u0442\u0440\u043E\u0435\u043D\u0438\u0435 \u043A\u043B\u0438\u0435\u043D\u0442\u0430",
    "scorecard.info.outcome": "\u0418\u0442\u043E\u0433 \u043E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u044F",
    "scorecard.info.firstReaction": "\u041F\u0435\u0440\u0432\u0430\u044F \u0440\u0435\u0430\u043A\u0446\u0438\u044F",
    "scorecard.info.longestWait": "\u0421\u0430\u043C\u043E\u0435 \u0434\u043E\u043B\u0433\u043E\u0435 \u043E\u0436\u0438\u0434\u0430\u043D\u0438\u0435",
    "scorecard.info.ending": "\u0417\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u0435",
    "scorecard.info.thresholdOk": "\u0432 \u043F\u0440\u0435\u0434\u0435\u043B\u0430\u0445 3 \u043C\u0438\u043D\u0443\u0442",
    "scorecard.info.thresholdOver": "\u0434\u043E\u043B\u044C\u0448\u0435 3 \u043C\u0438\u043D\u0443\u0442",
    "scorecard.info.unknown": "\u043D\u0435\u0442 \u0434\u0430\u043D\u043D\u044B\u0445",
    "scorecard.outcome.resolved": "\u0432\u043E\u043F\u0440\u043E\u0441 \u0440\u0435\u0448\u0451\u043D",
    "scorecard.outcome.passed_to_specialists": "\u043F\u0435\u0440\u0435\u0434\u0430\u043D \u0441\u043F\u0435\u0446\u0438\u0430\u043B\u0438\u0441\u0442\u0430\u043C",
    "scorecard.outcome.unresolved": "\u043D\u0435 \u0440\u0435\u0448\u0451\u043D",
    "scorecard.outcome.client_left": "\u043A\u043B\u0438\u0435\u043D\u0442 \u0443\u0448\u0451\u043B",
    "scorecard.ending.operator_closed": "\u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440 \u0437\u0430\u043A\u0440\u044B\u043B \u0434\u0438\u0430\u043B\u043E\u0433",
    "scorecard.ending.client_left": "\u043A\u043B\u0438\u0435\u043D\u0442 \u0443\u0448\u0451\u043B",
    "scorecard.ending.connection_lost": "\u043E\u0431\u0440\u044B\u0432 \u0441\u0432\u044F\u0437\u0438",
    "scorecard.ending.client_ended_call": "\u043A\u043B\u0438\u0435\u043D\u0442 \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u043B \u0437\u0432\u043E\u043D\u043E\u043A",
    "scorecard.ending.normal": "\u043E\u0431\u044B\u0447\u043D\u043E\u0435 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0438\u0435",
    "history.title": "\u0418\u0441\u0442\u043E\u0440\u0438\u044F \u043E\u0446\u0435\u043D\u043A\u0438",
    "history.original": "\u0418\u0441\u0445\u043E\u0434\u043D\u0430\u044F \u043E\u0446\u0435\u043D\u043A\u0430: {total}",
    "history.appeal": "\u0410\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u044F: \xAB{criterion}\xBB, \u043E\u0442\u0432\u0435\u0442 \u043C\u043E\u0434\u0435\u043B\u0438 \xAB{answer}\xBB",
    "history.changed": "\u0420\u0435\u0448\u0435\u043D\u0438\u0435: \u0438\u0437\u043C\u0435\u043D\u0435\u043D\u043E \u043D\u0430 \xAB{answer}\xBB",
    "history.confirmed": "\u0420\u0435\u0448\u0435\u043D\u0438\u0435: \u043E\u0446\u0435\u043D\u043A\u0430 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0430",
    "history.pending": "\u0416\u0434\u0451\u0442 \u0440\u0435\u0448\u0435\u043D\u0438\u044F \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u044E\u0449\u0435\u0433\u043E",
    "history.carried": "\u041F\u0435\u0440\u0435\u043D\u0435\u0441\u0435\u043D\u043E \u0440\u0435\u0448\u0435\u043D\u0438\u0435 \u043F\u043E \xAB{criterion}\xBB: \xAB{answer}\xBB",
    "history.final": "\u0418\u0442\u043E\u0433\u043E\u0432\u0430\u044F \u043E\u0446\u0435\u043D\u043A\u0430: {total}",
    "history.openAppeal": "\u043E\u0442\u043A\u0440\u044B\u0442\u044C \u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u044E",
    "history.earlierOpen": "\u0410\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u044F \u043A \u043F\u0440\u0435\u0436\u043D\u0435\u0439 \u043E\u0446\u0435\u043D\u043A\u0435: \xAB{criterion}\xBB, \u0436\u0434\u0451\u0442 \u0440\u0435\u0448\u0435\u043D\u0438\u044F",
    "history.decidedAfter": "\u0420\u0435\u0448\u0435\u043D\u0438\u0435 \u043F\u043E \xAB{criterion}\xBB \u043F\u0440\u0438\u043D\u044F\u0442\u043E \u043F\u043E\u0441\u043B\u0435 \u044D\u0442\u043E\u0439 \u043E\u0446\u0435\u043D\u043A\u0438: \u043F\u0435\u0440\u0435\u043E\u0446\u0435\u043D\u0438\u0442\u0435, \u0447\u0442\u043E\u0431\u044B \u043F\u0440\u0438\u043C\u0435\u043D\u0438\u0442\u044C",
    "history.olderVersion": "\u0420\u0435\u0448\u0435\u043D\u0438\u0435 \u043F\u043E \xAB{criterion}\xBB \u043E\u0442\u043D\u043E\u0441\u0438\u043B\u043E\u0441\u044C \u043A \u043F\u0440\u0435\u0436\u043D\u0435\u0439 \u0432\u0435\u0440\u0441\u0438\u0438 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044F",
    "appeal.title": "\u0410\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u044F",
    "appeal.criterion": "\u041A\u0440\u0438\u0442\u0435\u0440\u0438\u0439",
    "appeal.current": "\u0421\u0435\u0439\u0447\u0430\u0441: \xAB{answer}\xBB",
    "appeal.comment": "\u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439",
    "appeal.commentPlaceholder": "\u041F\u043E\u0447\u0435\u043C\u0443 \u043E\u0446\u0435\u043D\u043A\u0430 \u043D\u0435\u0432\u0435\u0440\u043D\u0430: \u0447\u0442\u043E \u0432 \u0434\u0438\u0430\u043B\u043E\u0433\u0435 \u044D\u0442\u043E \u043F\u043E\u043A\u0430\u0437\u044B\u0432\u0430\u0435\u0442",
    "appeal.note": "\u0420\u0435\u0448\u0435\u043D\u0438\u0435 \u043F\u0440\u0438\u043C\u0435\u0442 \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u044E\u0449\u0438\u0439; \u0438\u0442\u043E\u0433 \u043F\u0435\u0440\u0435\u0441\u0447\u0438\u0442\u0430\u0435\u0442\u0441\u044F \u043F\u043E\u0441\u043B\u0435 \u0440\u0435\u0448\u0435\u043D\u0438\u044F.",
    "appeal.submit": "\u041F\u043E\u0434\u0430\u0442\u044C \u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u044E",
    "appeal.cancel": "\u041E\u0442\u043C\u0435\u043D\u0430",
    "appeals.list": "\u0410\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u0438",
    "appeals.filters": "\u0424\u0438\u043B\u044C\u0442\u0440 \u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u0439",
    "appeals.filter.open": "\u041E\u0442\u043A\u0440\u044B\u0442\u044B\u0435",
    "appeals.filter.decided": "\u0420\u0435\u0448\u0451\u043D\u043D\u044B\u0435",
    "appeals.filter.all": "\u0412\u0441\u0435",
    "appeals.status.open": "\u043E\u0442\u043A\u0440\u044B\u0442\u0430",
    "appeals.status.decided": "\u0440\u0435\u0448\u0435\u043D\u0430",
    "appeals.loading": "\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u043C \u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u0438\u2026",
    "appeals.loadFailed": "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u0438",
    "appeals.retry": "\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u044C",
    "appeals.empty": "\u0410\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u0439 \u043F\u043E\u043A\u0430 \u043D\u0435\u0442",
    "appeals.emptyNote": "\u041A\u043E\u043D\u0442\u0440\u043E\u043B\u0451\u0440 \u043F\u043E\u0434\u0430\u0451\u0442 \u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u044E \u043A\u043D\u043E\u043F\u043A\u043E\u0439 \xAB\u041E\u0441\u043F\u043E\u0440\u0438\u0442\u044C\xBB \u043D\u0430 \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0435 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u044F.",
    "appeals.noMatch": "\u0417\u0434\u0435\u0441\u044C \u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u0439 \u043D\u0435\u0442",
    "appeals.pick": "\u0412\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u044E \u0432 \u0441\u043F\u0438\u0441\u043A\u0435",
    "appeals.back": "\u2190 \u0412\u0441\u0435 \u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u0438",
    "review.label": "\u0420\u0430\u0441\u0441\u043C\u043E\u0442\u0440\u0435\u043D\u0438\u0435 \u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u0438",
    "review.title": "\u0410\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u044F \xB7 {id}",
    "review.loading": "\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u043C \u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u044E\u2026",
    "review.loadFailed": "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0430\u043F\u0435\u043B\u043B\u044F\u0446\u0438\u044E",
    "review.retry": "\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u044C",
    "review.openCard": "\u041E\u0442\u043A\u0440\u044B\u0442\u044C \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0443 \u0434\u0438\u0430\u043B\u043E\u0433\u0430",
    "review.criterion": "\u041E\u0441\u043F\u043E\u0440\u0435\u043D\u043D\u044B\u0439 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0439",
    "review.comment": "\u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439 \u043A\u043E\u043D\u0442\u0440\u043E\u043B\u0451\u0440\u0430",
    "review.fragment": "\u0424\u0440\u0430\u0433\u043C\u0435\u043D\u0442 \u0434\u0438\u0430\u043B\u043E\u0433\u0430",
    "review.noFragment": "\u041C\u043E\u0434\u0435\u043B\u044C \u043D\u0435 \u0443\u043A\u0430\u0437\u0430\u043B\u0430 \u0441\u0442\u0440\u043E\u043A\u0438; \u043E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0443 \u0434\u0438\u0430\u043B\u043E\u0433\u0430.",
    "review.opinion": "\u0412\u0442\u043E\u0440\u043E\u0435 \u043C\u043D\u0435\u043D\u0438\u0435 \u043C\u043E\u0434\u0435\u043B\u0438",
    "review.opinionPending": "\u041C\u043E\u0434\u0435\u043B\u044C \u043F\u0435\u0440\u0435\u0447\u0438\u0442\u044B\u0432\u0430\u0435\u0442 \u043A\u0440\u0438\u0442\u0435\u0440\u0438\u0439 \u0441 \u0443\u0447\u0451\u0442\u043E\u043C \u043A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u044F\u2026",
    "review.opinionAnswer": "\u041C\u043E\u0434\u0435\u043B\u044C \u043F\u0440\u0435\u0434\u043B\u0430\u0433\u0430\u0435\u0442: \xAB{answer}\xBB",
    "review.opinionAdvice": "\u042D\u0442\u043E \u0441\u043E\u0432\u0435\u0442: \u0440\u0435\u0448\u0435\u043D\u0438\u0435 \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u0435\u0442 \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u044E\u0449\u0438\u0439.",
    "review.opinionUnavailable": "\u0412\u0442\u043E\u0440\u043E\u0435 \u043C\u043D\u0435\u043D\u0438\u0435 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E.",
    "review.decision": "\u0420\u0435\u0448\u0435\u043D\u0438\u0435",
    "review.readOnly": "\u0420\u0435\u0448\u0435\u043D\u0438\u0435 \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u0435\u0442 \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u044E\u0449\u0438\u0439. \u041F\u0435\u0440\u0435\u043A\u043B\u044E\u0447\u0438\u0442\u0435 \u0440\u043E\u043B\u044C, \u0447\u0442\u043E\u0431\u044B \u0440\u0435\u0448\u0438\u0442\u044C.",
    "review.confirmed": "\u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044C",
    "review.changed": "\u0418\u0437\u043C\u0435\u043D\u0438\u0442\u044C",
    "review.newAnswer": "\u041D\u043E\u0432\u044B\u0439 \u043E\u0442\u0432\u0435\u0442",
    "review.reason": "\u041F\u0440\u0438\u0447\u0438\u043D\u0430 \u0440\u0435\u0448\u0435\u043D\u0438\u044F",
    "review.reasonPlaceholder": "\u041E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u044C\u043D\u043E: \u043D\u0430 \u0447\u0451\u043C \u043E\u0441\u043D\u043E\u0432\u0430\u043D\u043E \u0440\u0435\u0448\u0435\u043D\u0438\u0435",
    "review.submit": "\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u0440\u0435\u0448\u0435\u043D\u0438\u0435",
    "review.decidedConfirmed": "\u041E\u0446\u0435\u043D\u043A\u0430 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0430",
    "review.decidedChanged": "\u041E\u0442\u0432\u0435\u0442 \u0438\u0437\u043C\u0435\u043D\u0451\u043D \u043D\u0430 \xAB{answer}\xBB",
    "review.result": "\u0418\u0442\u043E\u0433: {from} \u2192 {to}",
    "review.saved": "\u0420\u0435\u0448\u0435\u043D\u0438\u0435 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E.",
    "review.reloading": "\u041E\u0431\u043D\u043E\u0432\u043B\u044F\u044E \u0434\u0430\u043D\u043D\u044B\u0435 \u043F\u0430\u043D\u0435\u043B\u0438\u2026",
    "review.reloadFailed": "\u041F\u0430\u043D\u0435\u043B\u044C \u043D\u0435 \u043E\u0431\u043D\u043E\u0432\u0438\u043B\u0430\u0441\u044C, \u0440\u0435\u0448\u0435\u043D\u0438\u0435 \u0443\u0436\u0435 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u043E.",
    "review.reload": "\u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C",
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
  function pluralForm(n) {
    const abs = Math.abs(Math.trunc(Number(n)));
    const ten = abs % 10;
    const hundred = abs % 100;
    if (ten === 1 && hundred !== 11) return "one";
    if (ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14)) return "few";
    return "many";
  }
  function tp(base, n, params = {}) {
    return t(`${base}.${pluralForm(n)}`, { ...params, n });
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
  function h(tag4, props, ...children) {
    const el = document.createElement(tag4);
    if (props !== void 0 && props !== null) {
      if (typeof props !== "object" || props instanceof Node || Array.isArray(props)) {
        throw new TypeError("dom: h() props must be a plain object; pass children after it");
      }
      for (const key of Object.keys(props)) {
        if (!PROPS.has(key)) throw new TypeError(`dom: unknown prop "${key}"`);
      }
      const { class: className, text: text3, attrs, data, on, style } = props;
      if (className) el.className = Array.isArray(className) ? className.filter(Boolean).join(" ") : String(className);
      if (text3 !== void 0 && text3 !== null) el.textContent = String(text3);
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
  function svg(tag4, attrs, ...children) {
    const el = document.createElementNS(SVG_NS, tag4);
    if (attrs) setAttrs(el, attrs);
    append(el, children);
    return el;
  }
  function clear(el) {
    el.replaceChildren();
    return el;
  }

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
        const text3 = query2.toString();
        return text3 ? `#/compare?${text3}` : "#/compare";
      }
      case "analytics":
        return "#/analytics";
      case "accuracy":
        return "#/accuracy";
      default:
        throw new TypeError(`href: unknown route ${JSON.stringify(name)}`);
    }
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
    search: [
      ["circle", { cx: 11, cy: 11, r: 7 }],
      ["path", { d: "m16.5 16.5 4.5 4.5" }]
    ],
    chevron: [["path", { d: "m6 9 6 6 6-6" }]],
    list: [["path", { d: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" }]],
    close: [["path", { d: "M6 6l12 12M18 6 6 18" }]],
    check: [["path", { d: "m5 12.5 4.5 4.5L19 7.5" }]],
    download: [["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" }]],
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
      ...shapes.map(([tag4, attrs]) => svg(tag4, attrs))
    );
  }

  // src/ui/toast.js
  var MAX_TOASTS = 4;
  var INFO_MS = 5e3;
  var KINDS = ["error", "info"];
  var nextId = 1;
  function errorText(error) {
    const full = typeof error?.code === "string" ? error.code : "";
    const colon = full.indexOf(":");
    const code = colon < 0 ? full : full.slice(0, colon);
    const suffix = colon < 0 ? "" : full.slice(colon + 1);
    if (code === "bad_record" && /^\d+$/.test(suffix)) return t("error.bad_record_at", { n: Number(suffix) + 1 });
    const key = `error.${code}`;
    const text3 = code ? t(key) : key;
    return text3 === key ? t("error.generic") : text3;
  }
  function dismissToast(store, id) {
    const toasts = store.get().toasts ?? [];
    if (!toasts.some((entry) => entry.id === id)) return;
    store.set({ toasts: toasts.filter((entry) => entry.id !== id) });
  }
  function toast(store, { kind = "info", text: text3, retry } = {}) {
    if (!KINDS.includes(kind)) throw new TypeError(`toast: kind must be "error" or "info", got ${JSON.stringify(kind)}`);
    if (typeof text3 !== "string" || text3 === "") throw new TypeError("toast: text is required");
    const id = nextId++;
    const entry = { id, kind, text: text3, retry: typeof retry === "function" ? retry : null };
    const rest = (store.get().toasts ?? []).filter((old) => !(old.kind === kind && old.text === text3));
    store.set({ toasts: [...rest, entry].slice(-MAX_TOASTS) });
    if (kind === "info") {
      const timer = setTimeout(() => dismissToast(store, id), INFO_MS);
      timer.unref?.();
    }
    return id;
  }
  function toastError(store, error, { retry } = {}) {
    const canRetry = typeof retry === "function" && (error?.retryable ?? true) === true;
    return toast(store, { kind: "error", text: errorText(error), retry: canRetry ? retry : void 0 });
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

  // src/ui/appeal-drawer.js
  function openAppealDrawer({ host, store, api, evaluationId, choices, criterionId, onFiled, returnFocus }) {
    let closed = false;
    let busy = false;
    const current2 = h("p", { class: "cqa-ap-current", data: { test: "appeal-current" } });
    const select = h(
      "select",
      { class: ["cqa-sc-select", "cqa-ap-select"], attrs: { "aria-label": t("appeal.criterion") }, data: { test: "appeal-criterion" }, on: { change: () => paint() } },
      choices.map((choice) => h("option", { attrs: { value: choice.id }, text: choice.title }))
    );
    if (choices.some((choice) => choice.id === criterionId)) select.value = criterionId;
    const comment = h("textarea", {
      class: "cqa-ap-text",
      attrs: { rows: "5", "aria-label": t("appeal.comment"), placeholder: t("appeal.commentPlaceholder") },
      data: { test: "appeal-comment" },
      on: { input: () => paint() }
    });
    const submit = h("button", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { type: "submit" }, text: t("appeal.submit"), data: { test: "appeal-submit" } });
    const cancel = h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("appeal.cancel"), data: { test: "appeal-cancel" }, on: { click: () => close() } });
    function paint() {
      const choice = choices.find((c) => c.id === select.value);
      current2.textContent = choice ? t("appeal.current", { answer: choice.answer }) : "";
      submit.disabled = busy || comment.value.trim() === "";
      select.disabled = busy;
    }
    async function send() {
      const text3 = comment.value.trim();
      if (busy || closed || text3 === "") return;
      busy = true;
      paint();
      try {
        const appeal = await api.fileAppeal({ evaluation_id: evaluationId, criterion_id: select.value, comment: text3 });
        close();
        onFiled?.(appeal);
      } catch (error) {
        busy = false;
        if (!closed) paint();
        toastError(store, error, { retry: send });
      }
    }
    const panel = h(
      "aside",
      { class: "cqa-drawer", attrs: { role: "dialog", "aria-modal": "true", "aria-label": t("appeal.title") } },
      h("div", { class: "cqa-drawer-head" }, h("h2", { class: "cqa-drawer-title", text: t("appeal.title") })),
      h(
        "form",
        {
          class: "cqa-ap-form",
          on: {
            submit: (event) => {
              event.preventDefault();
              send();
            }
          }
        },
        h("label", { class: "cqa-rv-field" }, h("span", { class: "cqa-rv-label", text: t("appeal.criterion") }), select),
        current2,
        h("label", { class: "cqa-rv-field" }, h("span", { class: "cqa-rv-label", text: t("appeal.comment") }), comment),
        h("p", { class: "cqa-rv-hint", text: t("appeal.note") }),
        h("div", { class: "cqa-rv-acts" }, cancel, submit)
      )
    );
    const scrim = h("button", { class: "cqa-drawer-scrim", attrs: { type: "button", tabindex: "-1", "aria-label": t("appeal.cancel") }, on: { click: () => close() } });
    const el = h(
      "div",
      {
        class: "cqa-drawer-wrap",
        data: { test: "appeal-drawer" },
        on: {
          keydown: (event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }
        }
      },
      scrim,
      panel
    );
    function close() {
      if (closed) return;
      closed = true;
      el.remove();
      if (returnFocus && returnFocus.isConnected) returnFocus.focus();
    }
    paint();
    host.append(el);
    comment.focus();
    return { el, close };
  }

  // src/ui/scorecard.js
  var POLL_MS = 500;
  var JOB_TIMEOUT_MS = 15 * 60 * 1e3;
  var FIRST_REACTION_LIMIT_S = 180;
  var ACTIVE = /* @__PURE__ */ new Set(["queued", "running", "pending", "started"]);
  var EVIDENCE_QUOTE_MAX = 160;
  var money = (value) => fmt2(rat(value));
  var isStep2 = (answer) => answer !== null && typeof answer === "object" && Object.hasOwn(answer, "step");
  function answerTag(criterion, answer) {
    const gross = criterion?.kind === "gross_error";
    if (answer === "na") return { kind: "na", text: t("scorecard.answer.na") };
    if (answer === "yes") return { kind: gross ? "bad" : "ok", text: t("scorecard.answer.yes") };
    if (answer === "no") return { kind: gross ? "ok" : "bad", text: t("scorecard.answer.no") };
    if (isStep2(answer)) {
      const values = (criterion?.scale_steps ?? []).map((step) => step.value).filter((value) => typeof value === "number");
      const top = values.length > 0 ? Math.max(...values) : null;
      const low = values.length > 0 ? Math.min(...values) : null;
      const kind = top === null ? "mid" : answer.step >= top ? "ok" : answer.step <= low ? "bad" : "mid";
      return { kind, text: t("scorecard.answer.step", { value: answer.step }) };
    }
    return { kind: "na", text: "\u2014" };
  }
  function thresholdCheck(seconds) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
    return seconds <= FIRST_REACTION_LIMIT_S ? "ok" : "over";
  }
  function jobSettled(job) {
    if (!job) return true;
    return !ACTIVE.has(job.status) || job.total > 0 && job.done + job.failed >= job.total;
  }
  var byFiling = (a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
  function cardAppeals(evaluation, appeals, evaluations) {
    const created = Date.parse(evaluation.created_at ?? "");
    const earlier = new Set(
      (evaluations ?? []).filter((e) => e.id !== evaluation.id).filter((e) => {
        const at = Date.parse(e.created_at ?? "");
        return !Number.isFinite(at) || !Number.isFinite(created) || at <= created;
      }).map((e) => e.id)
    );
    const carried = new Set(evaluation.results.map((r) => r.carried_decision?.appeal_id).filter(Boolean));
    const own = [];
    const earlierOpen = [];
    const notCarried = [];
    for (const appeal of [...appeals ?? []].sort(byFiling)) {
      if (appeal.evaluation_id === evaluation.id) own.push(appeal);
      else if (!earlier.has(appeal.evaluation_id)) continue;
      else if (appeal.status === "open") earlierOpen.push(appeal);
      else if (!carried.has(appeal.id)) {
        const decided = Date.parse(appeal.decision?.decided_at ?? "");
        notCarried.push({ appeal, when: Number.isFinite(decided) && Number.isFinite(created) && decided > created ? "after" : "before" });
      }
    }
    return { own, earlierOpen, notCarried };
  }
  var versionsOf = (row) => Array.isArray(row.versions) && row.versions.length > 0 ? row.versions.map((v) => v.version) : [row.version];
  var latestOf = (row) => Math.max(...versionsOf(row));
  function pickSelection(stored, server, checklists) {
    const has2 = (ref) => Boolean(ref) && checklists.some((row2) => row2.checklist_id === ref.checklist_id && versionsOf(row2).includes(ref.version));
    if (has2(stored)) return { checklist_id: stored.checklist_id, version: stored.version };
    const fallback = server?.default_checklist;
    if (has2(fallback)) return { checklist_id: fallback.checklist_id, version: fallback.version };
    const row = checklists.find((r) => r.checklist_id === fallback?.checklist_id) ?? checklists[0];
    return row ? { checklist_id: row.checklist_id, version: latestOf(row) } : null;
  }
  function labelled(prefix, value) {
    const key = `${prefix}.${value}`;
    const text3 = t(key);
    return text3 === key ? String(value) : text3;
  }
  var clip = (text3, max) => {
    const line = String(text3 ?? "").trim().replace(/\s+/g, " ");
    return line.length > max ? `${line.slice(0, max - 1).trimEnd()}\u2026` : line;
  };
  var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  var tag = (kind, text3, props = {}) => h("span", { class: ["cqa-tag", `cqa-tag--${kind}`, props.class], text: text3, attrs: props.attrs, data: props.data });
  var tagLink = (kind, text3, appealId, { title, test } = {}) => h("a", { class: ["cqa-tag", `cqa-tag--${kind}`, "cqa-tag--link"], text: text3, attrs: { href: href("appeal", { id: appealId }), title: title ?? null }, data: { test } });
  function stateBox(test, title, note, extra) {
    return h("div", { class: "cqa-empty", attrs: { role: "status" }, data: { test } }, h("b", { class: "cqa-empty-title", text: title }), note ? h("p", { class: "cqa-empty-note", text: note }) : null, extra);
  }
  function openId(store, args) {
    if (typeof args?.id === "string" && args.id !== "") return args.id;
    const { route: route2, conversationId } = store.get();
    return route2?.name === "workspace" && route2.params?.id ? route2.params.id : conversationId ?? null;
  }
  function createScorecard(store, api, args = {}) {
    const id = openId(store, args);
    const dev = store.get().config?.testHooks === true || Boolean(window.__cqaTest);
    const view = {
      phase: "loading",
      // "loading" | "ready" | "error"
      error: null,
      server: null,
      // the API's config
      checklists: [],
      options: [],
      // [{checklist_id, version, label}] behind the picker
      sel: null,
      // {checklist_id, version}
      version: null,
      // the picked checklist version
      evaluation: null,
      // the newest finished evaluation of this dialogue for it
      evaluations: [],
      // all of this dialogue's evaluations for the picked checklist (for earlier appeals)
      conversation: null,
      appeals: [],
      busy: false,
      job: null,
      // null | {phase: "starting" | "running" | "failed", id, done, total}
      active: null
      // the criterion id whose evidence is marked in the transcript
    };
    let destroyed = false;
    let pendingSel = null;
    function followShared(ref) {
      pendingSel = null;
      if (destroyed || !ref || id === null) return;
      if (view.sel && view.sel.checklist_id === ref.checklist_id && view.sel.version === ref.version) return;
      if (view.busy) {
        pendingSel = ref;
        return;
      }
      if (!view.options.some((o) => o.checklist_id === ref.checklist_id && o.version === ref.version)) {
        boot();
        return;
      }
      view.sel = { checklist_id: ref.checklist_id, version: ref.version };
      fillSelect();
      loadSelection();
    }
    let loadRun = 0;
    let drawer = null;
    const unwatch = [];
    const select = h("select", {
      class: "cqa-sc-select",
      attrs: { "aria-label": t("scorecard.checklist") },
      data: { test: "checklist-select" },
      on: {
        change: () => {
          const option = view.options[Number(select.value)];
          if (!option || view.busy) return;
          view.sel = { checklist_id: option.checklist_id, version: option.version };
          store.set({ checklistSel: view.sel });
          loadSelection();
        }
      }
    });
    const runButton = h("button", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { type: "button" }, data: { test: "run-eval" }, on: { click: () => run("reuse") } });
    const fullButton = h("button", {
      class: "cqa-sc-btn",
      text: t("scorecard.runFull"),
      attrs: { type: "button", title: t("scorecard.runFullTitle") },
      data: { test: "run-eval-full" },
      on: { click: () => run("full") }
    });
    const status = h("div", { class: "cqa-sc-status", attrs: { role: "status", "aria-live": "polite" }, data: { test: "job-progress" } });
    const hint = h("p", { class: "cqa-sc-hint", text: t("scorecard.keyMissing"), data: { test: "key-hint" } });
    hint.hidden = true;
    const bar = h(
      "div",
      { class: "cqa-sc-bar" },
      h("label", { class: "cqa-sc-pick" }, h("span", { class: "cqa-sc-pick-label", text: t("scorecard.checklist") }), select),
      h("div", { class: "cqa-sc-run" }, runButton, fullButton),
      hint,
      status
    );
    const body = h("div", { class: "cqa-sc-body" });
    const el = h("div", { class: "cqa-sc", attrs: { role: "region", "aria-label": t("scorecard.label") }, data: { test: "scorecard" } }, bar, body);
    function fillSelect() {
      clear(select);
      view.options = view.checklists.flatMap(
        (row) => [...versionsOf(row)].sort((a, b) => b - a).map((version2) => ({ checklist_id: row.checklist_id, version: version2, label: t("scorecard.checklistOption", { name: row.name ?? row.checklist_id, version: version2 }) }))
      );
      view.options.forEach((option, index) => select.append(h("option", { text: option.label, attrs: { value: index } })));
      const at = view.options.findIndex((o) => o.checklist_id === view.sel?.checklist_id && o.version === view.sel?.version);
      if (at >= 0) select.value = String(at);
    }
    function paintBar() {
      if (destroyed) return;
      const keyMissing = view.server?.model_key_configured === false;
      const ready = view.phase === "ready" && view.sel !== null && view.version !== null;
      const off = view.busy || keyMissing || !ready;
      runButton.textContent = t(view.evaluation ? "scorecard.rerun" : "scorecard.run");
      for (const button of [runButton, fullButton]) {
        button.disabled = off;
        if (keyMissing) button.setAttribute("title", t("scorecard.keyMissing"));
        else if (button === fullButton) button.setAttribute("title", t("scorecard.runFullTitle"));
        else button.removeAttribute("title");
      }
      hint.hidden = !keyMissing;
      select.disabled = view.busy || view.options.length === 0;
      clear(status);
      const job = view.job;
      if (job?.phase === "starting") status.append(t("scorecard.starting"));
      else if (job?.phase === "running") status.append(t("scorecard.progress", { done: job.done, total: job.total }));
      else if (job?.phase === "failed") {
        status.append(
          h("span", { class: "cqa-sc-failed", text: t("scorecard.jobFailed") }),
          h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("scorecard.retry"), data: { test: "job-retry" }, on: { click: () => retryFailed(job.id) } })
        );
      }
    }
    const clearMarks = () => store.get().transcript?.highlight(null, [], null);
    const pickEvaluation2 = (evaluations, sel) => evaluations.find((e) => e.status === "done" && e.checklist_id === sel.checklist_id && e.version === sel.version) ?? null;
    async function boot() {
      const mine = ++loadRun;
      view.phase = "loading";
      drawBody();
      paintBar();
      try {
        const [server, checklists] = await Promise.all([api.getConfig(), api.listChecklists()]);
        if (destroyed || mine !== loadRun) return;
        view.server = server;
        view.checklists = checklists;
        view.sel = pickSelection(store.get().checklistSel, server, checklists);
        fillSelect();
        if (view.sel === null) {
          view.phase = "ready";
          drawBody();
          paintBar();
          return;
        }
        await loadSelection();
      } catch (error) {
        if (destroyed || mine !== loadRun) return;
        fail2(error);
      }
    }
    function fail2(error) {
      view.phase = "error";
      view.error = error;
      drawBody();
      paintBar();
    }
    async function loadSelection({ quiet = false } = {}) {
      const mine = ++loadRun;
      const sel = view.sel;
      if (!quiet) {
        view.phase = "loading";
        drawBody();
        paintBar();
      }
      try {
        const [version2, evaluations, appeals, conversation] = await Promise.all([
          api.getChecklistVersion(sel.checklist_id, sel.version),
          api.listEvaluations({ conversation: id, checklist_id: sel.checklist_id }),
          api.listAppeals(),
          api.getConversation(id)
        ]);
        if (destroyed || mine !== loadRun) return;
        view.version = version2;
        view.evaluation = pickEvaluation2(evaluations, sel);
        view.evaluations = evaluations;
        view.appeals = appeals;
        view.conversation = conversation;
        view.phase = "ready";
        view.active = null;
        clearMarks();
        checkTotal();
        drawBody();
        paintBar();
      } catch (error) {
        if (destroyed || mine !== loadRun) return;
        fail2(error);
      }
    }
    function checkTotal() {
      const { evaluation, version: version2, appeals } = view;
      if (!dev || !evaluation || !version2) return;
      try {
        const decided = appeals.filter((appeal) => appeal.status === "decided");
        const own = score(version2, finalAnswers(evaluation, decided)).total;
        if (own !== evaluation.final_total) console.warn(`scorecard: score() gives ${own}, the server says final_total ${evaluation.final_total} (${evaluation.id})`);
      } catch (error) {
        console.warn("scorecard: the total could not be recomputed", error);
      }
    }
    async function settle(first) {
      let job = first;
      const deadline = Date.now() + JOB_TIMEOUT_MS;
      while (!jobSettled(job)) {
        if (Date.now() > deadline) throw new ApiError("timeout", "The evaluation did not finish in time");
        await sleep(POLL_MS);
        job = await api.getJob(job.id);
        if (!destroyed) {
          view.job = { phase: "running", id: job.id, done: job.done, total: job.total };
          paintBar();
        }
      }
      return job;
    }
    async function execute(start, again) {
      if (view.busy || destroyed) return;
      view.busy = true;
      view.job = { phase: "starting" };
      paintBar();
      let jobId = null;
      try {
        const first = await start();
        jobId = first.id;
        if (!destroyed) {
          view.job = { phase: "running", id: first.id, done: first.done, total: first.total };
          paintBar();
        }
        const job = await settle(first);
        view.job = job.failed > 0 ? { phase: "failed", id: job.id, done: job.done, total: job.total } : null;
        store.set((state) => ({ queueRefresh: (state.queueRefresh ?? 0) + 1 }));
        if (!destroyed) await loadSelection({ quiet: true });
      } catch (error) {
        view.job = null;
        const resume = jobId === null ? again : () => execute(() => api.getJob(jobId), again);
        toastError(store, error, { retry: destroyed ? void 0 : resume });
      } finally {
        view.busy = false;
        paintBar();
        if (pendingSel) followShared(pendingSel);
      }
    }
    function run(mode) {
      if (!view.sel) return;
      const { checklist_id, version: version2 } = view.sel;
      const again = () => run(mode);
      return execute(() => api.startEvaluations({ conversations: [id], checklist_id, version: version2, mode }), again);
    }
    function retryFailed(jobId) {
      return execute(() => api.retryJob(jobId), () => retryFailed(jobId));
    }
    function drawBody() {
      if (destroyed) return;
      clear(body);
      if (view.phase === "loading") {
        body.append(stateBox("scorecard-loading", t("scorecard.loading")));
        return;
      }
      if (view.phase === "error") {
        body.append(
          stateBox(
            "scorecard-error",
            t("scorecard.loadFailed"),
            null,
            h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("scorecard.retry"), data: { test: "scorecard-retry" }, on: { click: boot } })
          )
        );
        return;
      }
      if (view.sel === null) {
        body.append(stateBox("scorecard-no-checklist", t("scorecard.noChecklist"), t("scorecard.noChecklistNote")));
        return;
      }
      const info = buildInfo(view.conversation);
      if (!view.evaluation) {
        body.append(stateBox("scorecard-empty", t("scorecard.empty"), t("scorecard.emptyNote")), info);
        return;
      }
      body.append(...[buildHero(view.evaluation, view.version), buildHistory(view.evaluation, view.version), info, buildCards(view.evaluation, view.version)].filter(Boolean));
    }
    function buildHistory(evaluation, version2) {
      const { own, earlierOpen, notCarried } = cardAppeals(evaluation, view.appeals, view.evaluations);
      const carried = evaluation.results.filter((result) => result.carried_decision);
      if (own.length === 0 && earlierOpen.length === 0 && notCarried.length === 0 && carried.length === 0) return null;
      const criterionOf = (id2) => version2.criteria.find((c) => c.id === id2) ?? { id: id2, title: id2 };
      const resultOf = (id2) => evaluation.results.find((r) => r.criterion_id === id2) ?? null;
      const totalText2 = (value) => value === null || value === void 0 ? t("scorecard.totalNone") : money(value);
      const items = [];
      const item = (kind, what, note, appealId) => items.push(
        h(
          "li",
          { class: ["cqa-sc-hist-item", `cqa-sc-hist-item--${kind}`], data: { test: "history-item", kind } },
          h("b", { class: "cqa-sc-hist-what", text: what }),
          appealId ? h("a", { class: ["cqa-link", "cqa-sc-hist-link"], attrs: { href: href("appeal", { id: appealId }) }, text: t("history.openAppeal") }) : null,
          note ? h("p", { class: "cqa-sc-hist-note", text: note }) : null
        )
      );
      item("original", t("history.original", { total: totalText2(evaluation.original_total) }));
      for (const appeal of own) {
        const criterion = criterionOf(appeal.criterion_id);
        const result = resultOf(appeal.criterion_id);
        item("appeal", t("history.appeal", { criterion: criterion.title, answer: result ? answerTag(criterion, result.answer).text : "\u2014" }), appeal.comment, appeal.id);
        const decision = appeal.decision;
        if (decision) {
          const what = decision.outcome === "changed" ? t("history.changed", { answer: answerTag(criterion, decision.answer).text }) : t("history.confirmed");
          item("decision", what, decision.reason);
        } else item("pending", t("history.pending"));
      }
      for (const appeal of earlierOpen) {
        item("earlier-open", t("history.earlierOpen", { criterion: criterionOf(appeal.criterion_id).title }), appeal.comment, appeal.id);
      }
      for (const { appeal, when } of notCarried) {
        item("not-carried", t(when === "after" ? "history.decidedAfter" : "history.olderVersion", { criterion: criterionOf(appeal.criterion_id).title }), appeal.decision?.reason, appeal.id);
      }
      for (const result of carried) {
        const criterion = criterionOf(result.criterion_id);
        item("carried", t("history.carried", { criterion: criterion.title, answer: answerTag(criterion, result.final_answer ?? result.answer).text }), null, result.carried_decision.appeal_id);
      }
      item("final", t("history.final", { total: totalText2(evaluation.final_total) }));
      return h(
        "section",
        { class: "cqa-sc-hist", attrs: { "aria-label": t("history.title") }, data: { test: "history" } },
        h("h3", { class: "cqa-sc-info-title", text: t("history.title") }),
        h("ol", { class: "cqa-sc-hist-list" }, items)
      );
    }
    function blockedCriteria(evaluation) {
      const { own, earlierOpen } = cardAppeals(evaluation, view.appeals, view.evaluations);
      return new Set([...own.filter((a) => a.status === "open"), ...earlierOpen].map((a) => a.criterion_id));
    }
    function openDrawer(criterionId, button) {
      const { evaluation, version: version2 } = view;
      if (!evaluation || !version2 || destroyed) return;
      const open = blockedCriteria(evaluation);
      const byResult = new Map(evaluation.results.map((r) => [r.criterion_id, r]));
      const sections = new Map(version2.sections.map((s) => [s.id, s.order ?? 0]));
      const choices = [...version2.criteria].sort((a, b) => (sections.get(a.section_id) ?? 0) - (sections.get(b.section_id) ?? 0) || (a.order ?? 0) - (b.order ?? 0)).filter((c) => byResult.has(c.id) && !open.has(c.id)).map((c) => {
        const result = byResult.get(c.id);
        return { id: c.id, title: c.title, answer: answerTag(c, result.final_answer ?? result.answer).text };
      });
      drawer?.close();
      drawer = openAppealDrawer({
        host: el.closest(".cqa") ?? el,
        store,
        api,
        evaluationId: evaluation.id,
        choices,
        criterionId,
        returnFocus: button,
        onFiled: () => {
          drawer = null;
          store.set((state) => ({ queueRefresh: (state.queueRefresh ?? 0) + 1 }));
          if (!destroyed) loadSelection({ quiet: true });
        }
      });
    }
    function buildHero(evaluation, version2) {
      const none = evaluation.final_total === null || evaluation.final_total === void 0;
      const totalText2 = none ? t("scorecard.totalNone") : money(evaluation.final_total);
      const changed = evaluation.original_total !== evaluation.final_total;
      const gross = evaluation.gross_error;
      const grossText = gross?.flag ? gross.kinds?.length > 0 ? t("scorecard.grossOnKinds", { kinds: gross.kinds.join(", ") }) : t("scorecard.grossOn") : t("scorecard.grossOff");
      const scored = new Set(version2.criteria.filter((c) => c.kind !== "gross_error").map((c) => c.section_id));
      const rows = [...version2.sections].sort((a, b) => a.order - b.order).filter((section) => scored.has(section.id)).map((section) => {
        const row = evaluation.sections?.find((s) => s.section_id === section.id);
        const has2 = row && row.points !== null && row.points !== void 0 && row.available !== null && row.available !== void 0;
        const percent = has2 && typeof row.percent === "number" ? Math.max(0, Math.min(100, row.percent)) : 0;
        return h(
          "div",
          { class: "cqa-sc-sec", data: { test: "section", section: section.id } },
          h("span", { class: "cqa-sc-sec-name", text: section.title }),
          h("span", {
            class: ["cqa-sc-sec-score", "num"],
            text: has2 ? t("scorecard.sectionScore", { points: money(row.points), available: money(row.available), percent: money(row.percent ?? 0) }) : t("scorecard.sectionNone"),
            data: { test: "section-score" }
          }),
          h("div", { class: "cqa-sc-sec-bar" }, h("i", { style: { width: `${percent}%` } }))
        );
      });
      const model = [evaluation.model ? t("scorecard.model", { model: evaluation.model }) : null, typeof evaluation.cost_usd === "number" ? t("scorecard.cost", { cost: evaluation.cost_usd.toFixed(evaluation.cost_usd < 1 ? 4 : 2) }) : null].filter(Boolean);
      return h(
        "div",
        { class: "cqa-sc-hero", data: { test: "hero" } },
        h(
          "div",
          { class: "cqa-sc-hero-top" },
          h("span", { class: "cqa-sc-hero-label" }, `${t("scorecard.totalLabel")} `, h("em", { text: `${version2.name} v${version2.version}` })),
          evaluation.source === "mock" ? h("span", { class: "cqa-sc-demo", text: t("scorecard.demoBadge"), attrs: { title: t("scorecard.demoTitle") }, data: { test: "demo-badge" } }) : null
        ),
        h(
          "div",
          { class: "cqa-sc-tot" },
          h("b", { class: ["cqa-sc-total", "num", none && "cqa-sc-total--none"], text: totalText2, data: { test: "total" } }),
          none ? null : h("span", { class: "cqa-sc-outof", text: t("scorecard.outOf") }),
          changed ? h("s", {
            class: ["cqa-sc-was", "num"],
            text: evaluation.original_total === null || evaluation.original_total === void 0 ? t("scorecard.totalNone") : money(evaluation.original_total),
            attrs: { title: t("scorecard.originalTitle") },
            data: { test: "total-original" }
          }) : null
        ),
        h("div", { class: ["cqa-sc-flag", gross?.flag && "cqa-sc-flag--on"], text: grossText, data: { test: "gross-flag", state: gross?.flag ? "on" : "off" } }),
        rows.length > 0 ? h("div", { class: "cqa-sc-secs", attrs: { role: "group", "aria-label": t("scorecard.sections") }, data: { test: "sections" } }, rows) : null,
        model.length > 0 ? h("p", { class: "cqa-sc-model", text: model.join(" \xB7 "), data: { test: "model" } }) : null
      );
    }
    function buildInfo(conversation) {
      const info = conversation?.info ?? null;
      const facts = conversation?.facts ?? null;
      const rows = [];
      const row = (key, test, ...value) => rows.push(h("div", { class: "cqa-sc-info-row", data: { test } }, h("dt", { text: t(`scorecard.info.${key}`) }), h("dd", {}, ...value)));
      if (info?.topic) row("topic", "info-topic", info.topic);
      const mood = [info?.mood_start, info?.mood_end].filter(Boolean);
      if (mood.length > 0) row("mood", "info-mood", mood.join(" \u2192 "));
      if (info?.outcome) row("outcome", "info-outcome", labelled("scorecard.outcome", info.outcome));
      if (facts && typeof facts.first_reaction_seconds === "number") {
        const check = thresholdCheck(facts.first_reaction_seconds);
        row(
          "firstReaction",
          "info-first-reaction",
          formatOffset(facts.first_reaction_seconds),
          " ",
          tag(check === "ok" ? "ok" : "bad", t(check === "ok" ? "scorecard.info.thresholdOk" : "scorecard.info.thresholdOver"), { data: { test: "threshold", state: check } })
        );
      }
      if (facts && typeof facts.longest_wait_seconds === "number") row("longestWait", "info-longest-wait", formatOffset(facts.longest_wait_seconds));
      if (facts?.ending) row("ending", "info-ending", labelled("scorecard.ending", facts.ending));
      const box = h("section", { class: "cqa-sc-info", attrs: { "aria-label": t("scorecard.info.title") }, data: { test: "info" } }, h("h3", { class: "cqa-sc-info-title", text: t("scorecard.info.title") }), h("dl", { class: "cqa-sc-info-list" }, rows));
      box.hidden = rows.length === 0;
      return box;
    }
    function buildCards(evaluation, version2) {
      const byResult = new Map(evaluation.results.map((r) => [r.criterion_id, r]));
      const sections = [...version2.sections].sort((a, b) => a.order - b.order);
      const groups = sections.map((section) => ({ section, criteria: version2.criteria.filter((c) => c.section_id === section.id).sort((a, b) => a.order - b.order) })).filter((group) => group.criteria.length > 0);
      const controller = store.get().role === "controller";
      const cards = /* @__PURE__ */ new Map();
      const activate = (criterionId) => {
        view.active = criterionId;
        for (const [key, card] of cards) card.classList.toggle("is-open", key === criterionId);
      };
      const list = h("div", { class: "cqa-sc-crits", data: { test: "criteria" } });
      for (const { section, criteria } of groups) {
        const items = criteria.filter((c) => byResult.has(c.id)).map((c) => {
          const card = buildCard(c, byResult.get(c.id), { evaluation, controller, activate });
          cards.set(c.id, card);
          return card;
        });
        if (items.length === 0) continue;
        list.append(h("h3", { class: "cqa-sc-sec-title", text: section.title }), ...items);
      }
      if (view.active && cards.has(view.active)) cards.get(view.active).classList.add("is-open");
      return list;
    }
    function buildCard(criterion, result, { evaluation, controller, activate }) {
      const gross = criterion.kind === "gross_error";
      const shown = result.final_answer ?? result.answer;
      const answer = answerTag(criterion, shown);
      const changed = JSON.stringify(result.answer) !== JSON.stringify(shown);
      let points = "";
      let weight = null;
      if (gross) points = t("scorecard.grossNoScore");
      else if (shown === "na") points = t("scorecard.naWeight");
      else if (typeof result.points === "number" && typeof result.effective_weight === "number") {
        points = t("scorecard.points", { earned: money(result.points), max: money(result.effective_weight) });
        if (typeof criterion.weight === "number" && money(criterion.weight) !== money(result.effective_weight)) {
          weight = t("scorecard.weight", { from: String(criterion.weight), to: money(result.effective_weight) });
        }
      } else points = "\u2014";
      const { own, earlierOpen } = cardAppeals(evaluation, view.appeals, view.evaluations);
      const ownOpen = own.find((a) => a.status === "open" && a.criterion_id === criterion.id) ?? null;
      const earlier = earlierOpen.find((a) => a.criterion_id === criterion.id) ?? null;
      const openAppeal = blockedCriteria(evaluation).has(criterion.id);
      const evidence = (result.evidence ?? []).map((item) => {
        const expected = item.role === "expected_here";
        return h(
          "li",
          { class: "cqa-sc-ev-item" },
          h(
            "button",
            {
              class: ["cqa-sc-ev", expected && "cqa-sc-ev--expected"],
              attrs: { type: "button", title: item.quote, "aria-label": t("scorecard.evidenceShow", { n: item.message_index + 1 }) },
              data: { test: "evidence-link", index: item.message_index, role: item.role },
              on: { click: () => jump(criterion, result, item, activate) }
            },
            h("span", { class: "cqa-sc-ev-n", text: `\u21B3 ${t("scorecard.evidenceLine", { n: item.message_index + 1 })}${expected ? ` \xB7 ${t("transcript.expectedHere")}` : ""}` }),
            item.quote ? h("span", { class: "cqa-sc-ev-quote", text: clip(item.quote, EVIDENCE_QUOTE_MAX) }) : null
          )
        );
      });
      const range = result.checked_range;
      const marks = [
        result.needs_review ? tag("mid", t("scorecard.needsReview"), { attrs: { title: t("scorecard.needsReviewTitle") }, data: { test: "needs-review" } }) : null,
        result.carried_decision?.appeal_id ? tagLink("out", t("scorecard.carried"), result.carried_decision.appeal_id, { title: t("scorecard.carriedTitle"), test: "carried" }) : null,
        ownOpen ? tagLink("mid", t("scorecard.disputeOpenTag"), ownOpen.id, { test: "appeal-open" }) : null,
        !ownOpen && earlier ? tagLink("mid", t("scorecard.disputeEarlierTag"), earlier.id, { title: t("scorecard.disputeEarlierTitle"), test: "appeal-open-earlier" }) : null,
        changed ? h("span", { class: "cqa-sc-note", text: t("scorecard.modelAnswer", { answer: answerTag(criterion, result.answer).text }), attrs: { title: t("scorecard.modelAnswerTitle") }, data: { test: "model-answer" } }) : null,
        weight ? h("span", { class: ["cqa-sc-note", "num"], text: weight, data: { test: "weight" } }) : null
      ].filter(Boolean);
      return h(
        "article",
        { class: "cqa-sc-crit", data: { test: "crit", criterion: criterion.id, answer: typeof shown === "string" ? shown : "step" } },
        h(
          "div",
          { class: "cqa-sc-r1" },
          h("b", { class: "cqa-sc-crit-title", text: criterion.title }),
          tag(answer.kind, answer.text, { data: { test: "answer" } }),
          h("span", { class: ["cqa-sc-pts", "num"], text: points, data: { test: "points" } })
        ),
        marks.length > 0 ? h("div", { class: "cqa-sc-marks" }, marks) : null,
        result.explanation ? h("p", { class: "cqa-sc-why", text: result.explanation, data: { test: "why" } }) : null,
        shown === "na" && result.na_reason ? h("p", { class: "cqa-sc-na", text: result.na_reason, data: { test: "na-reason" } }) : null,
        evidence.length > 0 ? h("ul", { class: "cqa-sc-evs" }, evidence) : null,
        range && Number.isInteger(range.from) && Number.isInteger(range.to) ? h("p", { class: ["cqa-sc-range", "num"], text: t("scorecard.checkedRange", { from: Math.min(range.from, range.to) + 1, to: Math.max(range.from, range.to) + 1 }), data: { test: "checked-range" } }) : null,
        result.coaching ? h("div", { class: "cqa-sc-coach", data: { test: "coaching" } }, h("b", { class: "cqa-sc-coach-label", text: t("scorecard.coaching") }), h("p", { class: "cqa-sc-coach-text", text: result.coaching })) : null,
        controller ? h(
          "div",
          { class: "cqa-sc-acts" },
          h("button", {
            class: "cqa-sc-btn",
            text: t("scorecard.dispute"),
            attrs: { type: "button", disabled: openAppeal, title: openAppeal ? t("scorecard.disputeOpenTitle") : null },
            data: { test: "dispute" },
            on: { click: (event) => openDrawer(criterion.id, event.currentTarget) }
          })
        ) : null
      );
    }
    function jump(criterion, result, item, activate) {
      const transcript = store.get().transcript;
      activate(criterion.id);
      if (!transcript) return;
      store.set({ pane: "transcript" });
      transcript.highlight(criterion.id, result.evidence, result.checked_range, criterion.title);
      transcript.focusMessage(item.message_index);
    }
    unwatch.push(
      watch(store, (state) => state.queueRefresh, () => {
        if (!view.busy && view.phase === "ready" && view.sel) loadSelection({ quiet: true });
      })
    );
    unwatch.push(watch(store, (state) => state.checklistSel, (ref) => followShared(ref)));
    unwatch.push(store.subscribe((state, previous) => {
      if (state.role === previous.role) return;
      if (state.role !== "controller") drawer?.close();
      if (view.phase === "ready") drawBody();
    }));
    if (id === null) body.append(stateBox("scorecard-empty", t("workspace.pick")));
    else boot();
    return {
      el,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        drawer?.close();
        unwatch.forEach((stop) => stop());
      }
    };
  }

  // src/ui/job-runner.js
  var POLL_MS2 = 500;
  var sleep2 = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function followJob(api, first, onTick, { pollMs = POLL_MS2 } = {}) {
    let job = first;
    onTick(job, !jobSettled(job));
    while (!jobSettled(job)) {
      await sleep2(pollMs);
      job = await api.getJob(job.id);
      onTick(job, !jobSettled(job));
    }
    return job;
  }
  var snapshot = (job, running) => ({ id: job.id, done: job.done ?? 0, total: job.total ?? 0, failed: job.failed ?? 0, running });
  function jobSlot(store, api, key, { pollMs = POLL_MS2 } = {}) {
    const state = () => store.get().jobs?.[key] ?? null;
    const put = (patch) => store.set((current2) => {
      const jobs = { ...current2.jobs ?? {} };
      if (patch === null) delete jobs[key];
      else jobs[key] = { lock: null, job: null, meta: null, ...jobs[key], ...patch };
      return { jobs };
    });
    const busy = () => (state()?.lock ?? null) !== null;
    async function follow(first) {
      put({ lock: "watching", job: snapshot(first, !jobSettled(first)) });
      try {
        const job = await followJob(api, first, (tick, running) => put({ job: snapshot(tick, running) }), { pollMs });
        put({ lock: null, job: snapshot(job, false) });
        store.set((current2) => ({ queueRefresh: (current2.queueRefresh ?? 0) + 1 }));
        return job;
      } catch (error) {
        put({ lock: "interrupted" });
        toastError(store, error, { retry: resume });
        return null;
      }
    }
    async function resume() {
      const slot = state();
      const id = slot?.job?.id;
      if (!id || slot.lock !== "interrupted") return null;
      put({ lock: "resuming" });
      let job;
      try {
        job = await api.getJob(id);
      } catch (error) {
        const gone = error?.code === "not_found";
        put(gone ? { lock: null, job: null } : { lock: "interrupted" });
        toastError(store, error, { retry: gone ? void 0 : resume });
        return null;
      }
      return follow(job);
    }
    async function start(request, { again, meta } = {}) {
      if (busy()) return null;
      put(meta === void 0 ? { lock: "starting" } : { lock: "starting", meta });
      let first;
      try {
        first = await request();
      } catch (error) {
        put({ lock: null });
        toastError(store, error, { retry: again });
        return null;
      }
      return follow(first);
    }
    function retry() {
      const id = state()?.job?.id;
      if (busy() || !id) return Promise.resolve(null);
      return start(() => api.retryJob(id), { again: retry });
    }
    function reset() {
      if (!busy() && state() !== null) put(null);
    }
    return { state, busy, start, resume, retry, reset, watch: (fn) => watch(store, (current2) => current2.jobs?.[key] ?? null, fn) };
  }

  // src/ui/loader.js
  var ESTIMATE_DELAY_MS = 250;
  var BATCH_SLOT = "batch";
  function uploadErrorText(code) {
    const match = /^bad_record:(\d+)$/.exec(String(code ?? ""));
    if (match) return t("loader.error.bad_record", { n: Number(match[1]) + 1 });
    if (code === "not_json" || code === "no_records") return t(`loader.error.${code}`);
    return t("loader.error.read");
  }
  function estimateText(dry) {
    return t("batch.estimate", { dialogs: tp("batch.dialogs", dry.total), calls: tp("batch.calls", dry.model_calls), cached: dry.reused });
  }
  var summaryText = (summary) => t("loader.summary", { total: summary.total, imported: summary.imported, updated: summary.updated, unchanged: summary.unchanged });
  function readText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsText(file);
    });
  }
  function openLoader({ host, store, api, onImported, group = "" }) {
    let closed = false;
    let busy = false;
    const status = h("p", { class: "cqa-ld-status", attrs: { role: "status", "aria-live": "polite" } });
    const result = h("div", { class: "cqa-ld-result" });
    const groupInput = h("input", {
      class: "cqa-sc-select",
      attrs: { type: "text", autocomplete: "off", spellcheck: "false", placeholder: t("loader.groupPlaceholder"), "aria-label": t("loader.group") },
      data: { test: "group-id" },
      on: { input: () => paint() }
    });
    groupInput.value = typeof group === "string" ? group : "";
    const importButton = h("button", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { type: "submit" }, text: t("loader.import"), data: { test: "import-group" } });
    const fileInput = h("input", {
      class: "cqa-ld-file",
      attrs: { type: "file", accept: ".json,application/json", "aria-label": t("loader.file") },
      data: { test: "upload-file" },
      on: { change: () => upload() }
    });
    const closeButton = h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("loader.close"), data: { test: "loader-close" }, on: { click: () => close() } });
    function paint() {
      importButton.disabled = busy || groupInput.value.trim() === "";
      groupInput.disabled = busy;
      fileInput.disabled = busy;
    }
    function showError(text3) {
      clear(result).append(h("p", { class: "cqa-ld-error", attrs: { role: "alert" }, text: text3, data: { test: "loader-error" } }));
    }
    function showSummary(summary) {
      clear(result).append(
        h("p", { class: "cqa-ld-summary", text: summaryText(summary), data: { test: "import-summary" } }),
        summary.group_id ? h("p", { class: "cqa-rv-hint", text: t("loader.summaryGroup", { group: summary.group_id }), data: { test: "import-group-name" } }) : null
      );
    }
    async function run(label, action) {
      if (busy || closed) return;
      busy = true;
      status.textContent = label;
      paint();
      try {
        const summary = await action();
        if (summary) {
          if (!closed) showSummary(summary);
          onImported?.(summary);
        }
      } catch (error) {
        if (!closed) showError(error instanceof UploadError ? uploadErrorText(error.code) : errorText(error));
      } finally {
        busy = false;
        status.textContent = "";
        if (!closed) paint();
      }
    }
    function importGroup() {
      const group2 = groupInput.value.trim();
      if (group2 === "") return;
      run(t("loader.importing", { group: group2 }), () => api.importDataset(group2));
    }
    function upload() {
      const file = fileInput.files?.[0];
      if (!file) return;
      run(t("loader.uploading", { name: file.name }), async () => {
        try {
          const text3 = await readText(file);
          parseUpload(text3);
          return await api.uploadConversations(JSON.parse(text3.replace(/^﻿/, "")));
        } finally {
          fileInput.value = "";
        }
      });
    }
    const panel = h(
      "aside",
      { class: "cqa-drawer", attrs: { role: "dialog", "aria-modal": "true", "aria-label": t("loader.title") } },
      h("div", { class: "cqa-drawer-head" }, h("h2", { class: "cqa-drawer-title", text: t("loader.title") })),
      h(
        "form",
        {
          class: "cqa-ap-form",
          on: {
            submit: (event) => {
              event.preventDefault();
              importGroup();
            }
          }
        },
        h("label", { class: "cqa-rv-field" }, h("span", { class: "cqa-rv-label", text: t("loader.group") }), groupInput),
        h("p", { class: "cqa-rv-hint", text: t("loader.groupHint") }),
        h("div", { class: "cqa-rv-acts" }, importButton)
      ),
      h(
        "div",
        { class: "cqa-ap-form" },
        h("label", { class: "cqa-rv-field" }, h("span", { class: "cqa-rv-label", text: t("loader.file") }), fileInput),
        h("p", { class: "cqa-rv-hint", text: t("loader.fileHint") })
      ),
      status,
      result,
      h("div", { class: "cqa-rv-acts" }, closeButton)
    );
    const scrim = h("button", { class: "cqa-drawer-scrim", attrs: { type: "button", tabindex: "-1", "aria-label": t("loader.close") }, on: { click: () => close() } });
    const el = h(
      "div",
      {
        class: "cqa-drawer-wrap",
        data: { test: "loader" },
        on: {
          keydown: (event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }
        }
      },
      scrim,
      panel
    );
    function close() {
      if (closed) return;
      closed = true;
      el.remove();
    }
    paint();
    host.append(el);
    groupInput.focus();
    return { el, close };
  }
  function openImport(store, api, host, { group } = {}) {
    return openLoader({
      host,
      store,
      api,
      group,
      onImported: (summary) => {
        const imported = summary?.group_id;
        store.set((state) => ({
          ...imported ? { groupId: imported, queueGroup: imported } : {},
          queueRefresh: (state.queueRefresh ?? 0) + 1,
          importRefresh: (state.importRefresh ?? 0) + 1
          // the open dialogue may have new lines or a recording
        }));
      }
    });
  }
  var versionsOf2 = (row) => Array.isArray(row.versions) && row.versions.length > 0 ? row.versions.map((v) => v.version) : [row.version];
  function createBatchBar(store, api) {
    const view = {
      ready: false,
      // config and checklists loaded
      server: null,
      options: [],
      // [{checklist_id, version, label}]
      estimate: null,
      // the dry-run answer for the current selection and checklist
      estimating: false
    };
    const slot = jobSlot(store, api, BATCH_SLOT);
    const busy = () => slot.busy();
    let destroyed = false;
    let estimateTimer = null;
    let estimateRun = 0;
    let booting = null;
    const stops = [];
    const host = h("div", { class: "cqa-batch-host" });
    const count = h("b", { class: "cqa-batch-count" });
    const select = h("select", {
      class: "cqa-sc-select",
      attrs: { "aria-label": t("batch.checklist") },
      data: { test: "batch-checklist" },
      on: {
        change: () => {
          const option = view.options[Number(select.value)];
          if (!option) return;
          store.set({ checklistSel: { checklist_id: option.checklist_id, version: option.version } });
        }
      }
    });
    const estimate = h("p", { class: "cqa-batch-estimate", attrs: { "aria-live": "polite" }, data: { test: "batch-estimate" } });
    const runButton = h("button", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { type: "button" }, text: t("batch.run"), data: { test: "batch-run" }, on: { click: () => runBatch() } });
    const hint = h("p", { class: "cqa-sc-hint", text: t("batch.keyMissing"), data: { test: "batch-key-hint" } });
    const progress = h("div", { class: "cqa-sc-status", attrs: { role: "status", "aria-live": "polite" }, data: { test: "batch-progress" } });
    const bar = h(
      "section",
      { class: "cqa-batch", attrs: { "aria-label": t("batch.label") }, data: { test: "batch-bar" } },
      h(
        "div",
        { class: "cqa-batch-row" },
        count,
        h("button", { class: ["cqa-link", "cqa-batch-clear"], attrs: { type: "button" }, text: t("batch.clear"), data: { test: "batch-clear" }, on: { click: () => store.set({ selection: /* @__PURE__ */ new Set() }) } })
      ),
      h("label", { class: "cqa-rv-field" }, h("span", { class: "cqa-rv-label", text: t("batch.checklist") }), select),
      estimate,
      hint,
      h("div", { class: "cqa-batch-row" }, runButton),
      progress
    );
    let checklists = [];
    const selection = () => store.get().selection ?? /* @__PURE__ */ new Set();
    const current2 = () => pickSelection(store.get().checklistSel, view.server, checklists);
    function paint() {
      if (destroyed) return;
      const picked = selection();
      const active = busy();
      const show = picked.size > 0 || active;
      if (!show) {
        host.replaceChildren();
        return;
      }
      if (!bar.isConnected) host.replaceChildren(bar);
      count.textContent = t("batch.selected", { n: picked.size });
      const sel = current2();
      const at = view.options.findIndex((o) => o.checklist_id === sel?.checklist_id && o.version === sel?.version);
      if (at >= 0) select.value = String(at);
      select.disabled = active || view.options.length === 0;
      if (view.estimate) estimate.textContent = estimateText(view.estimate);
      else estimate.textContent = view.estimating || !view.ready ? t("batch.estimating") : "";
      const keyMissing = view.server?.model_key_configured === false && (view.estimate?.model_calls ?? 0) > 0;
      hint.hidden = !keyMissing;
      runButton.disabled = active || picked.size === 0 || !view.estimate || view.estimating || keyMissing || sel === null;
      clear(progress);
      const { lock = null, job = null } = slot.state() ?? {};
      if (lock === "starting") progress.append(t("batch.starting"));
      else if (job && (lock === "interrupted" || lock === "resuming")) {
        progress.append(
          h("span", { class: "cqa-sc-failed", text: t("batch.interrupted", { done: job.done, total: job.total }) }),
          h("button", { class: "cqa-sc-btn", attrs: { type: "button", disabled: lock === "resuming" }, text: t("batch.resume"), data: { test: "batch-resume" }, on: { click: () => slot.resume() } })
        );
      } else if (job) {
        const running = lock === "watching";
        progress.append(t(running ? "batch.progress" : "batch.done", { done: job.done, total: job.total }));
        if (job.failed > 0) {
          progress.append(
            h("span", { class: "cqa-sc-failed", text: t("batch.failed", { n: job.failed }) }),
            running ? "" : h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("batch.retry"), data: { test: "batch-retry" }, on: { click: () => slot.retry() } })
          );
        }
      }
    }
    function boot() {
      booting ?? (booting = Promise.all([api.getConfig(), api.listChecklists()]).then(
        ([server, rows]) => {
          if (destroyed) return;
          view.server = server;
          checklists = rows;
          view.options = rows.flatMap(
            (row) => [...versionsOf2(row)].sort((a, b) => b - a).map((version2) => ({ checklist_id: row.checklist_id, version: version2, label: t("scorecard.checklistOption", { name: row.name ?? row.checklist_id, version: version2 }) }))
          );
          clear(select);
          view.options.forEach((option, index) => select.append(h("option", { text: option.label, attrs: { value: index } })));
          view.ready = true;
          scheduleEstimate();
        },
        (error) => {
          booting = null;
          if (!destroyed) toastError(store, error);
        }
      ));
      return booting;
    }
    function scheduleEstimate() {
      clearTimeout(estimateTimer);
      estimateRun += 1;
      view.estimate = null;
      const picked = [...selection()];
      if (picked.length === 0 || !view.ready) {
        view.estimating = false;
        paint();
        return;
      }
      view.estimating = true;
      paint();
      const mine = estimateRun;
      estimateTimer = setTimeout(async () => {
        const sel = current2();
        if (!sel) return;
        try {
          const dry = await api.startEvaluations({ conversations: picked, checklist_id: sel.checklist_id, version: sel.version, dry_run: true });
          if (destroyed || mine !== estimateRun) return;
          view.estimate = dry;
        } catch (error) {
          if (destroyed || mine !== estimateRun) return;
          toastError(store, error, { retry: scheduleEstimate });
        }
        view.estimating = false;
        paint();
      }, ESTIMATE_DELAY_MS);
    }
    function runBatch() {
      const sel = current2();
      const picked = [...selection()];
      if (busy() || !sel || picked.length === 0) return void 0;
      return slot.start(() => api.startEvaluations({ conversations: picked, checklist_id: sel.checklist_id, version: sel.version, mode: "reuse" }), { again: runBatch });
    }
    stops.push(
      watch(store, (state) => state.selection, (next) => {
        slot.reset();
        if ((next?.size ?? 0) > 0) boot();
        scheduleEstimate();
      }),
      watch(store, (state) => state.checklistSel, () => scheduleEstimate()),
      slot.watch((next, previous) => {
        if (previous?.lock === "watching" && (next?.lock ?? null) === null) scheduleEstimate();
        else paint();
      })
    );
    if (selection().size > 0) boot();
    paint();
    return {
      el: host,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        clearTimeout(estimateTimer);
        stops.forEach((stop) => stop());
      }
    };
  }

  // src/ui/player.js
  var isTime = (value) => typeof value === "number" && Number.isFinite(value);
  function startTimes(conversation) {
    const transcript = Array.isArray(conversation?.transcript) ? conversation.transcript : [];
    const given = Array.isArray(conversation?.audio_offsets) ? conversation.audio_offsets : [];
    if (given.length === 0) return offsets(transcript).map((value) => isTime(value) ? value : null);
    const starts = transcript.map(() => null);
    for (const entry of given) {
      const index = entry?.message_index;
      if (Number.isInteger(index) && index >= 0 && index < starts.length && isTime(entry.seconds)) starts[index] = entry.seconds;
    }
    return starts;
  }
  function playingIndex(starts, seconds) {
    if (!isTime(seconds)) return null;
    let best = null;
    for (let i = 0; i < starts.length; i += 1) {
      const start = starts[i];
      if (!isTime(start) || start > seconds) continue;
      if (best === null || start >= starts[best]) best = i;
    }
    return best;
  }
  function renderPlayer(conversation, api, transcript) {
    if (conversation?.channel !== "voice call") return null;
    const src = api.audioUrl(conversation);
    if (!src) {
      const needsImport = conversation.audio_unavailable_reason === "needs_import";
      const el2 = h(
        "div",
        { class: ["cqa-player", "cqa-player--none"], data: { test: "player" } },
        h("p", { class: "cqa-player-note", text: t(needsImport ? "player.needsImport" : "player.none") }),
        needsImport ? h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("player.import"), data: { test: "player-import" }, on: { click: () => transcript.openImport?.() } }) : null
      );
      return { el: el2, seek: () => false, destroy() {
      } };
    }
    const starts = startTimes(conversation);
    const status = h("p", { class: "cqa-player-note", attrs: { role: "status" } });
    status.hidden = true;
    const audio = h("audio", { class: "cqa-player-audio", attrs: { controls: true, preload: "metadata", src, "aria-label": t("player.label") } });
    const el = h("div", { class: "cqa-player", data: { test: "player" } }, audio, status);
    let current2 = null;
    let destroyed = false;
    function mark() {
      const index = playingIndex(starts, audio.currentTime);
      if (index === current2) return;
      current2 = index;
      transcript.markPlaying(index, { follow: !audio.paused });
    }
    audio.addEventListener("timeupdate", mark);
    audio.addEventListener("seeked", mark);
    audio.addEventListener("loadedmetadata", () => {
      status.hidden = true;
    });
    audio.addEventListener("error", () => {
      if (destroyed) return;
      status.replaceChildren(
        t("player.failed"),
        " ",
        h("button", { class: ["cqa-link", "cqa-player-retry"], attrs: { type: "button" }, text: t("player.retry"), data: { test: "player-retry" }, on: { click: () => audio.load() } })
      );
      status.hidden = false;
    });
    return {
      el,
      seek(index) {
        const start = starts[index];
        if (destroyed || !isTime(start)) return false;
        audio.currentTime = start;
        mark();
        return true;
      },
      destroy() {
        destroyed = true;
        audio.pause();
      }
    };
  }

  // src/ui/transcript.js
  var FLASH_MS = 1200;
  var KNOWN = /* @__PURE__ */ new Set(["client", "operator", "bot", "system"]);
  function speakerKind(speaker) {
    const name = typeof speaker === "string" ? speaker.trim().toLowerCase() : "";
    return KNOWN.has(name) ? name : "other";
  }
  var validIndex = (value, count) => Number.isInteger(value) && value >= 0 && value < count;
  function highlightPlan(count, evidence, range) {
    const marks = Array.from({ length: count }, () => ({ supports: false, expected: false, checked: false }));
    for (const item of Array.isArray(evidence) ? evidence : []) {
      if (!item || !validIndex(item.message_index, count)) continue;
      if (item.role === "supports") marks[item.message_index].supports = true;
      else if (item.role === "expected_here") marks[item.message_index].expected = true;
    }
    if (range && Number.isInteger(range.from) && Number.isInteger(range.to)) {
      const from = Math.max(0, Math.min(range.from, range.to));
      const to = Math.min(count - 1, Math.max(range.from, range.to));
      for (let i = from; i <= to; i += 1) marks[i].checked = true;
    }
    return marks;
  }
  function shownKey(conversation) {
    const transcript = Array.isArray(conversation?.transcript) ? conversation.transcript : [];
    return canonicalJson({
      conversation_id: conversation?.conversation_id ?? null,
      channel: conversation?.channel ?? null,
      language: conversation?.language ?? null,
      transcript,
      audio: conversation?.audio ?? null,
      // an import can make the recording playable
      audio_unavailable_reason: conversation?.audio_unavailable_reason ?? null,
      audio_offsets: Array.isArray(conversation?.audio_offsets) ? conversation.audio_offsets : []
    });
  }
  function openId2(store, args) {
    if (typeof args?.id === "string" && args.id !== "") return args.id;
    const { route: route2, conversationId } = store.get();
    return route2?.name === "workspace" && route2.params?.id ? route2.params.id : conversationId ?? null;
  }
  function stateBox2(test, title, note, extra) {
    return h("div", { class: "cqa-empty", attrs: { role: "status" }, data: { test } }, h("b", { class: "cqa-empty-title", text: title }), note ? h("p", { class: "cqa-empty-note", text: note }) : null, extra);
  }
  function buildMessage(message, index, offset, seek) {
    const kind = speakerKind(message?.speaker);
    const raw = typeof message?.timestamp === "string" ? message.timestamp.trim() : "";
    const clock = formatOffset(offset) || raw;
    const timeAttrs = raw === "" ? {} : { title: raw };
    const time = clock === "" ? null : seek ? h("button", { class: ["cqa-msg-time", "cqa-msg-seek"], attrs: { type: "button", title: t("player.seek", { time: clock }) }, text: clock, data: { test: "msg-time" }, on: { click: () => seek(index) } }) : h("span", { class: "cqa-msg-time", text: clock, attrs: timeAttrs, data: { test: "msg-time" } });
    const flag = h("b", { class: "cqa-msg-flag", data: { test: "msg-flag" } });
    const who = h(
      "div",
      { class: "cqa-msg-who" },
      flag,
      kind === "system" ? null : h("span", { class: "cqa-msg-speaker", text: t(`transcript.speaker.${kind}`), attrs: kind === "other" && message?.speaker ? { title: String(message.speaker) } : {}, data: { test: "msg-speaker" } }),
      time,
      message?.duplicate ? h("span", { class: "cqa-msg-dup", text: t("transcript.duplicate"), attrs: { title: t("transcript.duplicateTitle") } }) : null
    );
    const text3 = h("p", { class: "cqa-msg-text", text: typeof message?.text === "string" ? message.text : "" });
    const el = h("li", { class: ["cqa-msg", `cqa-msg--${kind}`, message?.duplicate && "is-duplicate"], data: { test: "msg", index, speaker: kind } }, who, text3);
    return { el, flag };
  }
  function renderTranscript(store, api, args = {}) {
    const id = openId2(store, args);
    const scroller = h("div", { class: "cqa-tr-scroll", attrs: { tabindex: "0", role: "region", "aria-label": t("transcript.label") }, data: { test: "transcript-list" } });
    const head = h("div", { class: "cqa-tr-head" });
    const playerHost = h("div", { class: "cqa-tr-player" });
    const el = h("div", { class: "cqa-tr", data: { test: "transcript" } }, head, playerHost, scroller);
    let destroyed = false;
    let rows = [];
    let loaded = false;
    let marked = [];
    let pending2 = { highlight: null, focus: null };
    let lastHighlight = null;
    let shown = null;
    let player = null;
    let playingAt = null;
    const flashTimers = /* @__PURE__ */ new Map();
    function clearMarks() {
      for (const i of marked) {
        const row = rows[i];
        row.el.classList.remove("is-evidence", "is-expected", "is-checked");
        row.el.removeAttribute("data-criterion");
        row.flag.textContent = "";
      }
      marked = [];
    }
    function applyHighlight(criterionId, evidence, range, label) {
      clearMarks();
      lastHighlight = criterionId === null || criterionId === void 0 ? null : [criterionId, evidence, range, label];
      if (lastHighlight === null) return;
      const name = typeof label === "string" && label.trim() !== "" ? label : String(criterionId);
      const plan = highlightPlan(rows.length, evidence, range);
      plan.forEach((mark, i) => {
        if (!mark.supports && !mark.expected && !mark.checked) return;
        const { el: row, flag } = rows[i];
        row.classList.toggle("is-evidence", mark.supports);
        row.classList.toggle("is-expected", mark.expected);
        row.classList.toggle("is-checked", mark.checked);
        row.setAttribute("data-criterion", String(criterionId));
        flag.textContent = [mark.supports ? name : "", mark.expected ? t("transcript.expectedHere") : ""].filter(Boolean).join(" \xB7 ");
        marked.push(i);
      });
    }
    function highlight(criterionId, evidence, checkedRange, label) {
      if (destroyed) return;
      if (!loaded) pending2.highlight = [criterionId, evidence, checkedRange, label];
      else applyHighlight(criterionId, evidence, checkedRange, label);
    }
    function flash(index) {
      const { el: row } = rows[index];
      clearTimeout(flashTimers.get(index));
      row.classList.remove("is-flash");
      void row.offsetWidth;
      row.classList.add("is-flash");
      flashTimers.set(
        index,
        setTimeout(() => {
          row.classList.remove("is-flash");
          flashTimers.delete(index);
        }, FLASH_MS)
      );
    }
    function centre(index) {
      const row = rows[index].el;
      const top = row.offsetTop - (scroller.clientHeight - row.offsetHeight) / 2;
      scroller.scrollTo({ top: Math.max(0, top), behavior: "auto" });
    }
    function focusMessage(index) {
      if (destroyed) return false;
      if (!loaded) {
        pending2.focus = index;
        return Number.isInteger(index) && index >= 0;
      }
      if (!validIndex(index, rows.length)) return false;
      centre(index);
      flash(index);
      player?.seek(index);
      return true;
    }
    function markPlaying(index, { follow = false } = {}) {
      if (destroyed || !loaded) return;
      if (playingAt !== null) rows[playingAt]?.el.classList.remove("is-playing");
      playingAt = validIndex(index, rows.length) ? index : null;
      if (playingAt === null) return;
      const row = rows[playingAt].el;
      row.classList.add("is-playing");
      const above = row.offsetTop < scroller.scrollTop;
      const below = row.offsetTop + row.offsetHeight > scroller.scrollTop + scroller.clientHeight;
      if (follow && (above || below)) centre(playingAt);
    }
    const handle = { el, highlight, focusMessage, destroy };
    function show(conversation) {
      const transcript = Array.isArray(conversation?.transcript) ? conversation.transcript : [];
      const channel = conversation?.channel === "voice call" ? t("queue.channel.call") : conversation?.channel === "agent chat" ? t("queue.channel.chat") : "";
      clear(head).append(
        h("b", { class: "cqa-tr-title", text: conversation?.conversation_id ?? id ?? "", data: { test: "transcript-title" } }),
        h("span", { class: "cqa-tr-meta", text: [channel, conversation?.language, t("transcript.lines", { n: transcript.length })].filter(Boolean).join(" \xB7 "), data: { test: "transcript-meta" } })
      );
      clear(scroller);
      rows = [];
      marked = [];
      playingAt = null;
      loaded = true;
      shown = shownKey(conversation);
      player?.destroy();
      player = renderPlayer(conversation, api, {
        markPlaying,
        openImport: () => openImport(store, api, el.closest(".cqa") ?? el, { group: conversation?.group_id })
      });
      clear(playerHost);
      if (player) playerHost.append(player.el);
      if (transcript.length === 0) {
        scroller.append(stateBox2("transcript-empty", t("transcript.empty"), t("transcript.emptyNote")));
      } else {
        const audible = Boolean(api.audioUrl?.(conversation)) && conversation?.channel === "voice call";
        const clock = offsets(transcript);
        const starts = audible ? startTimes(conversation) : null;
        const at = audible ? starts.map((start, i) => start ?? clock[i]) : clock;
        const seek = (index) => player?.seek(index);
        rows = transcript.map((message, i) => buildMessage(message, i, at[i], audible && starts[i] !== null ? seek : null));
        scroller.append(h("ol", { class: "cqa-tr-msgs", data: { test: "transcript-msgs" } }, rows.map((row) => row.el)));
      }
      const { highlight: waiting, focus } = pending2;
      pending2 = { highlight: null, focus: null };
      if (waiting) applyHighlight(...waiting);
      if (focus !== null) focusMessage(focus);
    }
    function showError(error) {
      player?.destroy();
      player = null;
      clear(playerHost);
      clear(head);
      clear(scroller).append(
        stateBox2(
          "transcript-error",
          t("transcript.loadFailed", { id }),
          errorText(error),
          h("button", { class: "cqa-tr-retry", attrs: { type: "button" }, text: t("transcript.retry"), data: { test: "transcript-retry" }, on: { click: load2 } })
        )
      );
    }
    let run = 0;
    async function load2() {
      const mine = ++run;
      loaded = false;
      rows = [];
      marked = [];
      clear(scroller).append(stateBox2("transcript-loading", t("transcript.loading", { id })));
      try {
        const conversation = await api.getConversation(id);
        if (destroyed || mine !== run) return;
        show(conversation);
      } catch (error) {
        if (destroyed || mine !== run) return;
        showError(error);
      }
    }
    async function refresh() {
      if (destroyed || id === null) return;
      if (!loaded) {
        load2();
        return;
      }
      const mine = ++run;
      try {
        const conversation = await api.getConversation(id);
        if (destroyed || mine !== run || shownKey(conversation) === shown) return;
        const top = scroller.scrollTop;
        if (pending2.highlight === null && lastHighlight !== null) pending2.highlight = lastHighlight;
        show(conversation);
        scroller.scrollTop = top;
      } catch (error) {
        if (destroyed || mine !== run) return;
        toastError(store, error, { retry: refresh });
      }
    }
    function destroy() {
      if (destroyed) return;
      destroyed = true;
      stopRefresh();
      player?.destroy();
      flashTimers.forEach((timer) => clearTimeout(timer));
      flashTimers.clear();
      if (store.get().transcript === handle) store.set({ transcript: null });
      const hook2 = window.__cqaTest;
      if (hook2?.store === store && hook2.transcript?.focusMessage === focusMessage) hook2.transcript = null;
    }
    const stopRefresh = watch(store, (state) => state.importRefresh, () => refresh());
    store.set({ transcript: handle });
    const hook = window.__cqaTest;
    if (hook?.store === store) hook.transcript = { focusMessage, highlight };
    if (id === null) scroller.append(stateBox2("transcript-empty", t("workspace.pick")));
    else load2();
    return handle;
  }

  // src/ui/review-panel.js
  var POLL_MS3 = 2e3;
  var CONTEXT_LINES = 2;
  var validIndex2 = (value, count) => Number.isInteger(value) && value >= 0 && value < count;
  function fragmentIndexes(result, count) {
    const picked = /* @__PURE__ */ new Set();
    const evidence = Array.isArray(result?.evidence) ? result.evidence : [];
    const marks = evidence.map((item) => item?.message_index).filter((i) => validIndex2(i, count));
    if (marks.length > 0) {
      for (const i of marks) {
        for (let k = i - CONTEXT_LINES; k <= i + CONTEXT_LINES; k += 1) if (validIndex2(k, count)) picked.add(k);
      }
    } else {
      const range = result?.checked_range;
      if (range && Number.isInteger(range.from) && Number.isInteger(range.to)) {
        const from = Math.max(0, Math.min(range.from, range.to));
        const to = Math.min(count - 1, Math.max(range.from, range.to));
        for (let k = from; k <= to; k += 1) picked.add(k);
      }
    }
    return [...picked].sort((a, b) => a - b);
  }
  function answerChoices(criterion) {
    const candidates = criterion?.answer_type === "scale" ? (criterion.scale_steps ?? []).map((step) => ({ step: step.value })) : ["yes", "no"];
    candidates.push("na");
    return candidates.filter((answer) => validateAnswer(criterion, answer) === null);
  }
  var answerValue = (answer) => typeof answer === "string" ? answer : `step:${answer.step}`;
  function parseAnswerValue(value) {
    if (value === "yes" || value === "no" || value === "na") return value;
    const match = /^step:(-?\d+(?:\.\d+)?)$/.exec(String(value ?? ""));
    return match ? { step: Number(match[1]) } : null;
  }
  var same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  var totalText = (value) => value === null || value === void 0 ? t("scorecard.totalNone") : fmt2(rat(value));
  var tag2 = (kind, text3, props = {}) => h("span", { class: ["cqa-tag", `cqa-tag--${kind}`], text: text3, data: props.data });
  function stepLabel(criterion, answer) {
    const text3 = answerTag(criterion, answer).text;
    if (typeof answer !== "object") return text3;
    const step = (criterion.scale_steps ?? []).find((s) => s.value === answer.step);
    return step?.label ? `${text3} \xB7 ${step.label}` : text3;
  }
  function renderReviewPanel(store, api, appealId, { onDecided } = {}) {
    const el = h("section", { class: "cqa-rv", attrs: { "aria-label": t("review.label") }, data: { test: "review-panel" } });
    const view = { appeal: null, evaluation: null, version: null, conversation: null, outcome: null, answer: null, reason: "", busy: false, result: null, saved: null, reloading: false, reloadFailed: false };
    let destroyed = false;
    let pollTimer = null;
    const stops = [];
    const opinionBox = h("div", { class: "cqa-rv-opinion", attrs: { role: "status", "aria-live": "polite" }, data: { test: "second-opinion" } });
    const decisionBox = h("div", { class: "cqa-rv-decision", data: { test: "decision" } });
    const criterion = () => view.version?.criteria.find((c) => c.id === view.appeal.criterion_id) ?? null;
    const result = () => view.evaluation?.results.find((r) => r.criterion_id === view.appeal.criterion_id) ?? null;
    async function load2() {
      clear(el).append(h("div", { class: "cqa-empty", attrs: { role: "status" }, data: { test: "review-loading" } }, h("b", { class: "cqa-empty-title", text: t("review.loading") })));
      try {
        const appeal = await api.getAppeal(appealId);
        const [evaluation, conversation] = await Promise.all([api.getEvaluation(appeal.evaluation_id), api.getConversation(appeal.conversation)]);
        const version2 = await api.getChecklistVersion(evaluation.checklist_id, evaluation.version);
        if (destroyed) return;
        Object.assign(view, { appeal, evaluation, version: version2, conversation });
        draw();
        schedulePoll();
      } catch (error) {
        if (destroyed) return;
        clear(el).append(
          h(
            "div",
            { class: "cqa-empty", attrs: { role: "status" }, data: { test: "review-error" } },
            h("b", { class: "cqa-empty-title", text: t("review.loadFailed") }),
            h("p", { class: "cqa-empty-note", text: errorText(error) }),
            h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("review.retry"), on: { click: load2 } })
          )
        );
      }
    }
    function schedulePoll() {
      clearTimeout(pollTimer);
      if (destroyed || view.appeal?.second_opinion_status !== "pending") return;
      pollTimer = setTimeout(async () => {
        try {
          const fresh = await api.getAppeal(appealId);
          if (destroyed) return;
          view.appeal = { ...view.appeal, second_opinion: fresh.second_opinion, second_opinion_status: fresh.second_opinion_status };
          paintOpinion();
        } catch {
        }
        schedulePoll();
      }, POLL_MS3);
    }
    function draw() {
      const { appeal, conversation } = view;
      const c = criterion();
      const r = result();
      const open = appeal.status === "open";
      const conversationId = conversation?.conversation_id ?? appeal.conversation;
      const head = h(
        "div",
        { class: "cqa-rv-head" },
        h("h2", { class: "cqa-rv-title", text: t("review.title", { id: conversationId }) }),
        tag2(open ? "mid" : "ok", t(open ? "appeals.status.open" : "appeals.status.decided"), { data: { test: "review-status" } }),
        h("a", { class: ["cqa-link", "cqa-rv-card"], attrs: { href: href("workspace", { id: appeal.conversation }) }, text: t("review.openCard"), data: { test: "review-card-link" } })
      );
      const points = c?.kind === "gross_error" ? t("scorecard.grossNoScore") : r && typeof r.points === "number" && typeof r.effective_weight === "number" ? t("scorecard.points", { earned: fmt2(rat(r.points)), max: fmt2(rat(r.effective_weight)) }) : "\u2014";
      const disputed = h(
        "div",
        { class: "cqa-rv-crit", data: { test: "review-criterion" } },
        h("p", { class: "cqa-rv-label", text: t("review.criterion") }),
        h(
          "div",
          { class: "cqa-sc-r1" },
          h("b", { class: "cqa-sc-crit-title", text: c?.title ?? appeal.criterion_id }),
          r && c ? tag2(answerTag(c, r.answer).kind, answerTag(c, r.answer).text, { data: { test: "review-answer" } }) : null,
          // after a decision the points follow the new answer, so show it next to the model's
          r && c && r.final_answer !== void 0 && r.final_answer !== null && !same(r.final_answer, r.answer) ? h("span", { class: "cqa-rv-then" }, h("span", { text: "\u2192", attrs: { "aria-hidden": "true" } }), tag2(answerTag(c, r.final_answer).kind, answerTag(c, r.final_answer).text, { data: { test: "review-final-answer" } })) : null,
          h("span", { class: ["cqa-sc-pts", "num"], text: points, data: { test: "review-points" } })
        ),
        r?.explanation ? h("p", { class: "cqa-sc-why", text: r.explanation }) : null,
        r?.answer === "na" && r.na_reason ? h("p", { class: "cqa-sc-na", text: r.na_reason }) : null
      );
      const comment = h(
        "div",
        { class: "cqa-rv-comment" },
        h("p", { class: "cqa-rv-label", text: t("review.comment") }),
        h("p", { class: "cqa-rv-quote", text: appeal.comment, data: { test: "review-comment" } })
      );
      clear(el).append(head, disputed, comment, buildFragment(r), opinionBox, decisionBox);
      paintOpinion();
      paintDecision();
    }
    function buildFragment(r) {
      const lines = Array.isArray(view.conversation?.transcript) ? view.conversation.transcript : [];
      const picked = fragmentIndexes(r, lines.length);
      const marked = new Set((r?.evidence ?? []).map((item) => item?.message_index));
      const at = offsets(lines);
      const items = [];
      picked.forEach((index, n) => {
        if (n > 0 && index !== picked[n - 1] + 1) items.push(h("li", { class: "cqa-rv-gap", text: "\u2026", attrs: { "aria-hidden": "true" } }));
        const message = lines[index];
        const kind = speakerKind(message?.speaker);
        const clock = formatOffset(at[index]) || (typeof message?.timestamp === "string" ? message.timestamp : "");
        items.push(
          h(
            "li",
            { class: ["cqa-rv-msg", `cqa-rv-msg--${kind}`, marked.has(index) && "is-evidence"], data: { test: "fragment-msg", index } },
            h("span", { class: "cqa-rv-msg-meta", text: [t("scorecard.evidenceLine", { n: index + 1 }), kind === "system" ? null : t(`transcript.speaker.${kind}`), clock].filter(Boolean).join(" \xB7 ") }),
            h("p", { class: "cqa-rv-msg-text", text: typeof message?.text === "string" ? message.text : "" })
          )
        );
      });
      return h(
        "div",
        { class: "cqa-rv-fragment", data: { test: "review-fragment" } },
        h("p", { class: "cqa-rv-label", text: t("review.fragment") }),
        items.length > 0 ? h("ol", { class: "cqa-rv-msgs" }, items) : h("p", { class: "cqa-rv-none", text: t("review.noFragment") })
      );
    }
    function paintOpinion() {
      const { second_opinion: opinion, second_opinion_status: status } = view.appeal;
      const c = criterion();
      opinionBox.setAttribute("data-state", status ?? "unavailable");
      clear(opinionBox).append(h("p", { class: "cqa-rv-label", text: t("review.opinion") }));
      if (status === "pending") opinionBox.append(h("p", { class: "cqa-rv-note", text: t("review.opinionPending") }));
      else if (status === "done" && opinion) {
        opinionBox.append(
          h(
            "div",
            { class: "cqa-rv-opinion-body" },
            c && opinion.answer !== void 0 && opinion.answer !== null ? tag2(answerTag(c, opinion.answer).kind, t("review.opinionAnswer", { answer: answerTag(c, opinion.answer).text })) : null,
            opinion.reasoning ? h("p", { class: "cqa-rv-note", text: opinion.reasoning }) : null,
            h("p", { class: "cqa-rv-hint", text: t("review.opinionAdvice") })
          )
        );
      } else opinionBox.append(h("p", { class: "cqa-rv-note", text: t("review.opinionUnavailable") }));
    }
    function paintDecision() {
      clear(decisionBox).append(h("p", { class: "cqa-rv-label", text: t("review.decision") }));
      const { appeal } = view;
      if (view.saved) {
        decisionBox.append(savedView());
        return;
      }
      if (appeal.status !== "open") {
        decisionBox.append(decidedView());
        return;
      }
      if (store.get().role !== "reviewer") {
        decisionBox.append(h("p", { class: "cqa-rv-note", text: t("review.readOnly"), data: { test: "decision-readonly" } }));
        return;
      }
      decisionBox.append(decisionForm());
    }
    function decidedView() {
      const { decision } = view.appeal;
      const c = criterion();
      const box = h("div", { class: "cqa-rv-decided", data: { test: "decision-done" } });
      if (decision) {
        const what = decision.outcome === "changed" && c ? t("review.decidedChanged", { answer: answerTag(c, decision.answer).text }) : t("review.decidedConfirmed");
        box.append(h("b", { class: "cqa-rv-decided-what", text: what }), decision.reason ? h("p", { class: "cqa-rv-note", text: decision.reason }) : null);
      }
      if (view.result) {
        box.append(h("p", { class: "cqa-rv-result", text: t("review.result", { from: totalText(view.result.before), to: totalText(view.result.after) }), data: { test: "decision-result" } }));
      }
      return box;
    }
    function decisionForm() {
      const c = criterion();
      const r = result();
      const current2 = r ? r.final_answer ?? r.answer : null;
      const choices = c ? answerChoices(c) : [];
      if (view.answer === null || !choices.some((a) => same(a, view.answer))) view.answer = choices.find((a) => !same(a, current2)) ?? choices[0] ?? null;
      const submit = h("button", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { type: "submit" }, text: t("review.submit"), data: { test: "decision-submit" } });
      const paintSubmit = () => {
        submit.disabled = view.busy || view.outcome === null || view.reason.trim() === "" || view.outcome === "changed" && view.answer === null;
      };
      const outcomeButton = (outcome, test) => h("button", {
        class: ["cqa-rv-choice", view.outcome === outcome && "is-on"],
        attrs: { type: "button", "aria-pressed": String(view.outcome === outcome) },
        text: t(`review.${outcome}`),
        data: { test },
        on: {
          click: () => {
            view.outcome = outcome;
            paintDecision();
          }
        }
      });
      let picker = null;
      if (view.outcome === "changed") {
        const select = h(
          "select",
          {
            class: "cqa-sc-select",
            attrs: { "aria-label": t("review.newAnswer") },
            data: { test: "decision-answer" },
            on: {
              change: () => {
                view.answer = parseAnswerValue(select.value);
                paintSubmit();
              }
            }
          },
          choices.map((answer) => h("option", { attrs: { value: answerValue(answer) }, text: stepLabel(c, answer) }))
        );
        if (view.answer !== null) select.value = answerValue(view.answer);
        picker = h("label", { class: "cqa-rv-field" }, h("span", { class: "cqa-rv-label", text: t("review.newAnswer") }), select);
      }
      const reason = h("textarea", {
        class: "cqa-rv-text",
        attrs: { rows: "3", "aria-label": t("review.reason"), placeholder: t("review.reasonPlaceholder") },
        data: { test: "decision-reason" },
        on: {
          input: () => {
            view.reason = reason.value;
            paintSubmit();
          }
        }
      });
      reason.value = view.reason;
      paintSubmit();
      return h(
        "form",
        {
          class: "cqa-rv-form",
          data: { test: "decision-form" },
          on: {
            submit: (event) => {
              event.preventDefault();
              decide();
            }
          }
        },
        h("div", { class: "cqa-rv-choices", attrs: { role: "group", "aria-label": t("review.decision") } }, outcomeButton("confirmed", "decision-confirm"), outcomeButton("changed", "decision-change")),
        picker,
        h("label", { class: "cqa-rv-field" }, h("span", { class: "cqa-rv-label", text: t("review.reason") }), reason),
        h("div", { class: "cqa-rv-acts" }, submit)
      );
    }
    async function decide() {
      if (destroyed || view.busy || view.saved || view.outcome === null || view.reason.trim() === "") return;
      view.busy = true;
      paintDecision();
      const before = view.evaluation.final_total;
      const body = { outcome: view.outcome, reason: view.reason.trim() };
      if (view.outcome === "changed") body.answer = view.answer;
      let evaluation;
      try {
        evaluation = await api.decideAppeal(appealId, body);
      } catch (error) {
        if (destroyed) return;
        view.busy = false;
        paintDecision();
        toastError(store, error, { retry: decide });
        return;
      }
      view.saved = { before, evaluation: evaluation?.results ? evaluation : null };
      view.busy = false;
      store.set((state) => ({ queueRefresh: (state.queueRefresh ?? 0) + 1 }));
      if (destroyed) return;
      onDecided?.();
      await reloadAfterDecision();
    }
    async function reloadAfterDecision() {
      if (destroyed || !view.saved || view.reloading) return;
      view.reloading = true;
      view.reloadFailed = false;
      paintDecision();
      try {
        const appeal = await api.getAppeal(appealId);
        const evaluation = view.saved.evaluation ?? await api.getEvaluation(appeal.evaluation_id);
        if (destroyed) return;
        view.appeal = appeal;
        view.evaluation = evaluation;
        view.result = { before: view.saved.before, after: evaluation.final_total };
        view.saved = null;
        view.reloading = false;
        draw();
      } catch (error) {
        if (destroyed) return;
        view.reloading = false;
        view.reloadFailed = true;
        paintDecision();
        toastError(store, error, { retry: reloadAfterDecision });
      }
    }
    function savedView() {
      const { before, evaluation } = view.saved;
      return h(
        "div",
        { class: "cqa-rv-decided", data: { test: "decision-saved" } },
        h("b", { class: "cqa-rv-decided-what", text: t("review.saved") }),
        evaluation ? h("p", { class: "cqa-rv-result", text: t("review.result", { from: totalText(before), to: totalText(evaluation.final_total) }), data: { test: "decision-result" } }) : null,
        view.reloadFailed ? h(
          "p",
          { class: "cqa-rv-note" },
          t("review.reloadFailed"),
          " ",
          h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("review.reload"), data: { test: "decision-reload" }, on: { click: () => reloadAfterDecision() } })
        ) : h("p", { class: "cqa-rv-hint", text: t("review.reloading") })
      );
    }
    stops.push(
      watch(store, (state) => state.role, () => {
        if (view.appeal && !destroyed) paintDecision();
      })
    );
    load2();
    return {
      el,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        clearTimeout(pollTimer);
        stops.forEach((stop) => stop());
      }
    };
  }

  // src/ui/appeals-page.js
  var FILTERS = ["open", "decided", "all"];
  var COMMENT_MAX = 120;
  var clip2 = (text3) => {
    const line = String(text3 ?? "").trim().replace(/\s+/g, " ");
    return line.length > COMMENT_MAX ? `${line.slice(0, COMMENT_MAX - 1).trimEnd()}\u2026` : line;
  };
  function splitConversation(id) {
    const text3 = String(id ?? "");
    const at = text3.indexOf(":");
    return at < 0 ? { group: "", conversation: text3 } : { group: text3.slice(0, at), conversation: text3.slice(at + 1) };
  }
  function createAppealsPage(store, api, route2) {
    const view = { filter: "open", appeals: [], phase: "loading", error: null, titles: /* @__PURE__ */ new Map() };
    let destroyed = false;
    let panel = null;
    let openId3 = route2.name === "appeal" ? route2.params.id : null;
    let run = 0;
    const pills = FILTERS.map((name) => {
      const count = h("span", { class: ["cqa-q-count", "num"] });
      const button = h(
        "button",
        { class: "cqa-q-pill", attrs: { type: "button", "aria-pressed": "false" }, data: { test: `appeals-filter-${name}` }, on: { click: () => setFilter(name) } },
        h("span", { text: t(`appeals.filter.${name}`) }),
        count
      );
      return { name, button, count };
    });
    const list = h("ul", { class: "cqa-aps-list", attrs: { "aria-label": t("appeals.list") }, data: { test: "appeals-list" } });
    const state = h("div", { class: "cqa-aps-state" });
    const listCol = h("div", { class: "cqa-aps-col" }, h("div", { class: "cqa-q-pills", attrs: { role: "group", "aria-label": t("appeals.filters") } }, pills.map((p) => p.button)), state, list);
    const back = h("a", { class: ["cqa-link", "cqa-aps-back"], attrs: { href: href("appeals") }, text: t("appeals.back"), data: { test: "appeals-back" } });
    const panelCol = h("div", { class: "cqa-aps-panel" });
    const el = h(
      "section",
      { class: ["cqa-view", "cqa-aps"], data: { test: "appeals-page" } },
      h("h1", { class: "cqa-view-title", text: t("nav.appeals") }),
      h("div", { class: "cqa-aps-grid" }, listCol, h("div", { class: "cqa-aps-side" }, back, panelCol))
    );
    function setFilter(name) {
      if (view.filter === name) return;
      view.filter = name;
      paint();
    }
    const matches = (appeal) => view.filter === "all" || appeal.status === view.filter;
    function row(appeal) {
      const { group, conversation } = splitConversation(appeal.conversation);
      const open = appeal.status === "open";
      const link = h(
        "a",
        { class: "cqa-aps-link", attrs: { href: href("appeal", { id: appeal.id }), "aria-current": appeal.id === openId3 ? "true" : null } },
        h("span", { class: "cqa-aps-row1" }, h("b", { class: "cqa-q-id", text: conversation }), h("span", { class: ["cqa-tag", open ? "cqa-tag--mid" : "cqa-tag--ok"], text: t(open ? "appeals.status.open" : "appeals.status.decided") })),
        h("span", { class: "cqa-aps-crit", text: view.titles.get(appeal.id) ?? appeal.criterion_id }),
        h("span", { class: "cqa-aps-comment", text: clip2(appeal.comment) }),
        group ? h("span", { class: "cqa-q-meta" }, h("span", { class: ["cqa-tag", "cqa-tag--out"], text: group })) : null
      );
      return h("li", { class: ["cqa-aps-item", appeal.id === openId3 && "is-current"], data: { test: "appeal-row", id: appeal.id, status: appeal.status } }, link);
    }
    function paint() {
      if (destroyed) return;
      for (const pill of pills) {
        pill.count.textContent = String(view.appeals.filter((a) => pill.name === "all" || a.status === pill.name).length);
        pill.button.setAttribute("aria-pressed", String(pill.name === view.filter));
        pill.button.classList.toggle("is-on", pill.name === view.filter);
      }
      const shown = view.appeals.filter(matches);
      list.replaceChildren(...shown.map(row));
      clear(state);
      const box = (test, title, note) => h("div", { class: "cqa-empty", attrs: { role: "status" }, data: { test } }, h("b", { class: "cqa-empty-title", text: title }), note ? h("p", { class: "cqa-empty-note", text: note }) : null);
      if (view.phase === "loading") state.append(box("appeals-loading", t("appeals.loading")));
      else if (view.phase === "error") {
        state.append(box("appeals-error", t("appeals.loadFailed"), errorText(view.error)));
        state.append(h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("appeals.retry"), on: { click: load2 } }));
      } else if (shown.length === 0) state.append(box("appeals-empty", t(view.appeals.length === 0 ? "appeals.empty" : "appeals.noMatch"), view.appeals.length === 0 ? t("appeals.emptyNote") : null));
      el.classList.toggle("has-panel", openId3 !== null);
    }
    async function titlesFor(appeals) {
      const versions = /* @__PURE__ */ new Map();
      const byEvaluation = /* @__PURE__ */ new Map();
      const versionOf = (evaluationId) => {
        if (!byEvaluation.has(evaluationId)) {
          byEvaluation.set(
            evaluationId,
            api.getEvaluation(evaluationId).then((ev) => {
              const key = `${ev.checklist_id}@${ev.version}`;
              if (!versions.has(key)) versions.set(key, api.getChecklistVersion(ev.checklist_id, ev.version));
              return versions.get(key);
            })
          );
        }
        return byEvaluation.get(evaluationId);
      };
      await Promise.all(
        appeals.filter((appeal) => !view.titles.has(appeal.id)).map(
          (appeal) => versionOf(appeal.evaluation_id).then(
            (version2) => {
              const criterion = version2.criteria.find((c) => c.id === appeal.criterion_id);
              if (criterion) view.titles.set(appeal.id, criterion.title);
            },
            () => {
            }
            // the row keeps the criterion id
          )
        )
      );
    }
    async function load2() {
      const mine = ++run;
      try {
        const appeals = await api.listAppeals();
        if (destroyed || mine !== run) return;
        view.appeals = appeals;
        view.phase = "ready";
        paint();
        await titlesFor(appeals);
        if (!destroyed && mine === run) paint();
      } catch (error) {
        if (destroyed || mine !== run) return;
        view.phase = "error";
        view.error = error;
        paint();
      }
    }
    function showPanel(id) {
      panel?.destroy();
      panel = null;
      clear(panelCol);
      openId3 = id;
      if (id === null) {
        panelCol.append(h("div", { class: "cqa-empty", data: { test: "appeals-pick" } }, h("b", { class: "cqa-empty-title", text: t("appeals.pick") })));
      } else {
        panel = renderReviewPanel(store, api, id, { onDecided: () => load2() });
        panelCol.append(panel.el);
      }
      paint();
    }
    showPanel(openId3);
    load2();
    return {
      el,
      update(next) {
        const id = next.name === "appeal" ? next.params.id : null;
        if (id !== openId3) showPanel(id);
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        panel?.destroy();
      }
    };
  }

  // src/domain/checklist-diff.js
  var same2 = (x, y) => canonicalJson(fingerprintSubset(x)) === canonicalJson(fingerprintSubset(y));
  var hasId = (c) => typeof c?.id === "string" && c.id !== "";
  function diffVersions(a, b) {
    const before = new Map((a?.criteria ?? []).filter(hasId).map((c) => [c.id, c]));
    const after = b?.criteria ?? [];
    const seen = /* @__PURE__ */ new Set();
    const out = { added: [], removed: [], reworded: [], weightOnly: [] };
    for (const c of after) {
      const old = hasId(c) ? before.get(c.id) : void 0;
      if (!old) {
        out.added.push(hasId(c) ? c.id : null);
        continue;
      }
      seen.add(c.id);
      if (!same2(old, c)) out.reworded.push(c.id);
      else if (Number(old.weight ?? 0) !== Number(c.weight ?? 0)) out.weightOnly.push(c.id);
    }
    for (const id of before.keys()) if (!seen.has(id)) out.removed.push(id);
    return out;
  }

  // src/domain/checklist-validate.js
  var text2 = (value) => typeof value === "string" ? value.trim() : "";
  function parseNumber(value) {
    if (typeof value === "number") return value;
    if (typeof value !== "string") return Number.NaN;
    const cleaned = value.trim().replace(",", ".");
    return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : Number.NaN;
  }
  var sumOf = (weights) => Math.round(weights.reduce((acc, w) => acc + w, 0) * 1e6) / 1e6;
  function validateChecklist(draft) {
    const errors = [];
    const warnings = [];
    const fail2 = (path, code) => errors.push({ path, code });
    const source = draft ?? {};
    if (text2(source.name) === "") fail2("name", "title_required");
    const sections = Array.isArray(source.sections) ? source.sections.map((s, i) => ({ ...s, order: Number.isInteger(s?.order) ? s.order : i + 1 })) : [];
    const sectionIds = new Set(sections.map((s) => s.id));
    const criteria = (Array.isArray(source.criteria) ? source.criteria : []).map((raw, i) => {
      const c = { ...raw };
      const path = `criteria.${i}`;
      const gross = c.kind === "gross_error";
      c.kind = gross ? "gross_error" : "scored";
      c.answer_type = c.answer_type === "scale" ? "scale" : "yes_no";
      if (text2(c.title) === "") fail2(`${path}.title`, "title_required");
      if (!sectionIds.has(c.section_id)) fail2(`${path}.section_id`, "section_missing");
      if (gross) c.weight = 0;
      else {
        const weight = parseNumber(c.weight);
        if (!Number.isFinite(weight) || weight < 0) fail2(`${path}.weight`, "weight_invalid");
        else c.weight = weight;
      }
      if (c.answer_type === "scale") {
        const steps = (Array.isArray(c.scale_steps) ? c.scale_steps : []).map((step) => ({ value: parseNumber(step?.value), label: typeof step?.label === "string" ? step.label : "" }));
        if (steps.some((step) => !Number.isFinite(step.value))) fail2(`${path}.scale_steps`, "scale_value_invalid");
        else if (steps.length < 2) fail2(`${path}.scale_steps`, "scale_empty");
        else if (new Set(steps.map((step) => step.value)).size !== steps.length) fail2(`${path}.scale_steps`, "scale_duplicate");
        c.scale_steps = steps.sort((a, b) => a.value - b.value);
      } else c.scale_steps = [];
      c.na_allowed = c.na_allowed === true;
      if (c.na_allowed && text2(c.na_condition) === "") fail2(`${path}.na_condition`, "na_condition_required");
      c.na_condition = c.na_allowed ? text2(c.na_condition) || null : null;
      c.kinds = gross ? Array.isArray(c.kinds) ? c.kinds.map(text2).filter(Boolean) : [] : [];
      c.wording = typeof c.wording === "string" ? c.wording : "";
      c.guidance = text2(c.guidance) === "" ? null : c.guidance;
      if (!Number.isInteger(c.order)) c.order = i + 1;
      return c;
    });
    if (criteria.length === 0) fail2("criteria", "criteria_empty");
    const scored = criteria.filter((c) => c.kind === "scored" && Number.isFinite(c.weight));
    const sum = sumOf(scored.map((c) => c.weight));
    if (scored.length > 0 && sum !== 100) warnings.push({ code: "weight_sum", sum });
    return { value: { ...source, sections, criteria }, errors, warnings };
  }

  // src/ui/apply-dialog.js
  var DEV = "DEV";
  function compareFrom(version2) {
    if (version2?.based_on?.checklist_id) return { checklist_id: version2.based_on.checklist_id, version: version2.based_on.version };
    if (Number.isInteger(version2?.version) && version2.version > 1) return { checklist_id: version2.checklist_id, version: version2.version - 1 };
    return null;
  }
  function controlGroup(groups, current2) {
    if (current2 && current2 !== DEV && groups.includes(current2)) return current2;
    const others = groups.filter((g) => g !== DEV).sort();
    return others.length > 0 ? others[others.length - 1] : null;
  }
  function openApplyDialog({ host, store, api, version: version2 }) {
    let closed = false;
    const view = { targets: null, target: null, estimate: null, estimating: false, error: null, server: null };
    let estimateRun = 0;
    const slot = jobSlot(store, api, `apply:${version2.checklist_id}:${version2.version}`);
    const busy = () => slot.busy();
    if (busy()) view.target = slot.state()?.meta?.target ?? null;
    else slot.reset();
    const body = h("div", { class: "cqa-ap-form" });
    const estimate = h("p", { class: "cqa-batch-estimate", attrs: { "aria-live": "polite" }, data: { test: "apply-estimate" } });
    const hint = h("p", { class: "cqa-sc-hint", text: t("batch.keyMissing") });
    const runButton = h("button", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { type: "button" }, text: t("apply.run"), data: { test: "apply-run" }, on: { click: () => run() } });
    const progress = h("div", { class: "cqa-sc-status", attrs: { role: "status", "aria-live": "polite" }, data: { test: "apply-progress" } });
    const closeButton = h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("apply.close"), data: { test: "apply-close" }, on: { click: () => close() } });
    function targetRow(key, label, count, disabled) {
      const input = h("input", {
        class: "cqa-ap-radio",
        attrs: { type: "radio", name: "cqa-apply-target", value: key, disabled: disabled || busy() ? true : null },
        data: { test: `apply-target-${key}` },
        on: { change: () => choose(key) }
      });
      input.checked = view.target === key;
      return h("label", { class: ["cqa-ap-target", disabled && "is-disabled"] }, input, h("span", { text: label }), h("span", { class: ["cqa-q-count", "num"], text: disabled && count === 0 ? "" : String(count) }));
    }
    function paint() {
      if (closed) return;
      clear(body);
      if (!view.targets) {
        body.append(h("p", { class: "cqa-rv-note", text: view.error ? errorText(view.error) : t("apply.loading") }));
        runButton.disabled = true;
        return;
      }
      const { control, dev, selected } = view.targets;
      body.append(
        h("p", { class: "cqa-rv-label", text: t("apply.targets") }),
        h(
          "div",
          { class: "cqa-ap-targets", attrs: { role: "radiogroup", "aria-label": t("apply.targets") } },
          targetRow("control", control.group ? t("apply.control", { group: control.group }) : t("apply.controlNone"), control.ids.length, control.ids.length === 0),
          targetRow("dev", t("apply.dev"), dev.ids.length, dev.ids.length === 0),
          targetRow("selected", t("apply.selected"), selected.ids.length, selected.ids.length === 0)
        ),
        h("p", { class: "cqa-rv-hint", text: t("apply.noAll") })
      );
      estimate.textContent = view.estimate ? estimateText(view.estimate) : view.estimating ? t("batch.estimating") : "";
      const keyMissing = view.server?.model_key_configured === false && (view.estimate?.model_calls ?? 0) > 0;
      hint.hidden = !keyMissing;
      runButton.disabled = busy() || !view.estimate || view.estimating || keyMissing;
      clear(progress);
      const { lock = null, job = null } = slot.state() ?? {};
      if (lock === "starting") progress.append(t("batch.starting"));
      else if (job && (lock === "interrupted" || lock === "resuming")) {
        progress.append(
          h("span", { class: "cqa-sc-failed", text: t("batch.interrupted", { done: job.done, total: job.total }) }),
          h("button", { class: "cqa-sc-btn", attrs: { type: "button", disabled: lock === "resuming" }, text: t("batch.resume"), data: { test: "apply-resume" }, on: { click: () => slot.resume() } })
        );
      } else if (job) {
        progress.append(t(job.running ? "batch.progress" : "batch.done", { done: job.done, total: job.total }));
        if (job.failed > 0) progress.append(h("span", { class: "cqa-sc-failed", text: t("batch.failed", { n: job.failed }) }));
        if (!job.running && job.failed > 0) progress.append(h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("batch.retry"), data: { test: "apply-retry" }, on: { click: () => slot.retry() } }));
        const from = compareFrom(version2);
        if (!job.running && from) {
          const group = view.target === "control" ? view.targets.control.group : view.target === "dev" ? DEV : null;
          const link = href("compare", { from_checklist: from.checklist_id, from_version: from.version, to_checklist: version2.checklist_id, to_version: version2.version, group_id: group });
          progress.append(h("a", { class: ["cqa-sc-btn", "cqa-sc-btn--cta", "cqa-ap-compare"], attrs: { href: link }, text: t("apply.compare"), data: { test: "apply-compare" }, on: { click: () => close() } }));
        }
      }
    }
    async function loadTargets() {
      try {
        const [items, server] = await Promise.all([api.listConversations(), api.getConfig()]);
        if (closed) return;
        const groups = [...new Set(items.map((item) => item.group_id))];
        const group = controlGroup(groups, store.get().groupId);
        const selection = [...store.get().selection ?? []].filter((id) => items.some((item) => item.id === id));
        view.server = server;
        view.targets = {
          control: { group, ids: group ? items.filter((item) => item.group_id === group).map((item) => item.id) : [] },
          dev: { ids: items.filter((item) => item.group_id === DEV).map((item) => item.id) },
          selected: { ids: selection }
        };
      } catch (error) {
        view.error = error;
      }
      paint();
    }
    async function choose(key) {
      if (busy()) return;
      view.target = key;
      view.estimate = null;
      slot.reset();
      view.estimating = true;
      paint();
      const mine = ++estimateRun;
      try {
        const dry = await api.startEvaluations({ conversations: view.targets[key].ids, checklist_id: version2.checklist_id, version: version2.version, dry_run: true });
        if (closed || mine !== estimateRun) return;
        view.estimate = dry;
      } catch (error) {
        if (closed || mine !== estimateRun) return;
        toastError(store, error, { retry: () => choose(key) });
      }
      view.estimating = false;
      paint();
    }
    function run() {
      if (busy() || !view.target) return void 0;
      const ids = view.targets[view.target].ids;
      return slot.start(() => api.startEvaluations({ conversations: ids, checklist_id: version2.checklist_id, version: version2.version, mode: "reuse" }), { again: run, meta: { target: view.target } });
    }
    const panel = h(
      "aside",
      { class: "cqa-drawer", attrs: { role: "dialog", "aria-modal": "true", "aria-label": t("apply.title") } },
      h("div", { class: "cqa-drawer-head" }, h("h2", { class: "cqa-drawer-title", text: t("apply.title") }), h("p", { class: "cqa-rv-hint", text: t("apply.what", { name: version2.name, version: version2.version }) })),
      body,
      estimate,
      hint,
      h("div", { class: "cqa-rv-acts" }, closeButton, runButton),
      progress
    );
    const scrim = h("button", { class: "cqa-drawer-scrim", attrs: { type: "button", tabindex: "-1", "aria-label": t("apply.close") }, on: { click: () => close() } });
    const el = h(
      "div",
      {
        class: "cqa-drawer-wrap",
        data: { test: "apply-dialog" },
        on: {
          keydown: (event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }
        }
      },
      scrim,
      panel
    );
    function close() {
      if (closed) return;
      closed = true;
      stopSlot();
      el.remove();
    }
    const stopSlot = slot.watch(() => paint());
    paint();
    host.append(el);
    loadTargets();
    return { el, close };
  }

  // src/ui/checklists-page.js
  var NEW_ID = "new";
  var versionsOf3 = (row) => Array.isArray(row.versions) && row.versions.length > 0 ? row.versions.map((v) => v.version) : [row.version];
  var weightSum = (row) => (row.criteria ?? []).filter((c) => c.kind !== "gross_error").reduce((acc, c) => acc + (Number(c.weight) || 0), 0);
  function createChecklistsPage(store, api) {
    let destroyed = false;
    const list = h("ul", { class: "cqa-ck-list", attrs: { "aria-label": t("nav.checklists") }, data: { test: "checklists-list" } });
    const state = h("div", { class: "cqa-aps-state" });
    const el = h(
      "section",
      { class: ["cqa-view", "cqa-ck"], data: { test: "checklists-page" } },
      h(
        "div",
        { class: "cqa-ck-head" },
        h("h1", { class: "cqa-view-title", text: t("nav.checklists") }),
        h("a", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { href: href("editor", { checklistId: NEW_ID, version: 0 }) }, text: t("checklists.create"), data: { test: "checklist-create" } })
      ),
      h("p", { class: "cqa-view-note", text: t("checklists.note") }),
      state,
      list
    );
    async function copy(row, button) {
      button.disabled = true;
      try {
        const created = await api.createChecklist({ based_on: { checklist_id: row.checklist_id, version: row.version } });
        if (destroyed) return;
        window.location.hash = href("editor", { checklistId: created.checklist_id, version: created.version });
      } catch (error) {
        button.disabled = false;
        toastError(store, error);
      }
    }
    function rowOf(row, rows) {
      const source = row.based_on ? rows.find((r) => r.checklist_id === row.based_on.checklist_id) : null;
      const count = (row.criteria ?? []).length;
      const copyButton = h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("checklists.copy"), data: { test: "checklist-copy" } });
      copyButton.addEventListener("click", () => copy(row, copyButton));
      return h(
        "li",
        { class: "cqa-ck-row", data: { test: "checklist-row", id: row.checklist_id } },
        h(
          "div",
          { class: "cqa-ck-main" },
          h(
            "div",
            { class: "cqa-aps-row1" },
            h("b", { class: "cqa-ck-name", text: row.name ?? row.checklist_id }),
            h("span", { class: "cqa-ck-tags" }, row.locked ? h("span", { class: ["cqa-tag", "cqa-tag--na"], text: t("checklists.locked"), data: { test: "checklist-locked" } }) : null, h("span", { class: ["cqa-tag", "cqa-tag--out"], text: t(`checklists.channel.${row.channel ?? "any"}`) }))
          ),
          h("span", { class: "cqa-ck-meta", text: [t("checklists.version", { version: row.version, count: versionsOf3(row).length }), tp("checklists.criteria", count), t("checklists.weights", { sum: weightSum(row) })].join(" \xB7 ") }),
          row.based_on ? h("span", { class: "cqa-ck-based", text: t("checklists.basedOn", { name: source?.name ?? row.based_on.checklist_id, version: row.based_on.version }), data: { test: "checklist-based-on" } }) : null
        ),
        h(
          "div",
          { class: "cqa-ck-acts" },
          h("a", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { href: href("editor", { checklistId: row.checklist_id, version: row.version }) }, text: t("checklists.open"), data: { test: "checklist-open" } }),
          copyButton
        )
      );
    }
    async function load2() {
      clear(state).append(h("div", { class: "cqa-empty", attrs: { role: "status" } }, h("b", { class: "cqa-empty-title", text: t("checklists.loading") })));
      try {
        const rows = await api.listChecklists();
        if (destroyed) return;
        clear(state);
        list.replaceChildren(...rows.map((row) => rowOf(row, rows)));
      } catch (error) {
        if (destroyed) return;
        clear(state).append(
          h("div", { class: "cqa-empty", attrs: { role: "status" } }, h("b", { class: "cqa-empty-title", text: t("checklists.loadFailed") }), h("p", { class: "cqa-empty-note", text: errorText(error) })),
          h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("appeals.retry"), on: { click: load2 } })
        );
      }
    }
    load2();
    return {
      el,
      destroy() {
        destroyed = true;
      }
    };
  }

  // src/ui/checklist-editor.js
  var CHANNELS2 = ["any", "chat", "call"];
  var keyOf = (route2) => `${route2.params.checklistId}@${route2.params.version}`;
  function createChecklistEditor(store, api, route2) {
    const view = { route: route2, source: null, draft: null, models: [], phase: "loading", error: null, saving: false, savedFor: null };
    let keySeq = 0;
    let destroyed = false;
    let apply = null;
    let loadRun = 0;
    let refs = null;
    const el = h("section", { class: ["cqa-view", "cqa-ed"], data: { test: "editor" } });
    const params = () => ({ id: view.route.params.checklistId, version: Number(view.route.params.version) });
    const isNew = () => params().id === NEW_ID;
    const withKey = (c) => ({ ...c, _key: `k${keySeq += 1}` });
    function newCriterion(sectionId) {
      return withKey({ id: void 0, section_id: sectionId, title: "", wording: "", answer_type: "yes_no", scale_steps: [], weight: 0, na_allowed: false, na_condition: null, kind: "scored", kinds: [], guidance: null });
    }
    function toDraft(source) {
      const draft = structuredClone(source);
      if (source.locked) draft.name = t("editor.copyName", { name: source.name });
      draft.criteria = draft.criteria.map(withKey);
      return draft;
    }
    function blankDraft() {
      return { name: t("editor.newName"), description: null, channel: "any", guidance: "", rounding: 2, sections: [{ id: "s1", title: t("editor.newSection"), order: 1 }], criteria: [newCriterion("s1")] };
    }
    async function load2() {
      const mine = ++loadRun;
      view.phase = "loading";
      draw();
      try {
        const config = await api.getConfig().catch(() => null);
        const source = isNew() ? null : await api.getChecklistVersion(params().id, params().version);
        if (destroyed || mine !== loadRun) return;
        view.models = Array.isArray(config?.models) ? config.models : [];
        view.source = source;
        view.draft = source ? toDraft(source) : blankDraft();
        view.phase = "ready";
      } catch (error) {
        if (destroyed || mine !== loadRun) return;
        view.phase = "error";
        view.error = error;
      }
      draw();
    }
    const sections = () => [...view.draft.sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    function addCriterion(sectionId) {
      const list = view.draft.criteria;
      const last = list.map((c) => c.section_id).lastIndexOf(sectionId);
      const fresh = newCriterion(sectionId);
      list.splice(last < 0 ? list.length : last + 1, 0, fresh);
      draw();
      el.querySelector(`[data-key="${fresh._key}"] [data-test="crit-title"]`)?.focus();
    }
    function moveCriterion(c, sectionId) {
      const list = view.draft.criteria;
      list.splice(list.indexOf(c), 1);
      c.section_id = sectionId;
      const last = list.map((x) => x.section_id).lastIndexOf(sectionId);
      list.splice(last < 0 ? list.length : last + 1, 0, c);
      draw();
    }
    function addSection() {
      const ids = new Set(view.draft.sections.map((s) => s.id));
      let n = view.draft.sections.length + 1;
      while (ids.has(`s${n}`)) n += 1;
      const order = Math.max(0, ...view.draft.sections.map((s) => s.order ?? 0)) + 1;
      view.draft.sections.push({ id: `s${n}`, title: t("editor.newSection"), order });
      draw();
    }
    function restore(id) {
      const original = view.source?.criteria.find((c) => c.id === id);
      if (!original) return;
      if (!view.draft.sections.some((s) => s.id === original.section_id)) view.draft.sections.push(structuredClone(view.source.sections.find((s) => s.id === original.section_id)));
      view.draft.criteria.push(withKey(structuredClone(original)));
      draw();
    }
    function field(labelKey, control, error) {
      return h("label", { class: "cqa-rv-field" }, h("span", { class: "cqa-rv-label", text: t(labelKey) }), control, error ?? null);
    }
    function errorEl() {
      const e = h("p", { class: "cqa-ed-err", attrs: { role: "alert" }, data: { test: "field-error" } });
      e.hidden = true;
      return e;
    }
    function input(value, test, onInput, attrs = {}) {
      const control = h("input", { class: "cqa-sc-select", attrs: { type: "text", autocomplete: "off", ...attrs }, data: { test }, on: { input: () => onInput(control.value) } });
      control.value = value === null || value === void 0 ? "" : String(value);
      return control;
    }
    function textarea(value, test, onInput, rows = 2) {
      const control = h("textarea", { class: "cqa-ap-text", attrs: { rows: String(rows) }, data: { test }, on: { input: () => onInput(control.value) } });
      control.value = value ?? "";
      return control;
    }
    function select(value, test, options, onChange, label) {
      const control = h(
        "select",
        { class: "cqa-sc-select", attrs: { "aria-label": label }, data: { test }, on: { change: () => onChange(control.value) } },
        options.map(([v, text3]) => h("option", { attrs: { value: v }, text: text3 }))
      );
      control.value = value;
      return control;
    }
    function cardOf(c) {
      const errs = /* @__PURE__ */ new Map();
      const err = (name) => {
        const e = errorEl();
        errs.set(name, e);
        return e;
      };
      const live = (name) => (value) => {
        c[name] = value;
        refresh();
      };
      const gross = c.kind === "gross_error";
      const badge = h("span", { class: "cqa-tag", data: { test: "criterion-badge" } });
      const steps = c.answer_type === "scale" ? h(
        "div",
        { class: "cqa-ed-steps", data: { test: "crit-steps" } },
        h("span", { class: "cqa-rv-label", text: t("editor.steps") }),
        ...c.scale_steps.map(
          (step, i) => h(
            "div",
            { class: "cqa-ed-step" },
            input(step.value, "step-value", (v) => (step.value = v, refresh()), { inputmode: "decimal", "aria-label": t("editor.stepValue"), class: "cqa-sc-select cqa-ed-step-value" }),
            input(step.label, "step-label", (v) => (step.label = v, refresh()), { "aria-label": t("editor.stepLabel") }),
            h("button", { class: "cqa-sc-btn", attrs: { type: "button", "aria-label": t("editor.removeStep") }, text: "\u2715", data: { test: "remove-step" }, on: { click: () => (c.scale_steps.splice(i, 1), draw()) } })
          )
        ),
        err("scale_steps"),
        h("button", { class: ["cqa-link", "cqa-ed-add"], attrs: { type: "button" }, text: t("editor.addStep"), data: { test: "add-step" }, on: { click: () => (c.scale_steps.push({ value: "", label: "" }), draw()) } })
      ) : null;
      const naBox = h("input", {
        class: "cqa-q-check",
        attrs: { type: "checkbox" },
        data: { test: "crit-na" },
        on: {
          change: () => {
            c.na_allowed = naBox.checked;
            draw();
          }
        }
      });
      naBox.checked = c.na_allowed === true;
      const card = h(
        "article",
        { class: "cqa-ed-crit", data: { test: "editor-criterion", id: c.id ?? "", key: c._key, new: c.id ? null : "true" } },
        h(
          "div",
          { class: "cqa-ed-crit-head" },
          badge,
          h("span", { class: "cqa-ed-crit-id", text: c.id ?? "" }),
          h("button", { class: ["cqa-sc-btn", "cqa-ed-remove"], attrs: { type: "button" }, text: t("editor.removeCriterion"), data: { test: "remove-criterion" }, on: { click: () => (view.draft.criteria.splice(view.draft.criteria.indexOf(c), 1), draw()) } })
        ),
        field("editor.critTitle", input(c.title, "crit-title", live("title")), err("title")),
        field("editor.wording", textarea(c.wording, "crit-wording", live("wording"))),
        h(
          "div",
          { class: "cqa-ed-grid" },
          field(
            "editor.type",
            select(c.answer_type, "crit-type", [["yes_no", t("editor.type.yes_no")], ["scale", t("editor.type.scale")]], (v) => {
              c.answer_type = v;
              if (v === "scale" && c.scale_steps.length === 0) c.scale_steps = [{ value: 0, label: "" }, { value: 10, label: "" }];
              draw();
            }, t("editor.type"))
          ),
          field("editor.kind", select(c.kind, "crit-kind", [["scored", t("editor.kind.scored")], ["gross_error", t("editor.kind.gross_error")]], (v) => (c.kind = v, draw()), t("editor.kind"))),
          gross ? null : field("editor.weight", input(c.weight, "crit-weight", live("weight"), { inputmode: "decimal" }), err("weight")),
          field("editor.section", select(c.section_id, "crit-section", sections().map((s) => [s.id, s.title || s.id]), (v) => moveCriterion(c, v), t("editor.section")), err("section_id"))
        ),
        steps,
        h("label", { class: "cqa-q-all" }, naBox, h("span", { text: t("editor.naAllowed") })),
        c.na_allowed ? field("editor.naCondition", input(c.na_condition, "crit-na-condition", live("na_condition")), err("na_condition")) : null,
        gross ? field("editor.kinds", input((c.kinds ?? []).join(", "), "crit-kinds", (v) => (c.kinds = v.split(","), refresh()))) : null,
        h(
          "details",
          { class: "cqa-ed-more" },
          h("summary", { text: t("editor.more") }),
          field("editor.guidance", textarea(c.guidance, "crit-guidance", live("guidance"), 3)),
          view.models.length > 0 ? field("editor.model", select(c.model ?? "", "crit-model", [["", t("editor.modelDefault")], ...view.models.map((m) => [m, m])], (v) => (c.model = v === "" ? void 0 : v, refresh()), t("editor.model"))) : null
        )
      );
      refs.cards.set(c._key, { badge, errs });
      return card;
    }
    function sectionOf(section, count) {
      const items = view.draft.criteria.filter((c) => c.section_id === section.id).map(cardOf);
      const title = input(section.title, "section-title", (v) => (section.title = v, refresh()), { "aria-label": t("editor.sectionTitle"), class: "cqa-sc-select cqa-ed-section-title" });
      return h(
        "div",
        { class: "cqa-ed-section", data: { test: "editor-section", id: section.id } },
        h(
          "div",
          { class: "cqa-ed-section-head" },
          title,
          items.length === 0 && count > 1 ? h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("editor.removeSection"), data: { test: "remove-section" }, on: { click: () => (view.draft.sections.splice(view.draft.sections.indexOf(section), 1), draw()) } }) : null
        ),
        ...items,
        h("button", { class: ["cqa-sc-btn", "cqa-ed-add"], attrs: { type: "button" }, text: t("editor.addCriterion"), data: { test: "add-criterion" }, on: { click: () => addCriterion(section.id) } })
      );
    }
    function draw() {
      if (destroyed) return;
      clear(el);
      refs = { cards: /* @__PURE__ */ new Map() };
      if (view.phase !== "ready") {
        el.append(
          h(
            "div",
            { class: "cqa-empty", attrs: { role: "status" } },
            h("b", { class: "cqa-empty-title", text: t(view.phase === "error" ? "editor.loadFailed" : "editor.loading") }),
            view.phase === "error" ? h("p", { class: "cqa-empty-note", text: errorText(view.error) }) : null
          )
        );
        return;
      }
      const { source, draft } = view;
      const head = h(
        "div",
        { class: "cqa-ck-head" },
        h("h1", { class: "cqa-view-title", text: isNew() ? t("editor.titleNew") : source.name }),
        !isNew() ? h("button", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { type: "button" }, text: t("editor.apply"), data: { test: "open-apply" }, on: { click: () => openApply() } }) : null
      );
      const meta = isNew() ? h("p", { class: "cqa-view-note", text: t("editor.newNote") }) : h(
        "p",
        { class: "cqa-ed-meta" },
        h("span", { class: ["cqa-tag", "cqa-tag--out"], text: `v${source.version}` }),
        source.locked ? h("span", { class: ["cqa-tag", "cqa-tag--na"], text: t("checklists.locked") }) : null,
        h("span", { class: "cqa-rv-hint", text: source.locked ? t("editor.lockedNote") : t("editor.versionNote") }),
        h("a", { class: "cqa-link", attrs: { href: href("checklists") }, text: t("editor.back") })
      );
      const saved = view.savedFor === keyOf(view.route) ? h("p", { class: "cqa-ld-summary", attrs: { role: "status" }, text: t("editor.saved", { name: source?.name ?? "", version: source?.version ?? "" }), data: { test: "editor-saved" } }) : null;
      refs.nameError = errorEl();
      refs.global = errorEl();
      const form = h(
        "div",
        { class: "cqa-ed-top" },
        field("editor.name", input(draft.name, "editor-name", (v) => (draft.name = v, refresh())), refs.nameError),
        field("editor.channel", select(draft.channel ?? "any", "editor-channel", CHANNELS2.map((c) => [c, t(`checklists.channel.${c}`)]), (v) => (draft.channel = v, refresh()), t("editor.channel")))
      );
      const list = sections();
      refs.removed = h("div", { class: "cqa-ed-removed-host" });
      refs.sum = h("div", { class: "cqa-ed-sum-host" });
      refs.diff = h("p", { class: "cqa-ed-diff", data: { test: "editor-diff" } });
      refs.count = h("p", { class: "cqa-ed-err" });
      refs.save = h("button", { class: ["cqa-sc-btn", "cqa-sc-btn--cta"], attrs: { type: "button" }, data: { test: "editor-save" }, on: { click: () => save() } });
      el.append(
        head,
        meta,
        saved ?? "",
        form,
        ...list.map((s) => sectionOf(s, list.length)),
        h("button", { class: ["cqa-sc-btn", "cqa-ed-add"], attrs: { type: "button" }, text: t("editor.addSection"), data: { test: "add-section" }, on: { click: () => addSection() } }),
        refs.removed,
        refs.global,
        h("div", { class: "cqa-ed-foot" }, refs.sum, refs.diff, refs.count, refs.save)
      );
      refresh();
    }
    function refresh() {
      if (!refs || view.phase !== "ready") return;
      const { draft, source } = view;
      const { errors, warnings } = validateChecklist(draft);
      const diff2 = diffVersions(source, draft);
      const known = new Set((source?.criteria ?? []).map((c) => c.id));
      const reworded = new Set(diff2.reworded);
      const weightOnly = new Set(diff2.weightOnly);
      for (const c of draft.criteria) {
        const ref = refs.cards.get(c._key);
        if (!ref) continue;
        const kind = !c.id || !known.has(c.id) ? "new" : reworded.has(c.id) ? "reworded" : weightOnly.has(c.id) ? "weight" : null;
        ref.badge.hidden = kind === null;
        ref.badge.textContent = kind ? t(`editor.badge.${kind}`) : "";
        ref.badge.className = `cqa-tag ${kind === "new" ? "cqa-tag--ok" : kind === "reworded" ? "cqa-tag--mid" : "cqa-tag--out"}`;
        for (const e of ref.errs.values()) e.hidden = true;
      }
      refs.nameError.hidden = true;
      refs.global.hidden = true;
      for (const { path, code } of errors) {
        const message = t(`editor.error.${code}`);
        const match = /^criteria\.(\d+)\.(\w+)$/.exec(path);
        const target = match ? refs.cards.get(draft.criteria[Number(match[1])]?._key)?.errs.get(match[2]) : path === "name" ? refs.nameError : refs.global;
        if (!target) continue;
        target.textContent = message;
        target.hidden = false;
      }
      const sum = warnings.find((w) => w.code === "weight_sum");
      refs.sum.replaceChildren(sum ? h("p", { class: "cqa-ed-warn", attrs: { role: "status" }, text: t("editor.weightSum", { sum: String(sum.sum).replace(".", ",") }), data: { test: "weight-sum" } }) : "");
      const removed = diff2.removed.map((id) => source.criteria.find((c) => c.id === id)).filter(Boolean);
      refs.removed.replaceChildren(
        removed.length > 0 ? h(
          "div",
          { class: "cqa-ed-removed", data: { test: "removed-list" } },
          h("span", { class: "cqa-rv-label", text: t("editor.removed") }),
          ...removed.map(
            (c) => h(
              "span",
              { class: "cqa-ed-removed-item" },
              h("span", { class: ["cqa-tag", "cqa-tag--bad"], text: c.title }),
              h("button", { class: ["cqa-link", "cqa-ed-add"], attrs: { type: "button" }, text: t("editor.restore"), data: { test: "restore-criterion" }, on: { click: () => restore(c.id) } })
            )
          )
        ) : ""
      );
      refs.diff.textContent = t("editor.diff", { added: diff2.added.length, removed: diff2.removed.length, reworded: diff2.reworded.length, weight: diff2.weightOnly.length });
      refs.count.textContent = errors.length > 0 ? t("editor.errorCount", { n: errors.length }) : "";
      refs.count.hidden = errors.length === 0;
      refs.save.textContent = t(isNew() ? "editor.create" : source.locked ? "editor.saveAsNew" : "editor.saveVersion");
      refs.save.disabled = view.saving || errors.length > 0;
    }
    async function save() {
      const { value, errors } = validateChecklist(view.draft);
      if (errors.length > 0 || view.saving) return;
      view.saving = true;
      refresh();
      const body = {
        name: String(value.name).trim(),
        description: value.description ?? null,
        channel: value.channel ?? "any",
        guidance: typeof value.guidance === "string" ? value.guidance : "",
        rounding: Number.isInteger(value.rounding) ? value.rounding : 2,
        sections: value.sections.map((s) => ({ id: s.id, title: s.title, order: s.order })),
        criteria: value.criteria.map(({ _key, fingerprint: fingerprint2, ...rest }, i) => ({ ...rest, order: i + 1 }))
      };
      try {
        const saved = isNew() ? await api.createChecklist(body) : view.source.locked ? await api.createChecklist({ ...body, based_on: { checklist_id: view.source.checklist_id, version: view.source.version } }) : await api.saveChecklistVersion(view.source.checklist_id, body);
        if (destroyed) return;
        view.saving = false;
        view.savedFor = `${saved.checklist_id}@${saved.version}`;
        window.location.hash = href("editor", { checklistId: saved.checklist_id, version: saved.version });
      } catch (error) {
        if (destroyed) return;
        view.saving = false;
        refresh();
        toastError(store, error, { retry: save });
      }
    }
    function openApply() {
      if (!view.source) return;
      apply?.close();
      apply = openApplyDialog({ host: el.closest(".cqa") ?? el, store, api, version: view.source });
    }
    load2();
    return {
      el,
      update(next) {
        if (keyOf(next) === keyOf(view.route) && next.name === view.route.name) return;
        const reload = keyOf(next) !== keyOf(view.route);
        view.route = next;
        if (reload) load2();
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        apply?.close();
      }
    };
  }

  // src/ui/compare-page.js
  var DEFAULT_SORT = { key: "delta", dir: "asc" };
  var COLUMNS = ["id", "group", "old", "new", "delta"];
  var money2 = (value) => typeof value === "number" && Number.isFinite(value) ? fmt2(rat(value)) : "\u2014";
  function signedText(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "\u2014";
    const text3 = fmt2(rat(value));
    if (text3 === "0.00") return text3;
    return text3.startsWith("-") ? `\u2212${text3.slice(1)}` : `+${text3}`;
  }
  function summaryText2(summary) {
    return t("compare.summary", {
      changed: summary.changed,
      of: tp("compare.ofDialogs", summary.total),
      verb: tp("compare.changedVerb", summary.changed),
      avg: signedText(summary.avg_delta)
    });
  }
  var VALUE = {
    id: (row) => String(row.conversation_id ?? row.conversation ?? ""),
    group: (row) => String(row.group_id ?? ""),
    old: (row) => row.old_total,
    new: (row) => row.new_total,
    delta: (row) => row.delta
  };
  var isNumber = (value) => typeof value === "number" && Number.isFinite(value);
  function sortRows(rows, { key, dir }) {
    const value = VALUE[key] ?? VALUE.delta;
    const sign = dir === "desc" ? -1 : 1;
    const byId = (a, b) => VALUE.id(a).localeCompare(VALUE.id(b), "ru", { numeric: true });
    return [...rows].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      if (key === "id" || key === "group") return sign * String(x).localeCompare(String(y), "ru", { numeric: true }) || byId(a, b);
      if (!isNumber(x) || !isNumber(y)) return (isNumber(x) ? 0 : 1) - (isNumber(y) ? 0 : 1) || byId(a, b);
      return sign * (x - y) || byId(a, b);
    });
  }
  function sideRows(fromVersion, toVersion, oldEvaluation, newEvaluation) {
    const resultsOf = (evaluation) => new Map((evaluation?.results ?? []).map((r) => [r.criterion_id, r]));
    const oldResults = resultsOf(oldEvaluation);
    const newResults = resultsOf(newEvaluation);
    const oldCriteria = new Map((fromVersion?.criteria ?? []).map((c) => [c.id, c]));
    const newIds = new Set((toVersion?.criteria ?? []).map((c) => c.id));
    const row = (id, oldCriterion, newCriterion) => {
      const side = oldCriterion && newCriterion ? "both" : oldCriterion ? "old" : "new";
      const oldResult = oldCriterion ? oldResults.get(id) ?? null : null;
      const newResult = newCriterion ? newResults.get(id) ?? null : null;
      const reworded = side === "both" && Boolean(oldCriterion.fingerprint && newCriterion.fingerprint) && oldCriterion.fingerprint !== newCriterion.fingerprint;
      const same3 = side === "both" && !reworded && oldResult !== null && newResult !== null && canonicalJson(oldResult.final_answer ?? null) === canonicalJson(newResult.final_answer ?? null) && (oldResult.points ?? null) === (newResult.points ?? null);
      return { id, side, oldCriterion: oldCriterion ?? null, newCriterion: newCriterion ?? null, oldResult, newResult, reworded, changed: !same3 };
    };
    return [
      ...(toVersion?.criteria ?? []).map((c) => row(c.id, oldCriteria.get(c.id), c)),
      ...(fromVersion?.criteria ?? []).filter((c) => !newIds.has(c.id)).map((c) => row(c.id, c, null))
    ];
  }
  var pickEvaluation = (evaluations, ref) => evaluations.find((e) => e.status === "done" && e.checklist_id === ref.checklist_id && e.version === ref.version) ?? null;
  var deltaKind = (delta) => !isNumber(delta) || delta === 0 ? "na" : delta < 0 ? "bad" : "ok";
  var versionsOf4 = (row) => Array.isArray(row.versions) && row.versions.length > 0 ? row.versions.map((v) => v.version) : [row.version];
  function createComparePage(store, api, route2) {
    let destroyed = false;
    let params = route2?.params ?? {};
    const view = {
      options: null,
      // [{checklist_id, version, label}] once the checklists are loaded
      groups: [],
      phase: "loading",
      // "loading" | "pick" | "ready" | "error"
      error: null,
      data: null,
      // the comparison
      sort: { ...DEFAULT_SORT },
      open: null,
      // the conversation whose card is shown
      all: false,
      // every criterion on the card, not only the changed ones
      side: null
      // { phase: "loading" | "ready" | "error", rows, error }
    };
    let loadRun = 0;
    let sideRun = 0;
    const versions = /* @__PURE__ */ new Map();
    const ref = (prefix) => {
      const checklist_id = params[`${prefix}_checklist`];
      const version2 = Number(params[`${prefix}_version`]);
      return checklist_id && Number.isInteger(version2) && version2 > 0 ? { checklist_id, version: version2 } : null;
    };
    const fromSelect = h("select", { class: "cqa-sc-select", attrs: { "aria-label": t("compare.from") }, data: { test: "compare-from-select" }, on: { change: () => go() } });
    const toSelect = h("select", { class: "cqa-sc-select", attrs: { "aria-label": t("compare.to") }, data: { test: "compare-to-select" }, on: { change: () => go() } });
    const groupSelect = h("select", { class: "cqa-sc-select", attrs: { "aria-label": t("compare.group") }, data: { test: "compare-group" }, on: { change: () => go() } });
    const fromName = h("span", { class: "cqa-cmp-side-name", data: { test: "compare-from" } });
    const toName = h("span", { class: "cqa-cmp-side-name", data: { test: "compare-to" } });
    const summary = h("p", { class: "cqa-cmp-summary", attrs: { "aria-live": "polite" }, data: { test: "compare-summary" } });
    const state = h("div", { class: "cqa-cmp-state" });
    const table = h("div", { class: "cqa-cmp-table-wrap" });
    const card = h("div", { class: "cqa-cmp-card-host" });
    const field = (label, control) => h("label", { class: "cqa-rv-field" }, h("span", { class: "cqa-rv-label", text: label }), control);
    const el = h(
      "section",
      { class: ["cqa-view", "cqa-cmp"], data: { test: "compare-page" } },
      h("h1", { class: "cqa-view-title", text: t("compare.title") }),
      h("p", { class: "cqa-view-note", text: t("compare.note"), data: { test: "compare-note" } }),
      h("div", { class: "cqa-cmp-pick" }, field(t("compare.from"), fromSelect), field(t("compare.to"), toSelect), field(t("compare.group"), groupSelect)),
      h("p", { class: "cqa-cmp-sides" }, fromName, h("span", { class: "cqa-cmp-arrow", attrs: { "aria-hidden": "true" }, text: "\u2192" }), toName),
      summary,
      state,
      h("div", { class: "cqa-cmp-grid" }, table, card)
    );
    function go() {
      const from = view.options?.[Number(fromSelect.value)];
      const to = view.options?.[Number(toSelect.value)];
      window.location.hash = href("compare", {
        from_checklist: from?.checklist_id,
        from_version: from?.version,
        to_checklist: to?.checklist_id,
        to_version: to?.version,
        group_id: groupSelect.value || void 0
      });
    }
    function fillPickers() {
      const fill = (select, chosen) => {
        clear(select).append(h("option", { attrs: { value: "" }, text: t("compare.choose") }));
        view.options.forEach((o, i) => select.append(h("option", { attrs: { value: i }, text: o.label })));
        const at = chosen ? view.options.findIndex((o) => o.checklist_id === chosen.checklist_id && o.version === chosen.version) : -1;
        select.value = at >= 0 ? String(at) : "";
      };
      fill(fromSelect, ref("from"));
      fill(toSelect, ref("to"));
      const group = params.group_id ?? "";
      const groups = view.groups.includes(group) || group === "" ? view.groups : [...view.groups, group];
      clear(groupSelect).append(h("option", { attrs: { value: "" }, text: t("compare.group.all") }), ...groups.map((g) => h("option", { attrs: { value: g }, text: g })));
      groupSelect.value = group;
    }
    const sideLabel = (side) => {
      if (side && side.name !== void 0) return t("scorecard.checklistOption", { name: side.name || side.checklist_id, version: side.version });
      const option = view.options?.find((o) => o.checklist_id === side?.checklist_id && o.version === side?.version);
      return option?.label ?? "";
    };
    async function boot() {
      try {
        const [rows, items] = await Promise.all([api.listChecklists(), api.listConversations()]);
        if (destroyed) return;
        view.options = rows.flatMap(
          (row) => [...versionsOf4(row)].sort((a, b) => b - a).map((version2) => ({ checklist_id: row.checklist_id, version: version2, label: t("scorecard.checklistOption", { name: row.name ?? row.checklist_id, version: version2 }) }))
        );
        view.groups = [...new Set(items.map((item) => item.group_id).filter((g) => typeof g === "string" && g !== ""))].sort();
        fillPickers();
        paintHead();
      } catch (error) {
        if (!destroyed) toastError(store, error, { retry: boot });
      }
    }
    async function load2() {
      const mine = ++loadRun;
      sideRun += 1;
      const from = ref("from");
      const to = ref("to");
      view.data = null;
      view.open = null;
      view.side = null;
      if (!from || !to) {
        view.phase = "pick";
        paint();
        return;
      }
      view.phase = "loading";
      paint();
      try {
        const data = await api.getComparison({ from_checklist: from.checklist_id, from_version: from.version, to_checklist: to.checklist_id, to_version: to.version, group_id: params.group_id || void 0 });
        if (destroyed || mine !== loadRun) return;
        view.data = data;
        view.phase = "ready";
        view.error = null;
      } catch (error) {
        if (destroyed || mine !== loadRun) return;
        view.phase = "error";
        view.error = error;
      }
      paint();
    }
    async function versionOf(side) {
      const key = `${side.checklist_id}@${side.version}`;
      if (!versions.has(key)) versions.set(key, api.getChecklistVersion(side.checklist_id, side.version));
      try {
        return await versions.get(key);
      } catch (error) {
        versions.delete(key);
        throw error;
      }
    }
    async function openRow(row) {
      const mine = ++sideRun;
      view.open = row.conversation;
      view.side = { phase: "loading", rows: [], error: null, row };
      paint();
      const from = ref("from");
      const to = ref("to");
      try {
        const [fromVersion, toVersion, fromEvals, toEvals] = await Promise.all([
          versionOf(from),
          versionOf(to),
          api.listEvaluations({ conversation: row.conversation, checklist_id: from.checklist_id }),
          from.checklist_id === to.checklist_id ? null : api.listEvaluations({ conversation: row.conversation, checklist_id: to.checklist_id })
        ]);
        if (destroyed || mine !== sideRun) return;
        const rows = sideRows(fromVersion, toVersion, pickEvaluation(fromEvals, from), pickEvaluation(toEvals ?? fromEvals, to));
        view.side = { phase: "ready", rows, error: null, row };
      } catch (error) {
        if (destroyed || mine !== sideRun) return;
        view.side = { phase: "error", rows: [], error, row };
      }
      paintCard();
    }
    function paintHead() {
      const data = view.data;
      fromName.textContent = `${t("compare.from")}: ${data ? sideLabel(data.from) : sideLabel(ref("from"))}`;
      toName.textContent = `${t("compare.to")}: ${data ? sideLabel(data.to) : sideLabel(ref("to"))}`;
    }
    function stateBox3(test, title, note, extra) {
      return h("div", { class: "cqa-empty", attrs: { role: "status" }, data: { test } }, h("b", { class: "cqa-empty-title", text: title }), note ? h("p", { class: "cqa-empty-note", text: note }) : null, extra);
    }
    function paint() {
      if (destroyed) return;
      paintHead();
      clear(state);
      clear(table);
      summary.textContent = "";
      if (view.phase === "pick") state.append(stateBox3("compare-pick", t("compare.pickTitle"), t("compare.pickNote")));
      else if (view.phase === "loading") state.append(stateBox3("compare-loading", t("compare.loading")));
      else if (view.phase === "error") {
        state.append(stateBox3("compare-error", t("compare.loadFailed"), errorText(view.error), h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("compare.retry"), on: { click: () => load2() } })));
      } else if (view.data.rows.length === 0) {
        state.append(stateBox3("compare-empty", t("compare.empty"), t("compare.emptyNote")));
      } else {
        summary.textContent = summaryText2(view.data.summary);
        table.append(buildTable());
      }
      paintCard();
    }
    function buildTable() {
      const head = h(
        "tr",
        {},
        COLUMNS.map((key) => {
          const on = view.sort.key === key;
          return h(
            "th",
            { class: ["cqa-cmp-th", `cqa-cmp-col--${key}`], attrs: { scope: "col", "aria-sort": on ? view.sort.dir === "asc" ? "ascending" : "descending" : "none" } },
            h(
              "button",
              {
                class: ["cqa-cmp-sort", on && "is-on"],
                attrs: { type: "button", title: t("compare.sortBy", { column: t(`compare.col.${key}`) }) },
                data: { test: "compare-sort", key },
                on: { click: () => sortBy(key) }
              },
              h("span", { text: t(`compare.col.${key}`) }),
              h("span", { class: "cqa-cmp-sort-mark", attrs: { "aria-hidden": "true" }, text: on ? view.sort.dir === "asc" ? "\u2191" : "\u2193" : "" })
            )
          );
        })
      );
      const body = sortRows(view.data.rows, view.sort).map((row) => {
        const open = row.conversation === view.open;
        return h(
          "tr",
          {
            class: ["cqa-cmp-row", open && "is-open"],
            data: { test: "compare-row", id: row.conversation, delta: isNumber(row.delta) ? String(row.delta) : "" },
            on: {
              click: (event) => {
                if (event.target instanceof Element && event.target.closest("button, a")) return;
                openRow(row);
              }
            }
          },
          h(
            "td",
            { class: "cqa-cmp-col--id" },
            h("button", { class: "cqa-cmp-open", attrs: { type: "button", "aria-expanded": String(open), title: t("compare.openTitle") }, data: { test: "compare-open" }, on: { click: () => openRow(row) } }, h("b", { text: row.conversation_id ?? row.conversation, data: { test: "compare-id" } }))
          ),
          h("td", { class: "cqa-cmp-col--group", text: row.group_id ?? "" }),
          h("td", { class: ["cqa-cmp-col--old", "num"], text: money2(row.old_total) }),
          h("td", { class: ["cqa-cmp-col--new", "num"], text: money2(row.new_total) }),
          h("td", { class: ["cqa-cmp-col--delta", "num"] }, h("span", { class: ["cqa-tag", `cqa-tag--${deltaKind(row.delta)}`], text: signedText(row.delta), data: { test: "compare-delta" } }))
        );
      });
      return h("table", { class: "cqa-cmp-table", attrs: { "aria-label": t("compare.table") }, data: { test: "compare-table" } }, h("thead", {}, head), h("tbody", {}, body));
    }
    function sortBy(key) {
      view.sort = view.sort.key === key ? { key, dir: view.sort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
      clear(table).append(buildTable());
    }
    function cell(test, criterion, result, present) {
      if (!present) return h("div", { class: ["cqa-cmp-cell", "is-absent"], data: { test } }, h("span", { class: "cqa-cmp-absent", text: t("compare.side.absent") }));
      if (!result) return h("div", { class: "cqa-cmp-cell", data: { test } }, h("span", { class: "cqa-cmp-absent", text: t("compare.side.noResult") }));
      const tag4 = answerTag(criterion, result.final_answer ?? result.answer);
      return h(
        "div",
        { class: "cqa-cmp-cell", data: { test } },
        h("span", { class: ["cqa-tag", `cqa-tag--${tag4.kind}`], text: tag4.text, data: { test: "compare-answer" } }),
        criterion?.kind === "gross_error" ? null : h("span", { class: ["cqa-cmp-points", "num"], text: money2(result.points) })
      );
    }
    function paintCard() {
      clear(card);
      const side = view.side;
      if (!side || !view.data) return;
      const row = side.row;
      const toggle = h("input", { attrs: { type: "checkbox" }, data: { test: "compare-all" }, on: { change: () => {
        view.all = toggle.checked;
        paintCard();
      } } });
      toggle.checked = view.all;
      const parts = [
        h(
          "div",
          { class: "cqa-cmp-card-head" },
          h("b", { class: "cqa-cmp-card-title", text: t("compare.side.title", { id: row.conversation_id ?? row.conversation }) }),
          h("a", { class: "cqa-link", attrs: { href: href("workspace", { id: row.conversation }) }, text: t("compare.side.open"), data: { test: "compare-link" } })
        ),
        h("p", { class: ["cqa-cmp-card-totals", "num"], text: t("compare.side.totals", { old: money2(row.old_total), new: money2(row.new_total), delta: signedText(row.delta) }) }),
        h("label", { class: "cqa-cmp-all" }, toggle, h("span", { text: t("compare.side.all") }))
      ];
      if (side.phase === "loading") parts.push(stateBox3("compare-side-loading", t("compare.side.loading")));
      else if (side.phase === "error") parts.push(stateBox3("compare-side-error", t("compare.side.loadFailed"), errorText(side.error), h("button", { class: "cqa-sc-btn", attrs: { type: "button" }, text: t("compare.retry"), on: { click: () => openRow(row) } })));
      else {
        const shown = side.rows.filter((r) => view.all || r.changed);
        if (shown.length === 0) parts.push(h("p", { class: "cqa-rv-note", text: t("compare.side.none"), data: { test: "compare-side-none" } }));
        else {
          parts.push(
            h("div", { class: ["cqa-cmp-crit", "cqa-cmp-crit--head"], attrs: { "aria-hidden": "true" } }, h("span", {}), h("span", { text: t("compare.from") }), h("span", { text: t("compare.to") })),
            h(
              "ul",
              { class: "cqa-cmp-crits", attrs: { "aria-label": t("compare.side.criteria") } },
              shown.map((r) => {
                const criterion = r.newCriterion ?? r.oldCriterion;
                return h(
                  "li",
                  { class: ["cqa-cmp-crit", r.changed && "is-changed"], data: { test: "compare-crit", id: r.id, side: r.side, changed: String(r.changed) } },
                  h(
                    "div",
                    { class: "cqa-cmp-crit-name" },
                    h("span", { text: criterion.title ?? r.id }),
                    r.side === "old" ? h("span", { class: ["cqa-tag", "cqa-tag--out"], text: t("compare.side.onlyOld") }) : null,
                    r.side === "new" ? h("span", { class: ["cqa-tag", "cqa-tag--out"], text: t("compare.side.onlyNew") }) : null,
                    r.reworded ? h("span", { class: "cqa-cmp-reworded", text: t("compare.side.reworded", { title: r.oldCriterion.title ?? r.id }) }) : null
                  ),
                  cell("compare-old", r.oldCriterion, r.oldResult, r.side !== "new"),
                  cell("compare-new", r.newCriterion, r.newResult, r.side !== "old")
                );
              })
            )
          );
        }
      }
      card.append(h("section", { class: "cqa-cmp-card", attrs: { "aria-label": t("compare.side.label") }, data: { test: "compare-side" } }, parts));
      for (const tr of table.querySelectorAll("tr[data-id]")) {
        const open = tr.getAttribute("data-id") === view.open;
        tr.classList.toggle("is-open", open);
        tr.querySelector("button")?.setAttribute("aria-expanded", String(open));
      }
    }
    boot();
    load2();
    return {
      el,
      update(next) {
        params = next?.params ?? {};
        if (view.options) fillPickers();
        load2();
      },
      destroy() {
        destroyed = true;
      }
    };
  }

  // src/ui/queue.js
  var IMPORT_ON_EMPTY = "DEV";
  var TOPIC_MAX = 80;
  var FETCH_SLOTS = 4;
  var SERVER_SEARCH_MS = 300;
  var SERVER_SEARCH_MIN = 2;
  var FILTERS2 = ["all", "chats", "calls", "disputed", "new"];
  var MATCHES = {
    all: () => true,
    chats: (item) => item.channel === "agent chat",
    calls: (item) => item.channel === "voice call",
    disputed: (item) => item.status === "disputed",
    new: (item) => item.status === "new"
  };
  function clip3(text3) {
    const line = String(text3 ?? "").trim().replace(/\s+/g, " ");
    return line.length > TOPIC_MAX ? `${line.slice(0, TOPIC_MAX - 1).trimEnd()}\u2026` : line;
  }
  function firstClientLine(conversation) {
    const lines = Array.isArray(conversation?.transcript) ? conversation.transcript : [];
    const line = lines.find((m) => m?.speaker === "client" && typeof m.text === "string" && m.text.trim() !== "");
    return line ? clip3(line.text) : "";
  }
  var topicOf = (item) => typeof item.info?.topic === "string" ? item.info.topic.trim() : "";
  function scoreText(final) {
    const total = final?.total;
    return typeof total === "number" && Number.isFinite(total) ? String(total).replace(".", ",") : "\u2014";
  }
  var tag3 = (kind, text3, extra = {}) => h("span", { class: ["cqa-tag", `cqa-tag--${kind}`], text: text3, ...extra });
  function createQueue(store, api) {
    const subs = [];
    let destroyed = false;
    const view = {
      items: [],
      phase: "loading",
      // "loading" | "importing" | "ready" | "error"
      error: null,
      query: "",
      filter: "all",
      language: "",
      remote: null,
      // { q, ids: Set } from the server's text search
      groups: false,
      // more than one group is loaded: rows then name theirs
      group: store.get().queueGroup ?? ""
      // "" = every group; store `queueGroup`, set by an import
    };
    const rows = /* @__PURE__ */ new Map();
    const firstLines = /* @__PURE__ */ new Map();
    const search = h("input", {
      class: "cqa-q-search-input",
      attrs: { type: "search", placeholder: t("queue.search"), "aria-label": t("queue.searchLabel"), autocomplete: "off", spellcheck: "false" },
      data: { test: "queue-search" }
    });
    const searchBox = h("div", { class: "cqa-q-search" }, icon("search", { size: 16 }), search);
    const pills = FILTERS2.map((name) => {
      const count = h("span", { class: ["cqa-q-count", "num"] });
      const button = h(
        "button",
        { class: "cqa-q-pill", attrs: { type: "button", "aria-pressed": "false" }, data: { test: `queue-filter-${name}` }, on: { click: () => setFilter(name) } },
        h("span", { text: t(`queue.filter.${name}`) }),
        count
      );
      return { name, button, count };
    });
    const pillBar = h("div", { class: "cqa-q-pills", attrs: { role: "group", "aria-label": t("queue.filters") } }, pills.map((pill) => pill.button));
    const language = h("select", {
      class: "cqa-q-select",
      attrs: { "aria-label": t("queue.language") },
      data: { test: "queue-language" },
      on: {
        change: () => {
          view.language = language.value;
          paint();
        }
      }
    });
    const groupSelect = h("select", {
      class: "cqa-q-select",
      attrs: { "aria-label": t("queue.groupFilter") },
      data: { test: "queue-group-filter" },
      on: { change: () => store.set({ queueGroup: groupSelect.value }) }
    });
    const selectAll = h("input", {
      class: "cqa-q-check",
      attrs: { type: "checkbox", "aria-label": t("queue.selectAll") },
      data: { test: "queue-select-all" },
      on: { change: () => toggleAllShown() }
    });
    const loadButton = h("button", {
      class: ["cqa-sc-btn", "cqa-q-load"],
      attrs: { type: "button", title: t("queue.loadTitle") },
      text: t("queue.load"),
      data: { test: "open-loader" },
      on: { click: () => openLoaderDrawer() }
    });
    const summary = h("p", { class: "cqa-q-summary", attrs: { "aria-live": "polite" }, data: { test: "queue-count" } });
    const exportLink = h("a", {
      class: "cqa-q-export",
      attrs: { href: "#", download: "cqa-all.csv", title: t("queue.export"), "aria-label": t("queue.export") },
      data: { test: "queue-export" },
      on: {
        click: (event) => {
          try {
            exportLink.href = api.exportCsvUrl(view.group);
            exportLink.download = `cqa-${view.group ? view.group.replace(/[^A-Za-z0-9._-]/g, "_") : "all"}.csv`;
          } catch (error) {
            event.preventDefault();
            toastError(store, error);
          }
        }
      }
    }, icon("download", { size: 16 }));
    const list = h("ul", { class: "cqa-q-list", attrs: { "aria-label": t("queue.list") }, data: { test: "queue-list" } });
    const stateBox3 = h("div", { class: "cqa-q-state", data: { test: "queue-state" } });
    const body = h("div", { class: "cqa-q-body" }, stateBox3, list);
    const batch = createBatchBar(store, api);
    const controls = h(
      "div",
      { class: "cqa-q-controls" },
      pillBar,
      h("div", { class: "cqa-q-sub" }, groupSelect, language),
      h("div", { class: "cqa-q-sub" }, h("label", { class: "cqa-q-all" }, selectAll, summary), exportLink)
    );
    const top = h("div", { class: "cqa-q-top" }, searchBox, loadButton);
    const el = h("div", { class: "cqa-q", data: { test: "queue" } }, top, controls, body, batch.el);
    let loader = null;
    function openLoaderDrawer() {
      loader?.close();
      loader = openImport(store, api, el.closest(".cqa") ?? el);
    }
    const shownItems = () => view.items.filter((item) => (view.group === "" || item.group_id === view.group) && (view.language === "" || item.language === view.language) && matchesQuery(item, queryText()) && MATCHES[view.filter](item));
    function toggleAllShown() {
      const shown = shownItems().map((item) => item.id);
      const next = new Set(store.get().selection ?? []);
      const all = shown.length > 0 && shown.every((id) => next.has(id));
      for (const id of shown) {
        if (all) next.delete(id);
        else next.add(id);
      }
      store.set({ selection: next });
    }
    function paintSelectAll(shown) {
      const picked = store.get().selection ?? /* @__PURE__ */ new Set();
      const on = shown.filter((item) => picked.has(item.id)).length;
      selectAll.checked = shown.length > 0 && on === shown.length;
      selectAll.indeterminate = on > 0 && on < shown.length;
      selectAll.disabled = shown.length === 0;
    }
    function paintGroups() {
      const groups = [...new Set(view.items.map((item) => item.group_id).filter((g) => typeof g === "string" && g !== ""))].sort();
      if (view.group !== "" && !groups.includes(view.group)) {
        view.group = "";
        if ((store.get().queueGroup ?? "") !== "") store.set({ queueGroup: "" });
      }
      groupSelect.replaceChildren(h("option", { attrs: { value: "" }, text: t("queue.group.all") }), ...groups.map((g) => h("option", { attrs: { value: g }, text: g })));
      groupSelect.value = view.group;
      groupSelect.hidden = groups.length < 2;
    }
    const queryText = () => view.query.trim().toLowerCase();
    function matchesQuery(item, q) {
      if (q === "") return true;
      if (view.remote && view.remote.q === q && view.remote.ids.has(item.id)) return true;
      const haystack = [item.id, item.conversation_id, topicOf(item), firstLines.get(item.id) ?? ""];
      return haystack.some((text3) => text3.toLowerCase().includes(q));
    }
    function setFilter(name) {
      if (view.filter === name) return;
      view.filter = name;
      paint();
    }
    let searchTimer = null;
    let searchRun = 0;
    function scheduleServerSearch() {
      clearTimeout(searchTimer);
      searchRun += 1;
      const q = queryText();
      if (q.length < SERVER_SEARCH_MIN) {
        view.remote = null;
        return;
      }
      const run = searchRun;
      searchTimer = setTimeout(async () => {
        try {
          const found = await api.listConversations({ q: view.query.trim() });
          if (destroyed || run !== searchRun) return;
          view.remote = { q, ids: new Set(found.map((item) => item.id)) };
          paint();
        } catch {
        }
      }, SERVER_SEARCH_MS);
    }
    search.addEventListener("input", () => {
      view.query = search.value;
      scheduleServerSearch();
      paint();
    });
    const currentId = () => {
      const route2 = store.get().route;
      return route2?.name === "workspace" ? route2.params?.id ?? null : null;
    };
    function closeDrawer() {
      if (store.get().queueOpen) store.set({ queueOpen: false });
    }
    function go(id) {
      closeDrawer();
      window.location.hash = href("workspace", { id });
    }
    function togglePick(id, on) {
      const next = new Set(store.get().selection ?? []);
      if (on) next.add(id);
      else next.delete(id);
      store.set({ selection: next });
    }
    function buildRow(item) {
      const flags = item.final;
      const tags = [];
      if (flags?.open_appeals > 0) tags.push(tag3("mid", flags.open_appeals > 1 ? t("queue.tag.appeals", { n: flags.open_appeals }) : t("queue.tag.appeal"), { data: { test: "queue-tag-appeal" } }));
      if (flags?.gross_error) tags.push(tag3("bad", t("queue.tag.grossError"), { data: { test: "queue-tag-gross" } }));
      if (flags?.needs_review) tags.push(tag3("out", t("queue.tag.needsReview"), { attrs: { title: t("queue.tag.needsReviewTitle") }, data: { test: "queue-tag-review" } }));
      const scoreTitle = flags ? typeof flags.total === "number" ? null : t("queue.score.notCalculated") : t("queue.score.none");
      const topic = h("span", { class: "cqa-q-topic", data: { test: "queue-topic" } });
      const check = h("input", {
        class: "cqa-q-check",
        attrs: { type: "checkbox", "aria-label": t("queue.select", { id: item.conversation_id }) },
        data: { test: "queue-select" },
        on: { change: () => togglePick(item.id, check.checked) }
      });
      const link = h(
        "a",
        { class: "cqa-q-link", attrs: { href: href("workspace", { id: item.id }) }, on: { click: closeDrawer } },
        h("b", { class: "cqa-q-id", text: item.conversation_id }),
        h("span", { class: ["cqa-q-score", "num", flags && typeof flags.total === "number" ? "" : "is-none"], text: scoreText(flags), attrs: { title: scoreTitle }, data: { test: "queue-score" } }),
        topic,
        h(
          "span",
          { class: "cqa-q-meta" },
          view.groups ? tag3("out", item.group_id, { attrs: { title: t("queue.group", { group: item.group_id }) }, data: { test: "queue-group" } }) : null,
          tag3("out", item.language, { attrs: { title: t("queue.language.title") }, data: { test: "queue-language-tag" } }),
          h("span", { class: "cqa-q-channel", text: t(item.channel === "voice call" ? "queue.channel.call" : "queue.channel.chat") }),
          tags
        )
      );
      const li = h(
        "li",
        {
          class: "cqa-q-item",
          data: { test: "queue-item", id: item.id, channel: item.channel, status: item.status },
          on: {
            click: (event) => {
              if (event.target instanceof Element && event.target.closest("a, label, input")) return;
              go(item.id);
            }
          }
        },
        h("label", { class: "cqa-q-pick" }, check),
        link
      );
      const row = { el: li, topic, check, link, item };
      paintTopic(row);
      paintCurrent(row);
      check.checked = Boolean(store.get().selection?.has(item.id));
      if (topicOf(item) === "") watchForTopic(row);
      return row;
    }
    function paintTopic(row) {
      const topic = topicOf(row.item);
      row.topic.textContent = topic !== "" ? topic : firstLines.get(row.item.id) ?? "";
    }
    function paintCurrent(row) {
      const on = row.item.id === currentId();
      row.el.classList.toggle("is-current", on);
      if (on) row.link.setAttribute("aria-current", "true");
      else row.link.removeAttribute("aria-current");
    }
    const visible = /* @__PURE__ */ new Set();
    const waiting = [];
    const inflight = /* @__PURE__ */ new Set();
    let active = 0;
    function pump() {
      while (!destroyed && active < FETCH_SLOTS && waiting.length > 0) {
        const id = waiting.shift();
        if (!visible.has(id) || firstLines.has(id) || inflight.has(id)) continue;
        active += 1;
        inflight.add(id);
        api.getConversation(id).then(
          (conversation) => {
            if (destroyed) return;
            firstLines.set(id, firstClientLine(conversation));
            const row = rows.get(id);
            if (row) paintTopic(row);
            if (view.query.trim() !== "") paint();
          },
          () => {
          }
        ).finally(() => {
          active -= 1;
          inflight.delete(id);
          pump();
        });
      }
    }
    function want(id) {
      if (firstLines.has(id) || inflight.has(id) || waiting.includes(id)) return;
      waiting.push(id);
      pump();
    }
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute("data-id");
          if (!id) continue;
          if (entry.isIntersecting) {
            visible.add(id);
            want(id);
          } else {
            visible.delete(id);
          }
        }
      },
      { rootMargin: "160px 0px" }
    ) : null;
    function watchForTopic(row) {
      if (observer) {
        observer.observe(row.el);
      } else {
        visible.add(row.item.id);
        want(row.item.id);
      }
    }
    function dropRows() {
      for (const row of rows.values()) observer?.unobserve(row.el);
      rows.clear();
      visible.clear();
      waiting.length = 0;
    }
    function paintState(kind) {
      clear(stateBox3);
      stateBox3.hidden = kind === null;
      if (kind === null) return;
      const notes = {
        loading: [t("queue.loading")],
        importing: [t("queue.importing", { group: IMPORT_ON_EMPTY })],
        error: [t("queue.loadFailed"), errorText(view.error)],
        empty: [t("queue.empty"), t("queue.emptyNote")],
        nomatch: [t("queue.noMatch"), t("queue.noMatchNote")]
      };
      const [title, note] = notes[kind];
      stateBox3.append(
        h(
          "div",
          { class: "cqa-empty", data: { test: `queue-${kind}` } },
          h("b", { class: "cqa-empty-title", text: title }),
          note ? h("p", { class: "cqa-empty-note", text: note }) : null,
          kind === "error" ? h("button", { class: "cqa-q-retry", attrs: { type: "button" }, data: { test: "queue-retry" }, text: t("queue.retry"), on: { click: () => load2() } }) : null
        )
      );
    }
    function paintLanguages() {
      const codes = [...new Set(view.items.map((item) => item.language).filter((code) => typeof code === "string" && code !== ""))].sort();
      if (view.language !== "" && !codes.includes(view.language)) view.language = "";
      language.replaceChildren(
        h("option", { attrs: { value: "" }, text: t("queue.language.all") }),
        ...codes.map((code) => h("option", { attrs: { value: code }, text: code }))
      );
      language.value = view.language;
    }
    function paint() {
      if (destroyed) return;
      const hasItems = view.items.length > 0;
      controls.hidden = !hasItems;
      list.hidden = !hasItems;
      let shown = [];
      if (hasItems) {
        const q = queryText();
        const base = view.items.filter((item) => (view.group === "" || item.group_id === view.group) && (view.language === "" || item.language === view.language) && matchesQuery(item, q));
        for (const pill of pills) {
          pill.count.textContent = String(base.filter(MATCHES[pill.name]).length);
          pill.button.setAttribute("aria-pressed", String(pill.name === view.filter));
          pill.button.classList.toggle("is-on", pill.name === view.filter);
        }
        shown = base.filter(MATCHES[view.filter]);
        list.replaceChildren(
          ...shown.map((item) => {
            let row = rows.get(item.id);
            if (!row) {
              row = buildRow(item);
              rows.set(item.id, row);
            }
            return row.el;
          })
        );
        summary.textContent = t("queue.shown", { shown: shown.length, total: view.items.length });
      } else {
        clear(list);
        summary.textContent = "";
      }
      paintSelectAll(shown);
      if (hasItems) paintState(shown.length === 0 ? "nomatch" : null);
      else paintState(view.phase === "ready" ? "empty" : view.phase);
    }
    let loadRun = 0;
    let imported = false;
    async function load2() {
      const run = ++loadRun;
      const stale = () => destroyed || run !== loadRun;
      if (view.items.length === 0) {
        view.phase = "loading";
        paint();
      }
      try {
        let items = await api.listConversations();
        if (stale()) return;
        if (items.length === 0 && !imported) {
          view.phase = "importing";
          paint();
          await api.importDataset(IMPORT_ON_EMPTY);
          if (stale()) return;
          imported = true;
          items = await api.listConversations();
          if (stale()) return;
        }
        dropRows();
        firstLines.clear();
        view.items = items;
        view.groups = new Set(items.map((item) => item.group_id)).size > 1;
        view.phase = "ready";
        view.error = null;
        view.remote = null;
        paintLanguages();
        paintGroups();
        pruneSelection();
        if (queryText().length >= SERVER_SEARCH_MIN) scheduleServerSearch();
        paint();
      } catch (error) {
        if (stale()) return;
        if (view.items.length > 0) {
          toastError(store, error, { retry: () => load2() });
        } else {
          view.phase = "error";
          view.error = error;
          paint();
        }
      }
    }
    function pruneSelection() {
      const selection = store.get().selection;
      if (!selection || selection.size === 0) return;
      const known = new Set(view.items.map((item) => item.id));
      const kept = [...selection].filter((id) => known.has(id));
      if (kept.length !== selection.size) store.set({ selection: new Set(kept) });
    }
    subs.push(
      watch(store, (state) => state.selection, (selection) => {
        for (const [id, row] of rows) row.check.checked = Boolean(selection?.has(id));
        paint();
      })
    );
    subs.push(watch(store, (state) => state.route, () => rows.forEach(paintCurrent)));
    subs.push(watch(store, (state) => state.queueRefresh, () => load2()));
    subs.push(
      watch(store, (state) => state.queueGroup, (group) => {
        view.group = group ?? "";
        groupSelect.value = view.group;
        paint();
      })
    );
    paint();
    load2();
    return {
      el,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        clearTimeout(searchTimer);
        subs.forEach((off) => off());
        batch.destroy();
        loader?.close();
        observer?.disconnect();
        rows.clear();
      }
    };
  }

  // src/ui/logo.js
  var SHIELD = [
    ["#164734", "M96.9942 0V26.9824C96.9942 97.2299 48.5809 111.542 48.5809 111.542L48.4978 111.565L48.4153 111.542C48.4153 111.542 43.9448 110.221 37.7221 106.411C23.4632 97.6801 0 75.8861 0 26.9824V0H96.9942Z"],
    ["#02B140", "M96.9945 10.687C96.9945 19.6639 89.7167 26.9414 80.7398 26.9416H37.7106V48.467H75.4271V59.154C75.4271 67.7761 68.7078 74.8346 60.2174 75.3744H37.7087V106.402C23.4485 97.6657 8.6014e-05 75.8705 0 26.9826V0H96.9945V10.687Z"]
  ];
  var WORDMARK = [
    [false, "M159.197 39.3053H137.919V51.3461H155.453V63.5845H137.722V84.9022H123.931V27.0669H159.197V39.3053Z"],
    [true, "M187.371 27.0669C192.494 27.0669 196.237 27.4625 198.602 28.4486C201.95 29.8305 204.513 31.8028 206.482 34.7642C208.451 37.7258 209.239 41.0798 209.239 45.2253C209.239 48.3845 208.451 51.5408 207.073 54.5022C205.495 57.4638 203.526 59.6338 200.769 61.0156V61.2135C201.359 62.0018 201.95 62.9911 202.936 64.7655L214.166 84.8991H198.405L188.159 65.3589H181.46V84.8991H167.275V27.0669H187.371ZM181.263 53.1204H187.371C189.737 53.1204 191.507 52.5269 192.691 51.3429C194.07 50.1589 194.661 48.3814 194.661 46.0135C194.661 42.8542 193.479 40.8819 191.313 39.8958C190.132 39.3022 188.358 39.1075 185.993 39.1075H181.263V53.1204Z"],
    [false, "M256.33 39.1075H234.461V49.5686H251.995V61.807H234.461V72.6637H257.513V84.7043H220.276V27.0669H256.33V39.1075Z"],
    [false, "M302.628 39.1075H280.562V49.5686H298.096V61.807H280.562V72.6637H303.812V84.7043H266.574V27.0669H302.628V39.1075Z"],
    [true, "M333.167 27.0669C342.23 27.0669 349.519 29.6327 354.84 34.7642C360.16 39.8958 362.917 46.805 362.917 55.8841C362.917 64.9633 360.16 72.0702 354.84 77.2017C349.519 82.3333 342.23 84.8991 333.167 84.8991H312.677V27.0669H333.167ZM327.055 72.6606H326.857L326.86 72.6637H332.573C337.498 72.6637 341.439 71.2819 344.196 68.3205C346.954 65.3589 348.332 61.2135 348.332 55.8841C348.332 50.5547 346.954 46.4092 344.196 43.4478C341.439 40.6841 337.497 39.1044 332.768 39.1044H327.055V72.6606Z"],
    [true, "M398.242 25.8837C407.108 25.8837 414.2 28.6474 419.916 34.3724C425.628 40.0975 428.388 47.0035 428.388 55.4923C428.388 63.981 425.631 71.2827 419.916 77.0079C414.203 82.7329 407.108 85.6943 398.242 85.6943C389.377 85.6943 382.285 82.7329 376.57 77.0079C370.856 71.2827 368.096 64.1788 368.096 55.4923C368.096 47.0035 370.853 40.0975 376.57 34.3724C382.282 28.8452 389.377 25.8837 398.242 25.8837ZM398.242 38.9136C393.71 38.9136 389.967 40.4933 387.011 43.6495C384.057 46.8057 382.678 50.7564 382.678 55.4923C382.678 60.426 384.057 64.5715 387.011 67.9286C389.967 71.2827 393.71 72.8624 398.242 72.8624C402.774 72.8624 406.518 71.2827 409.473 67.9286C412.428 64.5715 413.807 60.6238 413.807 55.4923C413.807 50.7564 412.428 46.8088 409.473 43.6495C406.518 40.4902 402.774 38.9136 398.242 38.9136Z"],
    [false, "M466.041 60.7244H466.235L477.664 26.9705H497.76V84.6079H483.574V44.525H483.381L472.146 75.3278H460.13L448.895 44.525H448.7V84.6079H434.515V26.9705H454.611L466.041 60.7244Z"]
  ];
  var decorative = { "aria-hidden": "true", focusable: "false" };
  function logoMark() {
    return svg(
      "svg",
      { class: "cqa-logo-mark", viewBox: "0 0 96.9945 111.565", ...decorative },
      ...SHIELD.map(([fill, d]) => svg("path", { d, fill }))
    );
  }
  function logoWord() {
    return svg(
      "svg",
      { class: "cqa-logo-word", viewBox: "123.931 25.8837 373.829 59.8106", fill: "currentColor", ...decorative },
      ...WORDMARK.map(([evenOdd, d]) => svg("path", evenOdd ? { d, "fill-rule": "evenodd", "clip-rule": "evenodd" } : { d }))
    );
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
    const right = h("div", { class: "cqa-right" }, compact ? null : datasetBadge(store, track), roleSwitch(store, track), themeToggle(store, track));
    if (compact) return h("header", { class: ["cqa-top", "cqa-top--compact"] }, right);
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
      h("a", { class: "cqa-logo", attrs: { href: href("workspace"), "aria-label": t("brand.name") }, data: { test: "logo" } }, logoMark(), logoWord()),
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
        const nextId2 = next.params.id ?? null;
        if (nextId2 !== id) fillConversation(nextId2);
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
      const sameView = (route2) => current2.name === route2.name || Boolean(views[route2.name]) && views[current2.name] === views[route2.name];
      const show = (route2) => {
        if (current2 && current2.view.update && sameView(route2)) {
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
      selection: /* @__PURE__ */ new Set(),
      // ids ticked in the queue; always replaced, never mutated
      queueRefresh: 0,
      // any change reloads the queue (after an import or an evaluation)
      queueOpen: false,
      // the queue drawer below 900 px
      pane: "transcript",
      // the visible pane below 700 px: "transcript" | "scorecard"
      transcript: null,
      // handle of the open transcript pane: {highlight, focusMessage}; set by the pane itself
      checklistSel: null
      // the checklist version picked in the scorecard: {checklist_id, version}; null = the default
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
    const shell = createShell(store, api, {
      panes: { queue: createQueue, transcript: renderTranscript, scorecard: createScorecard, ...options.panes },
      views: {
        appeals: createAppealsPage,
        appeal: createAppealsPage,
        checklists: createChecklistsPage,
        checklist: createChecklistEditor,
        editor: createChecklistEditor,
        compare: createComparePage,
        ...options.views
      }
    });
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
