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

// --- Live/captured-window tuning (obsMirror's half) ---------------------------

test("REGRESSION: GFXBackend is CREATED, not just rewritten — a blank one captures black", async () => {
  // The fixture's real profile has no [Core] section at all, exactly like a
  // profile that has never been captured. A rewrite-only builder leaves it
  // absent → Dolphin picks Vulkan → obs-vkcapture's GL hook sees no swaps.
  await buildProfile(userDir, { mode: "play", gfxBackend: "OGL" });
  const dol = read(path.join(userDir, "Config", "Dolphin.ini"));
  assert.equal(getInSection(dol, "Core", "GFXBackend"), "OGL");
});

test("mirror tuning lands in the right sections", async () => {
  await buildProfile(userDir, {
    mode: "play",
    gfxBackend: "OGL",
    audioLatencyMs: 60,
    emulationSpeed: 0,
    audioBackend: "Pulse",
    volume: 100,
    window: { width: 1920, height: 1080, x: 10, y: 20 },
    vsync: false,
    shaderCompilationMode: 0,
    efbScale: 2,
  });
  const dol = read(path.join(userDir, "Config", "Dolphin.ini"));
  const gfx = read(path.join(userDir, "Config", "GFX.ini"));
  assert.equal(getInSection(dol, "Core", "Latency"), "60");
  assert.equal(getInSection(dol, "Core", "EmulationSpeed"), "0");
  assert.equal(getInSection(dol, "DSP", "Backend"), "Pulse");
  assert.equal(getInSection(dol, "DSP", "Volume"), "100");
  assert.equal(getInSection(dol, "Display", "Fullscreen"), "False");
  assert.equal(getInSection(dol, "Display", "RenderWindowAutoSize"), "False");
  assert.equal(getInSection(dol, "Display", "RenderWindowWidth"), "1920");
  assert.equal(getInSection(dol, "Display", "RenderWindowHeight"), "1080");
  assert.equal(getInSection(dol, "Display", "RenderWindowXPos"), "10");
  assert.equal(getInSection(dol, "Display", "RenderWindowYPos"), "20");
  assert.equal(getInSection(gfx, "Hardware", "VSync"), "False");
  assert.equal(getInSection(gfx, "Settings", "ShaderCompilationMode"), "0");
  assert.equal(getInSection(gfx, "Settings", "EFBScale"), "2");
  // The DSP fixture's existing Backend line was rewritten, not duplicated.
  assert.equal(dol.match(/^Backend = /gm)?.length, 1);
  // And play mode still never dumps.
  assert.equal(getInSection(dol, "Movie", "DumpFrames"), "False");
});

test("tuning is opt-in: a plain build leaves the copy's values alone", async () => {
  await buildProfile(userDir, { mode: "play" });
  const dol = read(path.join(userDir, "Config", "Dolphin.ini"));
  assert.equal(getInSection(dol, "Core", "GFXBackend"), null);
  assert.equal(getInSection(dol, "DSP", "Backend"), "ALSA");
});

test("shader cache: Cache/ becomes a symlink to the persistent dir, and is repointed if stale", async () => {
  const cacheA = path.join(tmp, "shaders-A");
  const cacheB = path.join(tmp, "shaders-B");
  await buildProfile(userDir, { mode: "play", shaderCacheDir: cacheA });
  const link = path.join(userDir, "Cache");
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readlinkSync(link), cacheA);
  assert.ok(fs.statSync(cacheA).isDirectory(), "target is created");

  // A second build on the same userDir with a different target repoints it.
  await buildProfile(userDir, { mode: "play", shaderCacheDir: cacheB });
  assert.equal(fs.readlinkSync(link), cacheB);

  // A REAL Cache dir left by an earlier untuned run is replaced too.
  fs.unlinkSync(link);
  fs.mkdirSync(link);
  fs.writeFileSync(path.join(link, "stale.cache"), "x");
  await buildProfile(userDir, { mode: "play", shaderCacheDir: cacheA });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readlinkSync(link), cacheA);
});

test("window: fullscreen sets Fullscreen=True and leaves the geometry keys alone", async () => {
  await buildProfile(userDir, { mode: "play", window: { fullscreen: true } });
  const dol = read(path.join(userDir, "Config", "Dolphin.ini"));
  assert.equal(getInSection(dol, "Display", "Fullscreen"), "True");
  assert.equal(getInSection(dol, "Display", "RenderWindowWidth"), null);
});

// --- things consumers had to do by hand after calling buildProfile ----------

