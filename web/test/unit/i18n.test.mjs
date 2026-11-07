import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { format, t } from "../../src/i18n/ru.js";

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
