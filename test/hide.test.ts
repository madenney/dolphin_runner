/**
 * `hide` — the per-OS invisible-recording option. These pin the PURE parts:
 * which ini each OS writes, how a session is detected and dispatched, option
 * validation, the compositor/mac/win argv, and the report. The Windows and
 * macOS runtime paths are unverified (no rig); the Linux EWMH parking is also
 * exercised end to end by test/hide-e2e or the smoke harness.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProfile, HIDDEN_RECORD, BACKGROUND_RECORD } from "../src/profile.ts";
import { getInSection } from "../src/ini.ts";
import { profileAt } from "../src/paths.ts";
import {
  planHide,
  normalizeHide,
  detectSession,
  hideDolphinIniDirectives,
  compositorMoveArgs,
  resolveHideLauncher,
  bundledHideLauncher,
  nextHideDesktopName,
} from "../src/hide.ts";
import { createHideController } from "../src/run.ts";
import { loadWinNative, unavailableNative, _resetWinNativeCache, type WinNativeBackend } from "../src/win-native.ts";
import { macRecorderCacheKey, macRecorderBuildSteps, macHideByPidArgs, DEFAULT_MAC_IDENTITY } from "../src/mac-hide.ts";

let tmp: string;
let realRoot: string;
let userDir: string;
let prevXdg: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dr-hide-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmp;
  realRoot = path.join(tmp, "SlippiPlayback");
  fs.mkdirSync(path.join(realRoot, "Config"), { recursive: true });
  fs.mkdirSync(path.join(realRoot, "GameSettings"), { recursive: true });
  fs.writeFileSync(path.join(realRoot, "Config", "Dolphin.ini"), "[Display]\nFullscreen = True\n");
  fs.writeFileSync(path.join(realRoot, "Config", "GFX.ini"), "[Settings]\nEFBScale = 6\n");
  userDir = path.join(tmp, "worker-1");
});

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  fs.rmSync(tmp, { recursive: true, force: true });
  _resetWinNativeCache();
});

const dol = () => fs.readFileSync(profileAt(userDir).dolphinIni, "utf8");

// --- normalizeHide ----------------------------------------------------------

test("normalizeHide: falsy is null, true is window, explicit passes through", () => {
  assert.equal(normalizeHide(undefined), null);
  assert.equal(normalizeHide(false), null);
  assert.equal(normalizeHide(true), "window");
  assert.equal(normalizeHide("window"), "window");
  assert.equal(normalizeHide("desktop"), "desktop");
});

// --- per-OS ini -------------------------------------------------------------

test("Windows hide forces a single hidden main window and DX11", () => {
  const d = hideDolphinIniDirectives("win32");
  const get = (section: string, key: string) => d.find((x) => x.section === section && x.key === key)?.value;
  assert.equal(get("Display", "RenderToMain"), "True"); // SW_HIDE then covers everything
  assert.equal(get("Display", "Fullscreen"), "False");
  assert.equal(get("Display", "DisableScreenSaver"), "False"); // don't keep the monitor awake
  assert.equal(get("Interface", "MainWindowWidth"), "640"); // backbuffer size under RenderToMain
  assert.equal(get("Core", "GFXBackend"), "DX11");
});

test("Windows hide does NOT pin DX11 when the caller chose a backend", () => {
  const d = hideDolphinIniDirectives("win32", { hasGfxBackend: true });
  assert.equal(d.find((x) => x.key === "GFXBackend"), undefined);
});

test("macOS hide forces OGL (occluded Vulkan stalls) and nothing else", () => {
  const d = hideDolphinIniDirectives("darwin");
  assert.deepEqual(d, [{ section: "Core", key: "GFXBackend", value: "OGL" }]);
  assert.deepEqual(hideDolphinIniDirectives("darwin", { hasGfxBackend: true }), []);
});

test("Linux hide writes NO extra ini (the window is parked, not reshaped)", () => {
  assert.deepEqual(hideDolphinIniDirectives("linux"), []);
});

test("buildProfile applies the Windows hide recipe in record mode", async () => {
  await buildProfile(userDir, { mode: "record", hide: true, platform: "win32" });
  assert.equal(getInSection(dol(), "Display", "RenderToMain"), "True");
  assert.equal(getInSection(dol(), "Core", "GFXBackend"), "DX11");
  assert.equal(getInSection(dol(), "Interface", "MainWindowHeight"), "360");
});

test("an explicit gfxBackend wins over hide's DX11 pin", async () => {
  await buildProfile(userDir, { mode: "record", hide: true, platform: "win32", gfxBackend: "Vulkan" });
  assert.equal(getInSection(dol(), "Core", "GFXBackend"), "Vulkan");
});

test("hide does nothing to a PLAY profile (record mode only)", async () => {
  await buildProfile(userDir, { mode: "play", hide: true, platform: "win32" });
  assert.equal(getInSection(dol(), "Display", "RenderToMain"), null);
});

test("HIDDEN_RECORD is BACKGROUND_RECORD plus hide", () => {
  assert.equal(HIDDEN_RECORD.hide, true);
  assert.equal(HIDDEN_RECORD.window.width, BACKGROUND_RECORD.window.width);
  assert.equal((HIDDEN_RECORD as { silent?: boolean }).silent, undefined); // consumer's call
});

// --- session detection ------------------------------------------------------

test("detectSession reads server and compositor from the environment", () => {
  assert.deepEqual(detectSession({ XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "GNOME", DISPLAY: ":0" }), {
    server: "x11",
    compositor: "gnome",
  });
  assert.deepEqual(detectSession({ XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "KDE" }), {
    server: "xwayland",
    compositor: "kde",
  });
  assert.equal(detectSession({ XDG_CURRENT_DESKTOP: "sway", SWAYSOCK: "/run/sway" }).compositor, "sway");
  assert.equal(detectSession({ HYPRLAND_INSTANCE_SIGNATURE: "x" }).compositor, "hyprland");
});

// --- planHide: per-OS selection --------------------------------------------

test("planHide Windows: hidden window, spawn hidden, native wanted, unverified", () => {
  const p = planHide(true, "win32", {})!;
  assert.equal(p.method, "windows-hidden-window");
  assert.equal(p.spawnHidden, true);
  assert.equal(p.wantNative, true);
  assert.equal(p.useDesktopLauncher, false);
  assert.equal(p.verified, false);
});

test("planHide Windows desktop: the launcher, and no koffi calls (it does QoS itself)", () => {
  const p = planHide("desktop", "win32", {})!;
  assert.equal(p.method, "windows-desktop");
  assert.equal(p.useDesktopLauncher, true);
  assert.equal(p.wantNative, false);
});

// --- the desktop launcher ----------------------------------------------------

test("resolveHideLauncher: explicit, then env, then bundled; null when none exists", () => {
  const have = new Set(["C:/a.exe", "C:/env.exe", "C:/bundled.exe"]);
  const exists = (p: string) => have.has(p);
  const env = { DOLPHIN_RUNNER_HIDE_LAUNCHER: "C:/env.exe" };
  assert.equal(resolveHideLauncher("C:/a.exe", env, exists, "C:/bundled.exe"), "C:/a.exe");
  assert.equal(resolveHideLauncher("C:/missing.exe", env, exists, "C:/bundled.exe"), "C:/env.exe");
  assert.equal(resolveHideLauncher(undefined, {}, exists, "C:/bundled.exe"), "C:/bundled.exe");
  assert.equal(resolveHideLauncher(undefined, {}, () => false, "C:/bundled.exe"), null);
});

test("the bundled launcher path is <package>/native/win/bin/lunar-hidden-launcher.exe", () => {
  const p = bundledHideLauncher();
  assert.equal(path.basename(p), "lunar-hidden-launcher.exe");
  assert.equal(path.basename(path.dirname(p)), "bin");
  assert.equal(path.resolve(p, "..", "..", "..", ".."), path.resolve(import.meta.dirname, ".."));
});

test("desktop names are unique per run", () => {
  const a = nextHideDesktopName(42);
  const b = nextHideDesktopName(42);
  assert.match(a, /^LunarRec-42-\d+$/);
  assert.notEqual(a, b);
});

test("controller Windows desktop: spawns through the launcher on its own desktop", async () => {
  const c = createHideController({ hide: "desktop", hideLauncherPath: "C:/l.exe" }, undefined, {
    platform: "win32",
    env: {},
    findLauncher: (explicit) => explicit ?? null,
    loadNative: () => {
      throw new Error("desktop mode must not load koffi");
    },
  })!;
  assert.equal(c.desktop?.launcher, "C:/l.exe");
  assert.match(c.desktop!.name, /^LunarRec-\d+-\d+$/);
  c.beforeSpawn();
  c.onSpawn(7);
  const r = await c.finalize(null);
  assert.equal(r.method, "windows-desktop");
  assert.deepEqual(r.desktop, { launcher: "C:/l.exe", name: c.desktop!.name });
  assert.equal(r.native, null);
});

test("controller Windows desktop without a launcher: hidden window instead, with a warning", async () => {
  const warnings: string[] = [];
  const c = createHideController({ hide: "desktop", onWarning: (w) => warnings.push(w.code) }, undefined, {
    platform: "win32",
    env: {},
    findLauncher: () => null,
    loadNative: () => null,
  })!;
  assert.equal(c.desktop, null);
  assert.equal(c.spawnHidden, true);
  c.beforeSpawn();
  const r = await c.finalize(null);
  assert.equal(r.method, "windows-hidden-window");
  assert.deepEqual(r.desktop, { launcher: null, name: null });
  assert.ok(warnings.includes("hide-desktop-unavailable"));
});

test("planHide macOS: accessory app, unverified, and desktop falls back with a warning", () => {
  const p = planHide("desktop", "darwin", {})!;
  assert.equal(p.method, "mac-accessory");
  assert.equal(p.macAccessory, true);
  assert.equal(p.verified, false);
  assert.equal(p.warnings[0]?.code, "hide-desktop-fallback");
});

test("planHide Linux GNOME/X11: EWMH parking on the last workspace", () => {
  const p = planHide(true, "linux", { XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "GNOME", DISPLAY: ":0" })!;
  assert.equal(p.method, "linux-parking");
  assert.equal(p.parkWorkspace, "last");
  assert.equal(p.verified, true);
});

test("planHide Linux sway/Hyprland: move by pid through the compositor", () => {
  assert.equal(planHide(true, "linux", { XDG_CURRENT_DESKTOP: "sway" })!.compositorMove, "sway");
  assert.equal(planHide(true, "linux", { XDG_CURRENT_DESKTOP: "Hyprland" })!.compositorMove, "hyprland");
});

test("planHide Linux wlroots without known IPC: honest unsupported, no pretend", () => {
  const p = planHide(true, "linux", { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0", XDG_CURRENT_DESKTOP: "river" })!;
  assert.equal(p.method, "none");
  assert.equal(p.warnings[0]?.code, "hide-session-unsupported");
});

test("planHide off is null", () => {
  assert.equal(planHide(false, "win32", {}), null);
  assert.equal(planHide(undefined, "linux", {}), null);
});

// --- compositor argv --------------------------------------------------------

test("compositorMoveArgs: sway scratchpad, Hyprland silent special, both by pid", () => {
  assert.deepEqual(compositorMoveArgs("sway", 42), { cmd: "swaymsg", args: ["[pid=42] move scratchpad"] });
  assert.deepEqual(compositorMoveArgs("hyprland", 42), {
    cmd: "hyprctl",
    args: ["dispatch", "movetoworkspacesilent", "special:lunar,pid:42"],
  });
});

// --- the controller (injected platform/env/exec/native) --------------------

test("controller Windows: spawn hidden, QoS high, foreground locked, report unverified", async () => {
  const calls: string[] = [];
  const fakeNative: WinNativeBackend = {
    setHighQos: (pid) => (calls.push(`qos ${pid}`), true),
    lockForeground: () => (calls.push("lock"), true),
    unlockForeground: () => (calls.push("unlock"), true),
  };
  const c = createHideController({ hide: true }, undefined, {
    platform: "win32",
    env: {},
    loadNative: () => fakeNative,
  })!;
  assert.equal(c.spawnHidden, true);
  c.beforeSpawn();
  c.onSpawn(1234);
  const report = await c.finalize(null);
  c.cleanup();
  assert.equal(report.method, "windows-hidden-window");
  assert.equal(report.verified, false);
  assert.equal(report.spawnHidden, true);
  assert.equal(report.native?.qos, "high");
  assert.equal(report.native?.foregroundLock, "locked");
  assert.ok(calls.includes("lock") && calls.includes("qos 1234"));
});

test("controller Windows without koffi: warns, reports unavailable, still hides", async () => {
  const warnings: string[] = [];
  const c = createHideController({ hide: true, onWarning: (w) => warnings.push(w.code) }, undefined, {
    platform: "win32",
    env: {},
    loadNative: () => null,
  })!;
  c.beforeSpawn();
  c.onSpawn(1);
  const report = await c.finalize(null);
  assert.equal(report.spawnHidden, true); // windowsHide needs no native
  assert.equal(report.native?.available, false);
  assert.ok(warnings.includes("hide-native-unavailable"));
});

test("controller Linux parking: synthesizes a last-workspace placement", () => {
  const c = createHideController({ hide: true }, ":0", {
    platform: "linux",
    env: { XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "GNOME", DISPLAY: ":0" },
  })!;
  assert.equal(c.spawnHidden, false);
  assert.deepEqual(c.placement, { workspace: "last", restoreFocus: true, display: ":0" });
});

test("controller Linux parking: an explicit placement wins (no synthesis)", () => {
  const c = createHideController({ hide: true, placement: { workspace: 3 } }, ":0", {
    platform: "linux",
    env: { XDG_CURRENT_DESKTOP: "GNOME", DISPLAY: ":0" },
  })!;
  // The controller does not override an explicit placement; record() uses o.placement.
  assert.equal(c.placement, undefined);
});

test("controller Linux sway: moves each pid by the compositor and reports them", async () => {
  const moved: string[] = [];
  const exec = async (cmd: string, args: string[]) => (moved.push(`${cmd} ${args.join(" ")}`), true);
  const ac = new AbortController();
  const c = createHideController({ hide: true, signal: ac.signal }, undefined, {
    platform: "linux",
    env: { XDG_CURRENT_DESKTOP: "sway" },
    exec,
  })!;
  c.beforeSpawn();
  c.onSpawn(process.pid); // a real pid so pidTree returns at least itself
  await new Promise((r) => setTimeout(r, 50)); // let the first move land, then end the loop
  ac.abort();
  const report = await c.finalize(null);
  assert.equal(report.method, "linux-compositor");
  assert.equal(report.compositor?.kind, "sway");
  assert.ok(report.compositor!.movedPids.includes(process.pid));
  assert.ok(moved.some((m) => m.startsWith("swaymsg [pid=")));
});

test("controller macOS: hides by pid, report carries the accessory method unverified", async () => {
  const ran: string[] = [];
  const exec = async (cmd: string, args: string[]) => (ran.push(cmd), true);
  const c = createHideController({ hide: true }, undefined, { platform: "darwin", env: {}, exec })!;
  c.onSpawn(999);
  const report = await c.finalize(null);
  assert.equal(report.method, "mac-accessory");
  assert.equal(report.verified, false);
  assert.equal(report.mac?.hiddenByPid, true);
  assert.ok(ran.includes("osascript"));
});

test("controller off-platform: hide on an unknown OS warns unsupported", async () => {
  const warnings: string[] = [];
  const c = createHideController({ hide: true, onWarning: (w) => warnings.push(w.code) }, undefined, {
    platform: "freebsd" as NodeJS.Platform,
    env: {},
  })!;
  const report = await c.finalize(null);
  assert.equal(report.method, "none");
  assert.ok(warnings.includes("hide-unsupported"));
});

// --- win-native fallback ----------------------------------------------------

test("loadWinNative is null off Windows and when koffi is absent", () => {
  assert.equal(loadWinNative("linux"), null);
  _resetWinNativeCache();
  assert.equal(loadWinNative("win32", () => null), null);
  assert.equal(unavailableNative().qos, "unavailable");
});

// --- macOS pure helpers -----------------------------------------------------

test("macRecorderCacheKey changes with version or mtime (rebuild on Slippi update)", () => {
  const a = macRecorderCacheKey("/A/Slippi.app", "3.5.2", 1000);
  assert.equal(a, macRecorderCacheKey("/A/Slippi.app", "3.5.2", 1000));
  assert.notEqual(a, macRecorderCacheKey("/A/Slippi.app", "3.5.3", 1000));
  assert.notEqual(a, macRecorderCacheKey("/A/Slippi.app", "3.5.2", 2000));
});

test("macRecorderBuildSteps: ditto, strip quarantine, LSUIElement, own id, ad-hoc sign — in order", () => {
  const steps = macRecorderBuildSteps("/src/Slippi Dolphin.app", "/dst/Lunar Recorder.app", DEFAULT_MAC_IDENTITY, "/tmp/ent");
  assert.deepEqual(steps.map((s) => s.cmd), ["ditto", "xattr", "plutil", "plutil", "codesign"]);
  const sign = steps.at(-1)!;
  assert.ok(sign.args.includes("-s") && sign.args.includes("-")); // ad-hoc
  assert.ok(sign.args.includes("runtime"));
  assert.ok(steps[3]!.args.includes(DEFAULT_MAC_IDENTITY.bundleId));
});

test("macHideByPidArgs: JXA by pid, no AppleScript (no TCC prompt)", () => {
  const { cmd, args } = macHideByPidArgs(777);
  assert.equal(cmd, "osascript");
  assert.ok(args.includes("JavaScript"));
  assert.ok(args.some((a) => a.includes("runningApplicationWithProcessIdentifier(777)")));
});
