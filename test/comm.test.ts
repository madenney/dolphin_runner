import { test } from "node:test";
import assert from "node:assert/strict";
import { buildComm, buildMirrorComm } from "../src/comm.ts";

const base = { replay: "/r.slp", startFrame: -123, endFrame: 8454, isRealTimeMode: false };

test("carries the shape Dolphin expects", () => {
  const c = buildComm(base);
  assert.equal(c.mode, "normal");
  assert.equal(c.replay, "/r.slp");
  assert.equal(c.startFrame, -123);
  assert.equal(c.endFrame, 8454);
  assert.equal(c.isRealTimeMode, false);
  assert.match(c.commandId, /^[0-9a-f]{24}$/);
});

test("REGRESSION: a non-finite endFrame is refused", () => {
  // Without a finite endFrame Dolphin reports PLAYBACK_END_FRAME INT_MAX and,
  // having played the game, idles on "waiting for game" forever.
  assert.throws(() => buildComm({ ...base, endFrame: Infinity }), /finite/);
  assert.throws(() => buildComm({ ...base, endFrame: NaN }), /finite/);
});

test("every invocation gets a fresh commandId", () => {
  assert.notEqual(buildComm(base).commandId, buildComm(base).commandId);
});

test("start frame is caller-controlled for clip ranges", () => {
  const c = buildComm({ ...base, startFrame: 4020 });
  assert.equal(c.startFrame, 4020);
});

test("mirror comm has no frame range and defaults isRealTimeMode to false", () => {
  const c = buildMirrorComm("/r/game.slp");
  assert.deepEqual(Object.keys(c).sort(), ["commandId", "isRealTimeMode", "mode", "replay"]);
  assert.equal(c.mode, "mirror");
  assert.equal(c.isRealTimeMode, false);
  assert.notEqual(buildMirrorComm("/r/game.slp").commandId, c.commandId);
});
