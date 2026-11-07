// CSV for Excel in a Russian locale: UTF-8 with a BOM, `;` as the separator (the list separator
// of ru-RU Excel), CRLF line ends, RFC 4180 quoting. A field is quoted when it holds the
// separator, a quote or a line break; a quote inside is doubled. Numbers are written with
// String(); a caller that wants a decimal comma formats the number into a string first.

export const BOM = "\uFEFF";
export const SEPARATOR = ";";
export const EOL = "\r\n";

const NEEDS_QUOTES = /[;"\r\n]/;

/** One field: null and undefined are empty, everything else goes through String(). */
export function csvField(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {(string | {key: string, title?: string, header?: string, value?: (row: object) => unknown})[]} columns
 *   A string is both the key and the header. `value(row)` overrides reading `row[key]`.
 * @returns {string} BOM, a header line, then one line per row, each ending in CRLF.
 */
export function toCsv(rows, columns) {
  const cols = columns.map((c) => (typeof c === "string" ? { key: c, header: c } : c));
  const lines = [cols.map((c) => csvField(c.title ?? c.header ?? c.key))];
  for (const row of rows) {
    lines.push(cols.map((c) => csvField(typeof c.value === "function" ? c.value(row) : row?.[c.key])));
  }
  return BOM + lines.map((line) => line.join(SEPARATOR) + EOL).join("");
}
