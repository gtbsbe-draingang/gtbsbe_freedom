// Exact rational arithmetic for scoring. A Rat is { n, d } with BigInt n and
// d > 0, always in lowest terms. No floats are involved until round2() turns
// the final result into a Number.

const DECIMAL = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

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

function parse(text) {
  const m = DECIMAL.exec(text.trim());
  const intPart = m?.[2] ?? "";
  const fracPart = m?.[3] ?? "";
  if (!m || intPart + fracPart === "") {
    throw new TypeError(`not a decimal number: ${JSON.stringify(text)}`);
  }
  let n = BigInt(intPart + fracPart);
  let d = 10n ** BigInt(fracPart.length);
  const exp = m[4] === undefined ? 0 : Number(m[4]);
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 10000) {
    throw new RangeError(`exponent out of range: ${JSON.stringify(text)}`);
  }
  if (exp > 0) n *= 10n ** BigInt(exp);
  else if (exp < 0) d *= 10n ** BigInt(-exp);
  if (m[1] === "-") n = -n;
  return make(n, d);
}

/** Parse a decimal string, number (via String) or bigint into a Rat. */
export function rat(x) {
  if (typeof x === "bigint") return make(x, 1n);
  if (typeof x === "number") {
    if (!Number.isFinite(x)) throw new TypeError(`not a finite number: ${x}`);
    return parse(String(x));
  }
  if (typeof x === "string") return parse(x);
  throw new TypeError(`cannot make a rational from ${typeof x}`);
}

export const add = (a, b) => make(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a, b) => make(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a, b) => make(a.n * b.n, a.d * b.d);
export const div = (a, b) => {
  if (b.n === 0n) throw new RangeError("division by zero");
  return make(a.n * b.d, a.d * b.n);
};
export const isZero = (a) => a.n === 0n;

// a rounded to hundredths, half-up (away from zero on .5), as an integer.
function hundredths(a) {
  const neg = a.n < 0n;
  const n = neg ? -a.n : a.n;
  // floor(n * 100 / d + 1/2) = floor((2 * 100 * n + d) / (2d))
  const q = (200n * n + a.d) / (2n * a.d);
  return neg ? -q : q;
}

/** Round half-up to two decimals; returns a Number (never -0). */
export function round2(a) {
  return Number(hundredths(a)) / 100 + 0;
}

/** Round half-up to two decimals; returns the text, e.g. "84.17". */
export function fmt2(a) {
  const q = hundredths(a);
  const abs = q < 0n ? -q : q;
  const whole = abs / 100n;
  const cents = String(abs % 100n).padStart(2, "0");
  return `${q < 0n ? "-" : ""}${whole}.${cents}`;
}
