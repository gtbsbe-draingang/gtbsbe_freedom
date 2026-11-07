// Small deterministic PRNG for the mock model: the same seed always gives the same answers.

/** FNV-1a, 32 bit, over the UTF-8 bytes of the string. Returns an unsigned integer. */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(String(str))) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * mulberry32 seeded from FNV-1a(str). Each call returns a float in [0, 1).
 * @param {string} str
 * @returns {() => number}
 */
export function seeded(str) {
  let a = fnv1a32(str);
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
