// Content fingerprints, identical to the backend's: SHA-256 (hex) over the UTF-8 bytes of the
// canonical JSON, which is Python's json.dumps(sort_keys=True, separators=(",", ":"),
// ensure_ascii=False). A decided appeal carries forward only while both hashes stay unchanged.

// ---- canonical JSON ---------------------------------------------------------------------------

/**
 * Keys sorted at every level, no spaces. The string is built by hand because rebuilding an object
 * would let JavaScript reorder integer-like keys.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item === undefined ? null : item)).join(",") + "]";
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

// ---- SHA-256 ----------------------------------------------------------------------------------

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// Constants from the fractional parts of the cube and square roots of the first primes.
const PRIMES = [];
for (let n = 2; PRIMES.length < 64; n += 1) {
  if (PRIMES.every((p) => n % p !== 0)) PRIMES.push(n);
}
const frac32 = (x) => Math.floor((x - Math.floor(x)) * 4294967296) >>> 0;
const K = PRIMES.map((p) => frac32(Math.cbrt(p)));
const H0 = PRIMES.slice(0, 8).map((p) => frac32(Math.sqrt(p)));

/**
 * Plain JavaScript SHA-256, for pages where crypto.subtle is missing (it needs a secure context).
 * @param {string} str
 * @returns {string} lower-case hex
 */
export function sha256HexPure(str) {
  const bytes = new TextEncoder().encode(String(str));
  const length = bytes.length;
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 4294967296));
  view.setUint32(padded.length - 4, bits >>> 0);

  const h = Uint32Array.from(H0);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  h.forEach((word, i) => outView.setUint32(i * 4, word));
  return toHex(out);
}

/**
 * SHA-256 hex of the UTF-8 bytes of a string, through crypto.subtle when the page has it.
 * @param {string} str
 * @returns {Promise<string>}
 */
export async function sha256Hex(str) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(String(str)));
    return toHex(new Uint8Array(digest));
  }
  return sha256HexPure(str);
}

// ---- the two fingerprints ---------------------------------------------------------------------

const orNull = (value) => (value === undefined ? null : value);

/**
 * Fingerprint of a criterion: title, wording, answer_type, scale_steps, na_allowed, na_condition,
 * kind, kinds and guidance. Weight, order, model, id and section do not count, so changing only
 * a weight keeps decided appeals attached.
 * @param {object} criterion
 * @returns {Promise<string>}
 */
export function fingerprint(criterion) {
  return sha256Hex(canonicalJson(fingerprintSubset(criterion)));
}

/** The fields a criterion's fingerprint covers (also used to compare two drafts without hashing). */
export function fingerprintSubset(criterion) {
  const c = criterion || {};
  return {
    title: orNull(c.title),
    wording: orNull(c.wording),
    answer_type: orNull(c.answer_type),
    scale_steps: (Array.isArray(c.scale_steps) ? c.scale_steps : []).map((step) => ({
      value: orNull(step && step.value),
      label: orNull(step && step.label),
    })),
    na_allowed: orNull(c.na_allowed),
    na_condition: orNull(c.na_condition),
    kind: c.kind ?? "scored",
    kinds: Array.isArray(c.kinds) ? c.kinds : [],
    guidance: orNull(c.guidance),
  };
}

/**
 * Hash of a transcript's content: timestamp, speaker and text of each line (the duplicate flag
 * and anything else are excluded).
 * @param {{timestamp?: string, speaker?: string, text?: string}[]} transcript
 * @returns {Promise<string>}
 */
export function transcriptHash(transcript) {
  const lines = (Array.isArray(transcript) ? transcript : []).map((m) => ({
    timestamp: orNull(m && m.timestamp),
    speaker: orNull(m && m.speaker),
    text: orNull(m && m.text),
  }));
  return sha256Hex(canonicalJson(lines));
}
