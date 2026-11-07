import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { format, pluralForm, t, tp } from "../../src/i18n/ru.js";

describe("i18n t()", () => {
  test("returns the Russian string for a known key", () => {
    assert.equal(t("app.title"), "Качество диалогов");
  });

  test("a missing key returns the key and logs nothing", () => {
    const methods = ["log", "info", "warn", "error", "debug"];
    const originals = methods.map((name) => console[name]);
    const calls = [];
    methods.forEach((name) => {
      console[name] = (...args) => calls.push([name, ...args]);
    });
    try {
      assert.equal(t("no.such.key"), "no.such.key");
      assert.equal(t("no.such.key", { a: 1 }), "no.such.key");
      // Keys that exist on Object.prototype are not messages.
      assert.equal(t("constructor"), "constructor");
      assert.equal(t("toString"), "toString");
    } finally {
      methods.forEach((name, i) => {
        console[name] = originals[i];
      });
    }
    assert.deepEqual(calls, []);
  });
});

describe("i18n format()", () => {
  test("fills {name} placeholders, numbers included", () => {
    assert.equal(format("Критериев: {n} из {total}", { n: 3, total: 8 }), "Критериев: 3 из 8");
    assert.equal(format("{a}{a}", { a: "x" }), "xx");
  });

  test("leaves a placeholder without a parameter as it is", () => {
    assert.equal(format("Привет, {name}", {}), "Привет, {name}");
    assert.equal(format("Привет, {name}"), "Привет, {name}");
  });

  test("does not read inherited properties and does not re-expand values", () => {
    assert.equal(format("{constructor}", {}), "{constructor}");
    assert.equal(format("{a}", { a: "{b}", b: "!" }), "{b}");
  });
});

describe("Russian plurals", () => {
  test("pluralForm picks one / few / many by the Russian rule", () => {
    const cases = { 1: "one", 21: "one", 101: "one", 2: "few", 3: "few", 4: "few", 22: "few", 0: "many", 5: "many", 11: "many", 12: "many", 14: "many", 25: "many", 111: "many" };
    for (const [n, form] of Object.entries(cases)) assert.equal(pluralForm(Number(n)), form, `n = ${n}`);
  });

  test("tp() fills {n} into the right form", () => {
    assert.equal(tp("batch.dialogs", 1), "1 диалог");
    assert.equal(tp("batch.dialogs", 3), "3 диалога");
    assert.equal(tp("batch.dialogs", 65), "65 диалогов");
  });
});
