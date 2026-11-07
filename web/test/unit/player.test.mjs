// Pure parts of the call player (Task 15): where each line starts in the recording, and which line
// is being played at a given time. The DOM part is covered by the e2e scenario 11-player.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { playingIndex, startTimes } from "../../src/ui/player.js";

describe("startTimes", () => {
  const transcript = [
    { timestamp: "10:00:00", speaker: "client", text: "a" },
    { timestamp: "10:00:05", speaker: "operator", text: "b" },
    { timestamp: "", speaker: "system", text: "c" },
    { timestamp: "10:00:20", speaker: "client", text: "d" },
  ];

  test("audio_offsets give each line's start; a line without one has none", () => {
    const starts = startTimes({ transcript, audio_offsets: [{ message_index: 0, seconds: 1.5 }, { message_index: 1, seconds: 7 }, { message_index: 3, seconds: 26.4 }] });
    assert.deepEqual(starts, [1.5, 7, null, 26.4]);
  });

  test("without audio_offsets (absent or empty), the transcript's own times count from the first line", () => {
    assert.deepEqual(startTimes({ transcript }), [0, 5, null, 20]);
    assert.deepEqual(startTimes({ transcript, audio_offsets: [] }), [0, 5, null, 20]);
  });

  test("offsets outside the transcript or not numbers are ignored", () => {
    const starts = startTimes({ transcript: transcript.slice(0, 2), audio_offsets: [{ message_index: 5, seconds: 3 }, { message_index: 1, seconds: "7" }, { message_index: 0, seconds: 2 }] });
    assert.deepEqual(starts, [2, null]);
  });
});

describe("playingIndex: start ≤ t < the next start", () => {
  const starts = [0, 4, null, 9, 9, 15];

  test("the line whose start is the last one not after t", () => {
    assert.equal(playingIndex(starts, 0), 0);
    assert.equal(playingIndex(starts, 3.99), 0);
    assert.equal(playingIndex(starts, 4), 1);
    assert.equal(playingIndex(starts, 14.9), 4);
    assert.equal(playingIndex(starts, 600), 5);
  });

  test("lines that start together: the last of them is played (the earlier ones last no time)", () => {
    assert.equal(playingIndex(starts, 9), 4);
  });

  test("before the first line, or with no times at all, nothing is played", () => {
    assert.equal(playingIndex([2, 5], 1.9), null);
    assert.equal(playingIndex([null, null], 3), null);
    assert.equal(playingIndex([], 3), null);
    assert.equal(playingIndex(starts, Number.NaN), null);
  });

  test("times out of order are read by value, not by position", () => {
    assert.equal(playingIndex([0, 10, 5], 7), 2);
  });
});
