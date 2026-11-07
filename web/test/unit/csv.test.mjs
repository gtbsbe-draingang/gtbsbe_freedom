// CSV writer: BOM, `;` separator, CRLF, RFC 4180 quoting.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { csvField, toCsv } from "../../src/domain/csv.js";

describe("toCsv", () => {
  test("starts with a UTF-8 BOM, joins with `;` and ends lines with CRLF", () => {
    const text = toCsv([{ a: 1, b: "x" }, { a: 2, b: "y" }], ["a", "b"]);
    assert.equal(text, "﻿a;b\r\n1;x\r\n2;y\r\n");
    assert.equal(text.charCodeAt(0), 0xfeff);
  });

  test("quotes a field with the separator", () => {
    assert.equal(csvField("a;b"), '"a;b"');
    assert.equal(toCsv([{ v: "a;b" }], ["v"]), '﻿v\r\n"a;b"\r\n');
  });

  test('quotes a field with a quote and doubles it: "x" becomes """x"""', () => {
    assert.equal(csvField('"x"'), '"""x"""');
    assert.equal(toCsv([{ v: '"x"' }], ["v"]), '﻿v\r\n"""x"""\r\n');
  });

  test("quotes a field with a line break (CR, LF or CRLF)", () => {
    assert.equal(csvField("a\nb"), '"a\nb"');
    assert.equal(csvField("a\r\nb"), '"a\r\nb"');
    assert.equal(csvField("a\rb"), '"a\rb"');
  });

  test("leaves plain text, commas, Cyrillic and spaces alone", () => {
    assert.equal(csvField("Да, всё хорошо"), "Да, всё хорошо");
    assert.equal(csvField("88,82"), "88,82");
  });

  test("null and undefined are empty; numbers and booleans use String()", () => {
    assert.equal(toCsv([{ a: null, b: undefined, c: 0, d: false, e: 1.5 }], ["a", "b", "c", "d", "e"]),
      "﻿a;b;c;d;e\r\n;;0;false;1.5\r\n");
  });

  test("columns can carry a header and a value function; headers are quoted too", () => {
    const text = toCsv([{ id: "g:1", n: 3 }], [
      { key: "id", header: "ID; диалога" },
      { key: "n", header: "Итог", value: (r) => String(r.n).replace(".", ",") + "!" },
    ]);
    assert.equal(text, '﻿"ID; диалога";Итог\r\ng:1;3!\r\n');
  });

  test("no rows gives the BOM and the header only", () => {
    assert.equal(toCsv([], ["a", "b"]), "﻿a;b\r\n");
  });
});

test('column titles from the Task 17 interface are supported', () => {
  assert.equal(toCsv([{a:'a;b',b:'"x"'}], [{key:'a',title:'Первый'},{key:'b',title:'Второй'}]), '﻿Первый;Второй\r\n"a;b";"""x"""\r\n');
});