test("REGRESSION: EFBScale is set in EVERY section, not just [Settings]", async () => {
  // Ishiiruka keeps a second one under [Hacks]. Two consumers independently
  // patched all occurrences after calling us because leaving them disagreeing
  // dumps at the wrong internal resolution.
  fs.writeFileSync(
    path.join(realRoot, "Config", "GFX.ini"),
    ["[Settings]", "EFBScale = 4", "UseFFV1 = True", "[Hacks]", "EFBScale = 4", "EFBScaledCopy = True", ""].join("\n"),
  );
  await buildProfile(userDir, { mode: "record", efbScale: 2 });
  const gfx = read(path.join(userDir, "Config", "GFX.ini"));
  assert.equal(getInSection(gfx, "Settings", "EFBScale"), "2");
  assert.equal(getInSection(gfx, "Hacks", "EFBScale"), "2");
});

test("record mode pins the dump container — 'produced no video' after a full run is not a diagnosis", async () => {
  await buildProfile(userDir, { mode: "record" });
  const gfx = read(path.join(userDir, "Config", "GFX.ini"));
  assert.equal(getInSection(gfx, "Settings", "DumpFormat"), "avi");
  assert.equal(getInSection(gfx, "Settings", "DumpFramesAsImages"), "False");
});

test("dumpFormat is overridable for a consumer that wants something else", async () => {
  await buildProfile(userDir, { mode: "record", dumpFormat: "mkv" });
  assert.equal(getInSection(read(path.join(userDir, "Config", "GFX.ini")), "Settings", "DumpFormat"), "mkv");
});

test("play mode does not touch the dump container", async () => {
  await buildProfile(userDir, { mode: "play" });
  assert.equal(getInSection(read(path.join(userDir, "Config", "GFX.ini")), "Settings", "DumpFormat"), null);
});

test("texture packs are linked into Load/Textures/<gameId>/ and turn HiresTextures on", async () => {
  const pack = path.join(tmp, "my-pack");
  fs.mkdirSync(pack, { recursive: true });
  fs.writeFileSync(path.join(pack, "tex_abc.png"), "x");
  await buildProfile(userDir, { mode: "record", texturePacks: [pack] });
  const dest = path.join(userDir, "Load", "Textures", "GALE01", "my-pack");
  assert.ok(fs.existsSync(path.join(dest, "tex_abc.png")), "the pack's files are reachable");
  assert.equal(getInSection(read(path.join(userDir, "Config", "GFX.ini")), "Settings", "HiresTextures"), "True");
});

test("texture packs follow gameSettingsId, not a hardcoded GALE01", async () => {
  const pack = path.join(tmp, "p2");
  fs.mkdirSync(pack, { recursive: true });
  await buildProfile(userDir, { mode: "record", texturePacks: [pack], gameSettingsId: "GALJ01" });
  assert.ok(fs.existsSync(path.join(userDir, "Load", "Textures", "GALJ01", "p2")));
});

test("a re-run repoints a texture pack instead of stacking onto the old one", async () => {
  const a = path.join(tmp, "pack-a");
  fs.mkdirSync(a, { recursive: true });
  fs.writeFileSync(path.join(a, "a.png"), "a");
  await buildProfile(userDir, { mode: "record", texturePacks: [a] });
  fs.writeFileSync(path.join(a, "b.png"), "b");
  await buildProfile(userDir, { mode: "record", texturePacks: [a] });
  const dest = path.join(userDir, "Load", "Textures", "GALE01", "pack-a");
  assert.deepEqual(fs.readdirSync(dest).sort(), ["a.png", "b.png"]);
});

test("GC/SRAM.raw is carried into a record profile — the language and sound settings", async () => {
  fs.mkdirSync(path.join(realRoot, "GC"), { recursive: true });
  fs.writeFileSync(path.join(realRoot, "GC", "SRAM.raw"), "sram-bytes");
  await buildProfile(userDir, { mode: "record" });
  assert.equal(read(path.join(userDir, "GC", "SRAM.raw")), "sram-bytes");
});

test("a missing SRAM.raw is normal, never fatal", async () => {
  await buildProfile(userDir, { mode: "record" }); // no GC/ in the fixture
  assert.ok(!fs.existsSync(path.join(userDir, "GC", "SRAM.raw")));
});

test("copyFromProfile carries arbitrary assets and replaces the SRAM default", async () => {
  fs.mkdirSync(path.join(realRoot, "GC"), { recursive: true });
  fs.writeFileSync(path.join(realRoot, "GC", "SRAM.raw"), "sram");
  fs.mkdirSync(path.join(realRoot, "Load"), { recursive: true });
  fs.writeFileSync(path.join(realRoot, "Load", "thing.bin"), "t");
  await buildProfile(userDir, { mode: "record", copyFromProfile: ["Load/thing.bin"] });
  assert.equal(read(path.join(userDir, "Load", "thing.bin")), "t");
  assert.ok(!fs.existsSync(path.join(userDir, "GC", "SRAM.raw")), "the caller's list replaces the default");
});
