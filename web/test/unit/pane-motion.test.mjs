// The board <-> dialogue motion: which kind the browser and the user's settings allow.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { motionMode } from "../../src/ui/pane-motion.js";

describe("motionMode", () => {
  test("reduced motion always fades, with or without view transitions", () => {
    assert.equal(motionMode({ reduced: true, viewTransitions: true }), "fade");
    assert.equal(motionMode({ reduced: true, viewTransitions: false }), "fade");
  });

  test("view transitions morph the card into the panel; without them the panes slide", () => {
    assert.equal(motionMode({ reduced: false, viewTransitions: true }), "morph");
    assert.equal(motionMode({ reduced: false, viewTransitions: false }), "slide");
  });
});
