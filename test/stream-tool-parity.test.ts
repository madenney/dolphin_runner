/**
 * Stream-tool cut-over parity: everything its in-process mirror launch did must be
 * expressible through obs-mirror — a fresh (non-copied) profile, MSAA, the
 * GALE01r2 GameSettings name, Vulkan-on-request, and a capture-off launch.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProfile } from "../src/profile.ts";
import { getInSection } from "../src/ini.ts";
import { profileAt } from "../src/paths.ts";
import { obsMirrorEnv, obsMirrorProfile } from "../src/obs.ts";

let tmp: string;
let realRoot: string;
let userDir: string;
let prevXdg: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dr-parity-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmp;
  realRoot = path.join(tmp, "SlippiPlayback");
  fs.mkdirSync(path.join(realRoot, "Config"), { recursive: true });
  fs.mkdirSync(path.join(realRoot, "GameSettings"), { recursive: true });
  fs.writeFileSync(
    path.join(realRoot, "Config", "Dolphin.ini"),
    "[DSP]\nBackend = ALSA\n[Interface]\nConfirmStop = False\n[Core]\nGFXBackend = \n",
  );
  fs.writeFileSync(path.join(realRoot, "Config", "GFX.ini"), "[Settings]\nEFBScale = 7\nUseFFV1 = True\n");
  fs.writeFileSync(path.join(realRoot, "Config", "Logger.ini"), "[Logger]\n");
  fs.writeFileSync(path.join(realRoot, "GameSettings", "GALE01.ini"), "[Gecko]\n$Real\n");
  userDir = path.join(tmp, "setup-1");
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const read = (p: string) => fs.readFileSync(p, "utf8");
const snapshot = () =>
  ["Config/Dolphin.ini", "Config/GFX.ini", "Config/Logger.ini", "GameSettings/GALE01.ini"].map((f) =>
    read(path.join(realRoot, f)),
  );

test("freshProfile copies NOTHING from the real profile and creates every override", async () => {
  const before = snapshot();
  await buildProfile(userDir, {
    mode: "play",
    freshProfile: true,
    gfxBackend: "OGL",
    audioLatencyMs: 60,
    audioBackend: "Pulse",
    volume: 100,
    window: { fullscreen: true },
    efbScale: 3,
    msaa: 4,
    vsync: false,
    shaderCompilationMode: 0,
  });
  const dol = read(path.join(userDir, "Config", "Dolphin.ini"));
  const gfx = read(path.join(userDir, "Config", "GFX.ini"));
  // The real profile's own values must not leak in.
  assert.equal(getInSection(dol, "DSP", "Backend"), "Pulse");
  assert.equal(getInSection(dol, "Interface", "ConfirmStop"), null);
  assert.equal(getInSection(gfx, "Settings", "UseFFV1"), null);
  assert.equal(fs.existsSync(path.join(userDir, "Config", "Logger.ini")), false);
  assert.equal(fs.existsSync(path.join(userDir, "GameSettings", "GALE01.ini")), false);
  // Every key the stream tool's legacy launch wrote exists.
  assert.equal(getInSection(dol, "Core", "GFXBackend"), "OGL");
  assert.equal(getInSection(dol, "Core", "Latency"), "60");
  assert.equal(getInSection(dol, "DSP", "Volume"), "100");
  assert.equal(getInSection(dol, "Display", "Fullscreen"), "True");
  assert.equal(getInSection(gfx, "Settings", "EFBScale"), "3");
  assert.equal(getInSection(gfx, "Settings", "MSAA"), "4");
  assert.equal(getInSection(gfx, "Settings", "SSAA"), "False");
  assert.equal(getInSection(gfx, "Hardware", "VSync"), "False");
  assert.equal(getInSection(gfx, "Settings", "ShaderCompilationMode"), "0");
  // Play mode never creates dump flags in a fresh profile (absent = off).
  assert.equal(getInSection(dol, "Movie", "DumpFrames"), null);
  assert.deepEqual(snapshot(), before, "the real profile must never be written");
});

test("freshProfile works with no real profile on the machine at all", async () => {
  await buildProfile(userDir, {
    mode: "play",
    freshProfile: true,
    sourceProfile: profileAt(path.join(tmp, "nope")),
    gfxBackend: "OGL",
  });
  assert.equal(getInSection(read(path.join(userDir, "Config", "Dolphin.ini")), "Core", "GFXBackend"), "OGL");
});

test("freshProfile rebuilds from scratch: a previous launch's keys do not survive", async () => {
  await buildProfile(userDir, { mode: "play", freshProfile: true, emulationSpeed: 2 });
  await buildProfile(userDir, { mode: "play", freshProfile: true });
  assert.equal(getInSection(read(path.join(userDir, "Config", "Dolphin.ini")), "Core", "EmulationSpeed"), null);
});

test("msaa only passes Dolphin's sample counts", async () => {
  for (const [given, want] of [
    [4, "4"],
    [8, "8"],
    [3, "1"],
    [0, "1"],
  ] as const) {
    await buildProfile(userDir, { mode: "play", msaa: given });
    assert.equal(getInSection(read(path.join(userDir, "Config", "GFX.ini")), "Settings", "MSAA"), want);
  }
});

test("gecko ini goes to the requested GameSettings id; a path-like id is refused", async () => {
  await buildProfile(userDir, { mode: "play", geckoIni: "[Gecko]\n", gameSettingsId: "GALE01r2" });
  assert.equal(read(path.join(userDir, "GameSettings", "GALE01r2.ini")), "[Gecko]\n");
  await assert.rejects(
    () => buildProfile(userDir, { mode: "play", geckoIni: "x", gameSettingsId: "../evil" }),
    /bad gameSettingsId/,
  );
});

test("capture off: no preload at all (inherited dropped), vkcapture off, routing kept", () => {
  const env = obsMirrorEnv(
    { LD_PRELOAD: "/inherited.so" },
    { captureName: "dolphin-5", exeOverrideShim: "/shim.so", pulseSink: "game5", capture: false },
  );
  assert.equal("LD_PRELOAD" in env, false);
  assert.equal(env.OBS_VKCAPTURE, "0");
  assert.equal(env.OBS_VKCAPTURE_EXE_NAME, "dolphin-5");
  assert.equal(env.PULSE_SINK, "game5");
  assert.equal(env.PULSE_LATENCY_MSEC, "120");
});

test("profile: OGL by default, Vulkan only when asked, the stream tool's knobs pass through", () => {
  const paths = { dolphinPath: "/d/Dolphin", isoPath: "/i/melee.iso" };
  const base = { userDir: "/u", commPath: "/c.json", captureName: "dolphin-1", efbScale: 3 };
  const p = obsMirrorProfile(paths, base);
  assert.equal(p.gfxBackend, "OGL");
  assert.equal(p.mode, "play");
  assert.equal(p.vsync, false);
  assert.equal(p.shaderCompilationMode, 0);
  assert.equal(p.audioBackend, "Pulse");
  assert.equal(p.volume, 100);
  assert.equal(p.audioLatencyMs, 60);
  assert.deepEqual(p.window, { fullscreen: true });
  const q = obsMirrorProfile(paths, {
    ...base,
    gfxBackend: "Vulkan",
    msaa: 4,
    freshProfile: true,
    gameSettingsId: "GALE01r2",
    emulationSpeed: 1,
  });
  assert.equal(q.gfxBackend, "Vulkan");
  assert.equal(q.msaa, 4);
  assert.equal(q.freshProfile, true);
  assert.equal(q.gameSettingsId, "GALE01r2");
  assert.equal(q.emulationSpeed, 1);
});
