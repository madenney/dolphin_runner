/**
 * Background-running options (docs/background-and-mute.md). Each test pins a
 * rule that was MEASURED on 2026-10-08 — the comment says what broke without it.
 *
 * The "real" profile is faked through XDG_CONFIG_HOME, as in profile.test.ts.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_RECORD, buildProfile, NULL_AUDIO_BACKEND } from "../src/profile.ts";
import { getInSection } from "../src/ini.ts";
import { profileAt } from "../src/paths.ts";
import { appNameProp, record, recordEnv } from "../src/run.ts";
import { obsMirrorEnv, obsMirrorProfile } from "../src/obs.ts";
import type { AudioBackend, DumpCodec } from "../src/types.ts";

let tmp: string;
let realRoot: string;
let userDir: string;
let prevXdg: string | undefined;

function writeReal(dolphin: string, gfx: string) {
  fs.writeFileSync(path.join(realRoot, "Config", "Dolphin.ini"), dolphin);
  fs.writeFileSync(path.join(realRoot, "Config", "GFX.ini"), gfx);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dr-bg-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmp;
  realRoot = path.join(tmp, "SlippiPlayback");
  fs.mkdirSync(path.join(realRoot, "Config"), { recursive: true });
  fs.mkdirSync(path.join(realRoot, "GameSettings"), { recursive: true });
  writeReal(
    "[DSP]\nBackend = ALSA\nVolume = 25\n[Interface]\nPauseOnFocusLost = True\n[Display]\nFullscreen = True\n",
    "[Settings]\nEFBScale = 6\nUseFFV1 = True\n",
  );
  userDir = path.join(tmp, "worker-1");
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const user = () => profileAt(userDir);
const dol = () => fs.readFileSync(user().dolphinIni, "utf8");
const gfx = () => fs.readFileSync(user().gfxIni, "utf8");

// --- mute -------------------------------------------------------------------

test("silent selects the null audio backend and leaves the audio DUMP on", async () => {
  await buildProfile(userDir, { mode: "record", silent: true });
  assert.equal(getInSection(dol(), "DSP", "Backend"), "No audio output");
  assert.equal(NULL_AUDIO_BACKEND, "No audio output");
  assert.equal(getInSection(dol(), "DSP", "DumpAudio"), "True");
  assert.equal(getInSection(dol(), "Movie", "DumpAudio"), "True");
});

test("an unknown audioBackend is refused — Dolphin would silently fall back to no audio", async () => {
  await assert.rejects(
    buildProfile(userDir, { mode: "play", audioBackend: "pulse" as AudioBackend }),
    /unknown audioBackend/,
  );
});

test("silent plus a real audioBackend is a contradiction, not a guess", async () => {
  await assert.rejects(buildProfile(userDir, { mode: "record", silent: true, audioBackend: "Pulse" }), /contradict/);
});

test("without silent or audioBackend the copy's backend is untouched", async () => {
  await buildProfile(userDir, { mode: "record" });
  assert.equal(getInSection(dol(), "DSP", "Backend"), "ALSA");
});

// --- focus ------------------------------------------------------------------

test("record mode forces PauseOnFocusLost off — a parked recording that pauses never finishes", async () => {
  await buildProfile(userDir, { mode: "record" });
  assert.equal(getInSection(dol(), "Interface", "PauseOnFocusLost"), "False");
});

test("an explicit pauseOnFocusLost wins in record mode", async () => {
  await buildProfile(userDir, { mode: "record", pauseOnFocusLost: true });
  assert.equal(getInSection(dol(), "Interface", "PauseOnFocusLost"), "True");
});

test("play mode keeps the copy's PauseOnFocusLost unless asked", async () => {
  await buildProfile(userDir, { mode: "play" });
  assert.equal(getInSection(dol(), "Interface", "PauseOnFocusLost"), "True");
});

test("keepWindowOnTop is written in [Display]", async () => {
  await buildProfile(userDir, { mode: "play", keepWindowOnTop: false });
  assert.equal(getInSection(dol(), "Display", "KeepWindowOnTop"), "False");
});

test("play mode can detach hotkeys — a mirror that steals focus must not take the operator's keys", async () => {
  await buildProfile(userDir, { mode: "play" });
  assert.equal(fs.existsSync(path.join(userDir, "Config", "Hotkeys.ini")), false);
  await buildProfile(userDir, { mode: "play", detachHotkeys: true });
  assert.match(fs.readFileSync(path.join(userDir, "Config", "Hotkeys.ini"), "utf8"), /Device = \/0\//);
});

test("BACKGROUND_RECORD spreads into buildProfile without muting or changing speed", async () => {
  await buildProfile(userDir, { ...BACKGROUND_RECORD, mode: "record", efbScale: 6 });
  const d = dol();
  assert.equal(getInSection(d, "Interface", "PauseOnFocusLost"), "False");
  assert.equal(getInSection(d, "Display", "KeepWindowOnTop"), "False");
  assert.equal(getInSection(d, "Display", "Fullscreen"), "False");
  assert.equal(getInSection(d, "Display", "RenderWindowWidth"), "640");
  assert.equal(getInSection(gfx(), "Hardware", "VSync"), "False");
  assert.equal(getInSection(d, "DSP", "Backend"), "ALSA");
  assert.equal(getInSection(d, "Core", "EmulationSpeed"), null);
});

// --- codec ------------------------------------------------------------------

test("dumpCodec writes both UseFFV1 and DumpCodec — UseFFV1 overrides DumpCodec in Dolphin", async () => {
  const cases: [DumpCodec, string, string | null][] = [
    ["ffv1", "True", null],
    ["utvideo", "False", "utvideo"],
    ["mpeg4", "False", "mpeg4"],
  ];
  for (const [codec, ffv1, name] of cases) {
    await buildProfile(userDir, { mode: "record", dumpCodec: codec });
    assert.equal(getInSection(gfx(), "Settings", "UseFFV1"), ffv1, codec);
    assert.equal(getInSection(gfx(), "Settings", "DumpCodec"), name, codec);
  }
});

test("omitting dumpCodec keeps the source profile's codec", async () => {
  await buildProfile(userDir, { mode: "record" });
  assert.equal(getInSection(gfx(), "Settings", "UseFFV1"), "True");
  assert.equal(getInSection(gfx(), "Settings", "DumpCodec"), null);
});

test("utvideo at native EFB is refused — 939 is odd and Dolphin would write no video", async () => {
  await assert.rejects(buildProfile(userDir, { mode: "record", efbScale: 2, dumpCodec: "utvideo" }), /even dump width/);
  writeReal("[DSP]\nBackend = ALSA\n", "[Settings]\nEFBScale = 2\n");
  await assert.rejects(buildProfile(userDir, { mode: "record", dumpCodec: "utvideo" }), /even dump width/);
});

test("dumpCodec is ignored in play mode, like bitrate", async () => {
  await buildProfile(userDir, { mode: "play", dumpCodec: "mpeg4" });
  assert.equal(getInSection(gfx(), "Settings", "UseFFV1"), "True");
});

// --- process env ------------------------------------------------------------

test("audioSink routes BOTH backends — ALSA ignores PULSE_SINK but honours PIPEWIRE_NODE", () => {
  const env = recordEnv({ HOME: "/h" }, { audioSink: "rec_1" });
  assert.equal(env.PULSE_SINK, "rec_1");
  assert.equal(env.PIPEWIRE_NODE, "rec_1");
  assert.equal(env.HOME, "/h");
});

test("appName overrides application.name so WirePlumber keys aren't shared by every Dolphin", () => {
  assert.equal(recordEnv({}, { appName: "jm-vod-1" }).PULSE_PROP_OVERRIDE, "application.name='jm-vod-1'");
  assert.throws(() => appNameProp("x'; y"), /appName/);
});

test("named options beat the caller's env, which beats the inherited env", () => {
  const env = recordEnv({ DISPLAY: ":0", A: "1" }, { env: { DISPLAY: ":5", A: "2" }, display: ":9" });
  assert.equal(env.DISPLAY, ":9");
  assert.equal(env.A, "2");
});

test("record() spawns Dolphin with the caller's env", async () => {
  const fake = path.join(tmp, "fake-dolphin.sh");
  fs.writeFileSync(
    fake,
    [
      "#!/bin/sh",
      'for a in "$@"; do case "$a" in --output-directory=*) d="${a#--output-directory=}";; esac; done',
      'printf "%s|%s|%s" "$MARK" "$PIPEWIRE_NODE" "$PULSE_PROP_OVERRIDE" > "$d/env.txt"',
      ': > "$d/dump.avi"',
      "exit 0",
      "",
    ].join("\n"),
  );
  fs.chmodSync(fake, 0o755);
  const iso = path.join(tmp, "melee.iso");
  fs.writeFileSync(iso, "");
  const slp = path.join(tmp, "g.slp");
  const val = Buffer.alloc(4);
  val.writeInt32BE(600);
  fs.writeFileSync(slp, Buffer.concat([Buffer.from("raw..lastFramel"), val, Buffer.from("}}")]));
  fs.mkdirSync(userDir);
  const outDir = path.join(tmp, "out");
  await record({ dolphinPath: fake, isoPath: iso }, slp, {
    userDir,
    outDir,
    env: { MARK: "m1" },
    audioSink: "s1",
    appName: "a1",
    bootStallMs: 5000,
  });
  assert.equal(fs.readFileSync(path.join(outDir, "env.txt"), "utf8"), "m1|s1|application.name='a1'");
});

// --- mirror -----------------------------------------------------------------

const PATHS = { dolphinPath: "/x/Slippi_Playback.AppImage", isoPath: "/x/melee.iso" };
const MIRROR = { userDir: "/tmp/u", commPath: "/tmp/c.json", captureName: "dolphin-1", efbScale: 3 };

test("a mirror defaults to real-time speed — unlimited fast-forwards on air", () => {
  assert.equal(obsMirrorProfile(PATHS, MIRROR).emulationSpeed, 1);
  assert.equal(obsMirrorProfile(PATHS, { ...MIRROR, emulationSpeed: 0 }).emulationSpeed, 0);
});

test("a mirror never pauses on focus loss, and hotkeys detach only when asked", () => {
  const p = obsMirrorProfile(PATHS, MIRROR);
  assert.equal(p.pauseOnFocusLost, false);
  assert.equal(p.detachHotkeys, undefined);
  assert.equal(obsMirrorProfile(PATHS, { ...MIRROR, detachHotkeys: true }).detachHotkeys, true);
});

test("a mirror is never silent — OBS reads its stream", () => {
  const p = obsMirrorProfile(PATHS, MIRROR);
  assert.equal(p.audioBackend, "Pulse");
  assert.equal(p.silent, undefined);
});

test("the caller's env can't clobber capture variables; its LD_PRELOAD stays in the middle", () => {
  const env = obsMirrorEnv(
    { LD_PRELOAD: "/inherited.so" },
    {
      ...MIRROR,
      exeOverrideShim: "/shim.so",
      pulseSink: "game1",
      appName: "mst-game1",
      env: { OBS_VKCAPTURE_EXE_NAME: "wrong", LD_PRELOAD: "/caller.so", EXTRA: "1" },
    },
  );
  assert.equal(env.OBS_VKCAPTURE_EXE_NAME, "dolphin-1");
  assert.equal(env.LD_PRELOAD, "/shim.so:/caller.so:/usr/$LIB/obs_glcapture/libobs_glcapture.so");
  assert.equal(env.EXTRA, "1");
  assert.equal(env.PULSE_SINK, "game1");
  assert.equal(env.PULSE_PROP_OVERRIDE, "application.name='mst-game1'");
});
