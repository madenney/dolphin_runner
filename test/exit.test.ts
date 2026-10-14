/**
 * Exit diagnostics (0.5.7). Before this, a Dolphin that died at startup
 * resolved `{ stalled: false, diagnostic: null }` — exactly like success — and
 * its exit code and stderr were thrown away; record() then said only "Dolphin
 * produced no video". Fake "Dolphin" shell scripts stand in for the binary.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { play, record } from "../src/run.ts";
import type { DolphinRunError } from "../src/types.ts";

let tmp: string;
let iso: string;
let slp: string;
let userDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dr-exit-"));
  iso = path.join(tmp, "melee.iso");
  fs.writeFileSync(iso, "");
  slp = path.join(tmp, "g.slp");
  const val = Buffer.alloc(4);
  val.writeInt32BE(600);
  fs.writeFileSync(slp, Buffer.concat([Buffer.from("raw..lastFramel"), val, Buffer.from("}}")]));
  userDir = path.join(tmp, "user");
  fs.mkdirSync(userDir);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeDolphin(body: string[]): string {
  const fake = path.join(tmp, "fake-dolphin.sh");
  fs.writeFileSync(
    fake,
    [
      "#!/bin/sh",
      'for a in "$@"; do case "$a" in --output-directory=*) d="${a#--output-directory=}";; esac; done',
      ...body,
      "",
    ].join("\n"),
  );
  fs.chmodSync(fake, 0o755);
  return fake;
}

const opts = () => ({ userDir, display: ":99", bootStallMs: 10_000 });

test("REGRESSION: a Dolphin that dies at startup is an early-exit, not a success", async () => {
  const fake = fakeDolphin(['echo "Failed to open ISO" >&2', 'echo "boot log line"', "exit 3"]);
  const res = await play({ dolphinPath: fake, isoPath: iso }, slp, opts());
  assert.equal(res.stalled, false, "early-exit is not the watchdog");
  assert.equal(res.exitCode, 3);
  assert.equal(res.exitSignal, null);
  assert.ok(res.diagnostic, "diagnostic must be set");
  assert.equal(res.diagnostic.reason, "early-exit");
  assert.equal(res.diagnostic.hungOnBoot, true);
  assert.equal(res.diagnostic.exitCode, 3);
  assert.deepEqual(res.stderrTail, ["Failed to open ISO"]);
  assert.deepEqual(res.diagnostic.stderrTail, ["Failed to open ISO"]);
  assert.deepEqual(res.stdoutTail, ["boot log line"]);
});

test("record()'s 'produced no video' carries the exit and Dolphin's stderr", async () => {
  const fake = fakeDolphin(['echo "libGL error: no matching fbConfigs" >&2', "exit 1"]);
  await assert.rejects(
    () => record({ dolphinPath: fake, isoPath: iso }, slp, { ...opts(), outDir: path.join(tmp, "out") }),
    (e: DolphinRunError) => {
      // The old prefix survives for anyone matching on it.
      assert.match(e.message, /^Dolphin produced no video for /);
      assert.match(e.message, /exit code 1/);
      assert.match(e.message, /early-exit/);
      assert.match(e.message, /libGL error: no matching fbConfigs/);
      assert.equal(e.code, "no-video");
      assert.equal(e.exitCode, 1);
      assert.deepEqual(e.stderrTail, ["libGL error: no matching fbConfigs"]);
      assert.equal(e.diagnostic?.reason, "early-exit");
      return true;
    },
  );
});

test("the last stderr line is kept even when Dolphin exits straight after writing it", async () => {
  // 'exit' can arrive before the final stderr chunk; that chunk is the one
  // that says why it died.
  const fake = fakeDolphin([
    'i=0; while [ $i -lt 2000 ]; do echo "noise $i" >&2; i=$((i+1)); done',
    'echo "THE REAL REASON" >&2',
    "exit 7",
  ]);
  const res = await play({ dolphinPath: fake, isoPath: iso }, slp, opts());
  assert.equal(res.exitCode, 7);
  assert.equal(res.stderrTail.at(-1), "THE REAL REASON");
  assert.ok(res.stderrTail.length <= 60, "the tail stays bounded");
});

test("a run that reaches its end frame has no diagnostic, and still reports how it exited", async () => {
  const fake = fakeDolphin([
    'echo "[PLAYBACK_END_FRAME] 600"',
    'i=0; while [ $i -le 600 ]; do echo "[CURRENT_FRAME] $i"; i=$((i+100)); done',
    ': > "$d/dump.avi"',
    "sleep 10",
  ]);
  const res = await record({ dolphinPath: fake, isoPath: iso }, slp, { ...opts(), outDir: path.join(tmp, "out") });
  assert.equal(res.diagnostic, null);
  assert.equal(res.stalled, false);
  // We SIGTERMed it at the end frame.
  assert.ok(res.exitSignal === "SIGTERM" || res.exitCode != null, "exit is reported either way");
  assert.ok(Array.isArray(res.stdoutTail) && Array.isArray(res.stderrTail));
  assert.ok(!res.stdoutTail.some((l) => l.includes("[CURRENT_FRAME]")), "frame spam is not kept");
});

test("a Dolphin that exits by itself AFTER printing frames is not an early-exit", async () => {
  // A batch Dolphin may exit on its own once playback stops, a frame short of
  // what we compare against — that is the normal end, not a startup crash.
  const fake = fakeDolphin([
    'echo "[PLAYBACK_END_FRAME] 600"',
    'echo "[CURRENT_FRAME] 1"',
    'echo "[CURRENT_FRAME] 599"',
    "exit 0",
  ]);
  const res = await play({ dolphinPath: fake, isoPath: iso }, slp, opts());
  assert.equal(res.diagnostic, null);
  assert.equal(res.exitCode, 0);
});
