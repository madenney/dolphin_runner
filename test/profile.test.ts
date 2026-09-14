/**
 * Profile-builder regressions. These lock in the isolation rule: a build must
 * produce a correct throwaway profile from the real one WITHOUT ever touching
 * the real one, and must preserve the quality-critical settings the in-place
 * code used to depend on — notably GFX `UseFFV1`, which keeps the lossless
 * intermediate that feeds the consumer's re-encode.
 *
 * The "real" profile is faked through XDG_CONFIG_HOME so resolveRealProfile's
 * Linux branch reads our fixtures.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProfile, healRealProfile } from "../src/profile.ts";
import { getInSection } from "../src/ini.ts";
import { profileAt } from "../src/paths.ts";

const DOLPHIN_INI = [
  "[Movie]",
  "DumpFrames = False",
  "DumpFramesSilent = False",
  "DumpAudio = False",
  "DumpAudioSilent = False",
  "[DSP]",
  "DumpAudio = False",
  "DumpAudioSilent = False",
  "Backend = ALSA",
  "[Interface]",
  "ConfirmStop = False",
  "",
].join("\n");

const GFX_INI = [
  "[Settings]",
  "AspectRatio = 2",
  "InternalResolutionFrameDumps = False",
  "BitrateKbps = 25000",
  "EFBScale = 4",
  "UseFFV1 = True",
  "",
].join("\n");

let tmp: string;
let realRoot: string;
let userDir: string;
let prevXdg: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dr-test-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmp;
  realRoot = path.join(tmp, "SlippiPlayback");
  fs.mkdirSync(path.join(realRoot, "Config"), { recursive: true });
  fs.mkdirSync(path.join(realRoot, "GameSettings"), { recursive: true });
  fs.writeFileSync(path.join(realRoot, "Config", "Dolphin.ini"), DOLPHIN_INI);
  fs.writeFileSync(path.join(realRoot, "Config", "GFX.ini"), GFX_INI);
  fs.writeFileSync(path.join(realRoot, "Config", "Logger.ini"), "[Logger]\nWriteToFile = True\n");
  fs.writeFileSync(path.join(realRoot, "GameSettings", "GALE01.ini"), "[Gecko]\n");
  userDir = path.join(tmp, "worker-1");
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const read = (p: string) => fs.readFileSync(p, "utf8");

test("record mode turns every dump flag on, in BOTH sections", async () => {
  await buildProfile(userDir, { mode: "record" });
  const dol = read(path.join(userDir, "Config", "Dolphin.ini"));
  assert.equal(getInSection(dol, "Movie", "DumpFrames"), "True");
  assert.equal(getInSection(dol, "Movie", "DumpFramesSilent"), "True");
  assert.equal(getInSection(dol, "Movie", "DumpAudio"), "True");
  assert.equal(getInSection(dol, "Movie", "DumpAudioSilent"), "True");
  // [DSP] carries its own audio dump flags and a frame dump needs both.
  assert.equal(getInSection(dol, "DSP", "DumpAudio"), "True");
  assert.equal(getInSection(dol, "DSP", "DumpAudioSilent"), "True");
});

test("record mode sets the dump geometry", async () => {
  await buildProfile(userDir, { mode: "record", efbScale: 6, aspectRatio: 6, bitrateKbps: 60000 });
  const gfx = read(path.join(userDir, "Config", "GFX.ini"));
  assert.equal(getInSection(gfx, "Settings", "InternalResolutionFrameDumps"), "True");
  assert.equal(getInSection(gfx, "Settings", "EFBScale"), "6");
  assert.equal(getInSection(gfx, "Settings", "AspectRatio"), "6");
  assert.equal(getInSection(gfx, "Settings", "BitrateKbps"), "60000");
});

test("UseFFV1 survives into every built profile", async () => {
  for (const mode of ["record", "play"] as const) {
    const dir = path.join(tmp, `p-${mode}`);
    await buildProfile(dir, { mode });
    assert.equal(
      getInSection(read(path.join(dir, "Config", "GFX.ini")), "Settings", "UseFFV1"),
      "True",
      `${mode} dropped UseFFV1 — that silently degrades the intermediate`,
    );
  }
});

test("play mode never framedumps", async () => {
  await buildProfile(userDir, { mode: "play", efbScale: 2 });
  const dol = read(path.join(userDir, "Config", "Dolphin.ini"));
  for (const k of ["DumpFrames", "DumpFramesSilent", "DumpAudio", "DumpAudioSilent"]) {
    assert.equal(getInSection(dol, "Movie", k), "False", `${k} must be off for playback`);
  }
  assert.equal(getInSection(read(path.join(userDir, "Config", "GFX.ini")), "Settings", "EFBScale"), "2");
});

test("THE REAL PROFILE IS NEVER TOUCHED", async () => {
  const before = {
    dolphin: read(path.join(realRoot, "Config", "Dolphin.ini")),
    gfx: read(path.join(realRoot, "Config", "GFX.ini")),
    gecko: read(path.join(realRoot, "GameSettings", "GALE01.ini")),
  };
  await buildProfile(userDir, { mode: "record", efbScale: 6, geckoIni: "[Gecko]\n$Something\n" });
  assert.equal(read(path.join(realRoot, "Config", "Dolphin.ini")), before.dolphin);
  assert.equal(read(path.join(realRoot, "Config", "GFX.ini")), before.gfx);
  assert.equal(read(path.join(realRoot, "GameSettings", "GALE01.ini")), before.gecko);
});

test("unrelated inis are carried across untouched", async () => {
  await buildProfile(userDir, { mode: "record" });
  assert.equal(read(path.join(userDir, "Config", "Logger.ini")), "[Logger]\nWriteToFile = True\n");
  // Settings we do not override must survive — the window/audio config that
  // makes a mirror window look like the user's own Dolphin.
  const dol = read(path.join(userDir, "Config", "Dolphin.ini"));
  assert.equal(getInSection(dol, "DSP", "Backend"), "ALSA");
  assert.equal(getInSection(dol, "Interface", "ConfirmStop"), "False");
});

test("gecko ini is written verbatim", async () => {
  const gecko = "[Gecko]\n$Center Align 2P HUD\nC216E9AC 00000009\n";
  await buildProfile(userDir, { mode: "record", geckoIni: gecko });
  assert.equal(read(path.join(userDir, "GameSettings", "GALE01.ini")), gecko);
});

test("record mode isolates input so a worker cannot grab real controllers", async () => {
  await buildProfile(userDir, { mode: "record" });
  assert.match(read(path.join(userDir, "Config", "Hotkeys.ini")), /\[Hotkeys1\][\s\S]*Device = \/0\//);
});

test("a profile that has never dumped still gets the dump keys created", async () => {
  // Fresh install: no dump keys at all. Only rewriting existing lines would
  // silently produce a window-resolution dump with no audio.
  fs.writeFileSync(path.join(realRoot, "Config", "GFX.ini"), "[Settings]\nEFBScale = 1\n");
  fs.writeFileSync(path.join(realRoot, "Config", "Dolphin.ini"), "[Interface]\nConfirmStop = False\n");
  await buildProfile(userDir, { mode: "record" });
  assert.equal(
    getInSection(read(path.join(userDir, "Config", "GFX.ini")), "Settings", "InternalResolutionFrameDumps"),
    "True",
  );
  assert.equal(getInSection(read(path.join(userDir, "Config", "Dolphin.ini")), "Movie", "DumpFrames"), "True");
});

test("a missing real profile fails loudly, not silently", async () => {
  await assert.rejects(
    () => buildProfile(userDir, { mode: "record", sourceProfile: profileAt(path.join(tmp, "nope")) }),
    /no Slippi Playback profile/,
  );
});

test("healRealProfile forces the real dump flags off", async () => {
  fs.writeFileSync(
    path.join(realRoot, "Config", "Dolphin.ini"),
    "[Movie]\nDumpFrames = True\nDumpAudio = True\n",
  );
  await healRealProfile("");
  const dol = read(path.join(realRoot, "Config", "Dolphin.ini"));
  assert.equal(getInSection(dol, "Movie", "DumpFrames"), "False");
  assert.equal(getInSection(dol, "Movie", "DumpAudio"), "False");
});
