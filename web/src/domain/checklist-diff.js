// What changed between a checklist version and a draft (or a later version), criterion by
// criterion, matched by id. Browser-safe ES module.
//
//   added       in b, not in a (a criterion without an id is always new)
//   removed     in a, not in b
//   reworded    the fingerprint fields differ (title, wording, answer type, scale, N/A, kind,
//               kinds, guidance): a re-run needs one model call per dialogue for it
//   weightOnly  only the weight differs: totals are recalculated in code, no model call
// Order, section and model changes need no new answer and are not listed.
import { canonicalJson, fingerprintSubset } from "./fingerprint.js";

const same = (x, y) => canonicalJson(fingerprintSubset(x)) === canonicalJson(fingerprintSubset(y));
const hasId = (c) => typeof c?.id === "string" && c.id !== "";

/**
 * @param {{criteria: object[]} | null} a  the source (null: everything in b is new)
 * @param {{criteria: object[]}} b
 * @returns {{added: (string|null)[], removed: string[], reworded: string[], weightOnly: string[]}}
 */
export function diffVersions(a, b) {
  const before = new Map((a?.criteria ?? []).filter(hasId).map((c) => [c.id, c]));
  const after = b?.criteria ?? [];
  const seen = new Set();
  const out = { added: [], removed: [], reworded: [], weightOnly: [] };
  for (const c of after) {
    const old = hasId(c) ? before.get(c.id) : undefined;
    if (!old) {
      out.added.push(hasId(c) ? c.id : null);
      continue;
    }
    seen.add(c.id);
    if (!same(old, c)) out.reworded.push(c.id);
    else if (Number(old.weight ?? 0) !== Number(c.weight ?? 0)) out.weightOnly.push(c.id);
  }
  for (const id of before.keys()) if (!seen.has(id)) out.removed.push(id);
  return out;
}
