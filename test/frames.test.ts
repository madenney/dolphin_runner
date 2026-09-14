import { test } from "node:test";
import assert from "node:assert/strict";
import { foldEnd, parseFrameLine, reachedEnd } from "../src/frames.ts";

test("parses each line Dolphin emits", () => {
  assert.deepEqual(parseFrameLine("[CURRENT_FRAME] 8454"), { kind: "current", frame: 8454 });
  assert.deepEqual(parseFrameLine("[PLAYBACK_END_FRAME] 9000"), { kind: "playbackEnd", frame: 9000 });
  assert.deepEqual(parseFrameLine("[GAME_END_FRAME] 8800"), { kind: "gameEnd", frame: 8800 });
  assert.deepEqual(parseFrameLine("negative lead-in [CURRENT_FRAME] -123"), { kind: "current", frame: -123 });
  assert.deepEqual(parseFrameLine("Loading GALE01"), { kind: "other" });
});

test("REGRESSION: 845 must not match inside 8454", () => {
  // The substring bug: `line.includes("[CURRENT_FRAME] " + end)` is true for
  // "[CURRENT_FRAME] 8454" when end is 845, killing the dump at a tenth length.
  const line = "[CURRENT_FRAME] 8454";
  const parsed = parseFrameLine(line);
  assert.equal(parsed.kind, "current");
  assert.equal(parsed.kind === "current" && parsed.frame, 8454);
  assert.equal(reachedEnd(8454, 845), true, "8454 is past 845 — this end already passed");
  assert.equal(reachedEnd(800, 845), false, "800 has not reached 845");
});

test("REGRESSION: a skipped end frame still stops (>= not ==)", () => {
  // Dolphin does not always print every frame number. An `==` check on a frame
  // it skips never fires and the process idles forever.
  assert.equal(reachedEnd(9001, 9000), true);
  assert.equal(reachedEnd(9000, 9000), true);
  assert.equal(reachedEnd(8999, 9000), false);
});

test("an infinite end never counts as reached", () => {
  assert.equal(reachedEnd(999999, Infinity), false);
});

test("the earlier end frame wins", () => {
  assert.equal(foldEnd(Infinity, 9000), 9000);
  assert.equal(foldEnd(9000, 8800), 8800, "GAME_END before PLAYBACK_END");
  assert.equal(foldEnd(8800, 9000), 8800, "a later report must not extend the range");
});
