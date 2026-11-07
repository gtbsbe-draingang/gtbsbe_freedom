import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { latestVersion, versionNumbers } from "../../src/domain/checklist-versions.js";

describe("versionNumbers", () => {
  test("plain numbers, as GET /checklists sends them", () => {
    assert.deepEqual(versionNumbers({ version: 2, versions: [1, 2] }), [1, 2]);
  });
  test("objects, as older mock rows did", () => {
    assert.deepEqual(versionNumbers({ versions: [{ version: 1 }, { version: 3 }] }), [1, 3]);
  });
  test("no versions list falls back to the row's own version", () => {
    assert.deepEqual(versionNumbers({ version: 4 }), [4]);
    assert.deepEqual(versionNumbers({ version: 4, versions: [] }), [4]);
  });
  test("malformed entries are dropped, never NaN", () => {
    assert.deepEqual(versionNumbers({ versions: [1, "2", null, { version: undefined }, 1.5, 3] }), [1, 3]);
    assert.deepEqual(versionNumbers({}), []);
    assert.deepEqual(versionNumbers(null), []);
  });
});

describe("latestVersion", () => {
  test("the highest number, or null", () => {
    assert.equal(latestVersion({ versions: [1, 3, 2] }), 3);
    assert.equal(latestVersion({ versions: [{ version: 2 }] }), 2);
    assert.equal(latestVersion({}), null);
  });
});
