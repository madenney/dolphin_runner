/**
 * The env and argv an OBS-capturable Dolphin is spawned with. This is the
 * contract MST's scene collection depends on: the source is matched by
 * OBS_VKCAPTURE_EXE_NAME, the GL hook only works if libobs_glcapture is
 * preloaded, and audio only routes if PULSE_SINK is set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GLCAPTURE_LIB, obsMirrorArgs, obsMirrorEnv } from "../src/obs.ts";

test("sets every capture-critical variable", () => {
  const env = obsMirrorEnv(
    { HOME: "/h", PATH: "/bin" },
    { captureName: "dolphin-1", pulseSink: "game1", display: ":1" },
  );
  assert.equal(env.OBS_VKCAPTURE, "1");
  assert.equal(env.OBS_VKCAPTURE_EXE_NAME, "dolphin-1");
  assert.equal(env.PULSE_SINK, "game1");
  assert.equal(env.PULSE_LATENCY_MSEC, "120");
  assert.equal(env.DISPLAY, ":1");
  assert.equal(env.LD_PRELOAD, DEFAULT_GLCAPTURE_LIB);
  assert.equal(env.HOME, "/h", "the base env is inherited");
});

test("LD_PRELOAD order: shim first, existing in the middle, glcapture last", () => {
  const env = obsMirrorEnv(
    { LD_PRELOAD: "/a.so:/b.so" },
    { captureName: "dolphin-2", exeOverrideShim: "/shim.so", glcaptureLib: "/gl.so" },
  );
  assert.equal(env.LD_PRELOAD, "/shim.so:/a.so:/b.so:/gl.so");
});

test("an empty existing LD_PRELOAD does not leave a stray colon", () => {
  const env = obsMirrorEnv({ LD_PRELOAD: "" }, { captureName: "x", glcaptureLib: "/gl.so" });
  assert.equal(env.LD_PRELOAD, "/gl.so");
});

test("pulse latency is overridable and PULSE_SINK is only set when asked", () => {
  const env = obsMirrorEnv({}, { captureName: "x", pulseLatencyMs: 200 });
  assert.equal(env.PULSE_LATENCY_MSEC, "200");
  assert.equal("PULSE_SINK" in env, false);
});

test("argv: no -b, no --cout, no dump flags — the window must stay up", () => {
  const args = obsMirrorArgs(
    { dolphinPath: "/d/Dolphin", isoPath: "/i/melee.iso" },
    { userDir: "/tmp/u1", commPath: "/tmp/u1/comm.json" },
  );
  assert.deepEqual(args, ["-i", "/tmp/u1/comm.json", "-e", "/i/melee.iso", "--user", "/tmp/u1"]);
});
