// The version numbers of one row of GET /checklists.
//
// The backend sends `versions` as plain numbers ([1, 2]). Older mock rows carried objects
// ({ version: 1 }), so both are read. A row without `versions` has only its own `version`.
// Anything that is not a whole number is dropped, so a malformed row can never produce NaN.

/** @param {{ version?: number, versions?: Array<number | { version: number }> }} row */
export function versionNumbers(row) {
  const raw = Array.isArray(row?.versions) && row.versions.length > 0 ? row.versions : [row?.version];
  const numbers = raw.map((v) => (typeof v === "object" && v !== null ? v.version : v)).filter((v) => Number.isInteger(v));
  return [...new Set(numbers)];
}

/** The newest version number of a row, or null when it has none. */
export function latestVersion(row) {
  const numbers = versionNumbers(row);
  return numbers.length > 0 ? Math.max(...numbers) : null;
}
