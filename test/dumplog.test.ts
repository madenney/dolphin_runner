/**
 * Why a dump came out empty, from Dolphin's own log. Lines below are the real
 * shapes Ishiiruka writes (VideoCommon/AVIDump.cpp).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  codecFellBack,
  describeDumpFailure,
  dumpLogLines,
  dumpSettingsFromGfx,
  encoderRefused,
  readDumpLog,
  readDumpSettings,
} from "../src/dumplog.ts";
import { noVideoError, record } from "../src/run.ts";
import type { DolphinRunError } from "../src/types.ts";

const LOG = [
  "59:05:884 DolphinWX/X11Utils.cpp:89 I[Video]: XRRExtension-Version 1.6",
  "59:06:953 Common/FileUtil.cpp:180 I[COMMON]: CreateFullPath: path /x/out/dump.avi",
  "59:06:960 VideoCommon/AVIDump.cpp:187 W[Video]: Invalid codec bogus",
  "59:06:971 VideoCommon/AVIDump.cpp:243 N[Video]: Opening file /x/out/dump.avi for dumping",
  "59:08:716 VideoCommon/AVIDump.cpp:417 N[Video]: Stopping frame dump",
].join("\r\n");

test("dump codec read back: UseFFV1 wins, empty DumpCodec is the default", () => {
  assert.deepEqual(dumpSettingsFromGfx("[Settings]\nUseFFV1 = True\nDumpCodec = utvideo\nEFBScale = 4\n"), { codec: "ffv1", efbScale: 4 });
  assert.deepEqual(dumpSettingsFromGfx("[Settings]\nUseFFV1 = False\nDumpCodec = utvideo\n"), { codec: "utvideo", efbScale: null });
  assert.deepEqual(dumpSettingsFromGfx("[Settings]\nUseFFV1 = False\nDumpCodec = \n"), { codec: "default", efbScale: null });
});

test("only the AVIDump lines are kept", () => {
  const lines = dumpLogLines(LOG);
  assert.equal(lines.length, 3);
  assert.ok(codecFellBack(lines));
  assert.ok(!encoderRefused(lines));
});

test("a refused encoder is named, with Dolphin's words and the way out", () => {
  const lines = dumpLogLines("1:2:3 VideoCommon/AVIDump.cpp:190 E[Video]: Could not open codec\n1:2:3 x E[Video]: AVIDump Start failed");
  assert.ok(encoderRefused(lines));
  const s = describeDumpFailure({ codec: "utvideo", efbScale: 4 }, lines);
  assert.match(s, /dump codec "utvideo" at EFBScale 4/);
  assert.match(s, /Could not open codec/);
  assert.match(s, /cannot encode "utvideo"; "ffv1"/);
  // No log (an old Dolphin, or dumpLog: false): still names the codec.
  assert.equal(describeDumpFailure({ codec: "utvideo", efbScale: 4 }, []), 'dump codec "utvideo" at EFBScale 4');
});

test("noVideoError keeps its prefix and carries dumpCodec / dumpLog", () => {
  const e = noVideoError(
    "/r/g.slp",
    { exitCode: 0, exitSignal: null, stdoutTail: [], stderrTail: [], diagnostic: null },
    { dump: { codec: "utvideo", efbScale: 4 }, log: ["x E[Video]: Could not find encoder or allocate codec context"] },
  );
  assert.match(e.message, /^Dolphin produced no video for \/r\/g\.slp \(exit code 0\); dump codec "utvideo"/);
  assert.match(e.message, /Could not find encoder/);
  assert.equal(e.dumpCodec, "utvideo");
  assert.equal(e.dumpLog.length, 1);
});

test("record(): a Dolphin that logs a refused encoder and writes no .avi is reported with the codec", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dr-dumplog-"));
  try {
    const iso = path.join(tmp, "melee.iso");
    fs.writeFileSync(iso, "");
    const slp = path.join(tmp, "g.slp");
    const val = Buffer.alloc(4);
    val.writeInt32BE(600);
    fs.writeFileSync(slp, Buffer.concat([Buffer.from("raw..lastFramel"), val, Buffer.from("}}")]));
    const userDir = path.join(tmp, "user");
    fs.mkdirSync(path.join(userDir, "Config"), { recursive: true });
    fs.writeFileSync(path.join(userDir, "Config", "GFX.ini"), "[Settings]\nUseFFV1 = False\nDumpCodec = utvideo\nEFBScale = 4\n");
    const fake = path.join(tmp, "fake-dolphin.sh");
    fs.writeFileSync(
      fake,
      [
        "#!/bin/sh",
        'for a in "$@"; do case "$a" in --user) n=1;; *) if [ "$n" = 1 ]; then u="$a"; n=; fi;; esac; done',
        'mkdir -p "$u/Logs"',
        'echo "0:0:1 VideoCommon/AVIDump.cpp:190 E[Video]: Could not open codec" > "$u/Logs/dolphin.log"',
        "exit 0",
        "",
      ].join("\n"),
    );
    fs.chmodSync(fake, 0o755);
    await assert.rejects(
      () => record({ dolphinPath: fake, isoPath: iso }, slp, { userDir, outDir: path.join(tmp, "out"), display: ":99", bootStallMs: 10_000 }),
      (e: DolphinRunError) => {
        assert.equal(e.code, "no-video");
        assert.equal(e.dumpCodec, "utvideo");
        assert.match(e.message, /Could not open codec/);
        return true;
      },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("readDumpLog / readDumpSettings: absent files are empty, never a throw", () => {
  assert.deepEqual(readDumpLog("/nonexistent/x"), []);
  assert.equal(readDumpSettings("/nonexistent/x"), null);
});

function wav(dataBytes: number, declared: number, riffDeclared: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "latin1");
  h.writeUInt32LE(riffDeclared, 4);
  h.write("WAVE", 8, "latin1");
  h.write("fmt ", 12, "latin1");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(2, 22); // stereo
  h.writeUInt32LE(48000, 24);
  h.writeUInt32LE(48000 * 4, 28);
  h.writeUInt16LE(4, 32); // block align
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "latin1");
  h.writeUInt32LE(declared, 40);
  return Buffer.concat([h, Buffer.alloc(dataBytes, 7)]);
}

test("repairWavHeader: a forced stop's placeholder sizes are rewritten from the length", async () => {
  const { repairWavHeader } = await import("../src/dumplog.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-wav-"));
  try {
    const f = path.join(dir, "a.wav");
    fs.writeFileSync(f, wav(4002, 0, 0)); // 4002: not a whole frame -> 4000
    assert.equal(repairWavHeader(f), true);
    const b = fs.readFileSync(f);
    assert.equal(b.readUInt32LE(40), 4000);
    assert.equal(b.readUInt32LE(4), 36 + 4000);
    assert.equal(repairWavHeader(f), false, "idempotent");
    fs.writeFileSync(f, wav(400, 400, 436)); // already right
    assert.equal(repairWavHeader(f), false);
    fs.writeFileSync(f, "not a wav");
    assert.equal(repairWavHeader(f), false);
    assert.equal(repairWavHeader(path.join(dir, "missing.wav")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
