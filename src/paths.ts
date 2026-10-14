import os from "node:os";
import path from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { RealProfile } from "./types.ts";

/**
 * Where this OS keeps per-user app config.
 *
 * Degrades gracefully when Electron is absent — the package must work for
 * plain-Node consumers (the VOD recorder) as well as Electron ones (the clip tool),
 * so we never import electron. An Electron host can pass `sourceProfile`
 * explicitly if `app.getPath('appData')` disagrees with this.
 */
export function appDataPath(platform: string = os.type()): string {
  if (platform === "Windows_NT") {
    return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  }
  if (platform === "Darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

/**
 * Locate the REAL Slippi Playback profile — the one we copy from and never write.
 *
 * Linux: `<appData>/SlippiPlayback`.
 * macOS: `<app>/Contents/Resources/User` when `dolphinPath` is (or is inside)
 * an `.app` bundle — Slippi's mac Playback keeps its profile in the bundle —
 * falling back to `~/Library/Application Support/SlippiPlayback`. UNVERIFIED at
 * runtime, like Windows: resolution is unit-tested, nobody has recorded on a Mac.
 * Windows: the install is portable, so the user-root IS `<dolphinDir>/User`.
 * That `User/` segment is a property of the real profile's layout, NOT of the
 * `--user` flag — a throwaway profile passed to `--user` has Config/ and
 * GameSettings/ directly at its root on every platform. Conflating those two is
 * the easiest way to build a profile Dolphin silently ignores.
 */
export function resolveRealProfile(dolphinPath: string, platform: string = os.type()): RealProfile {
  return profileAt(realProfileRoot(dolphinPath, platform));
}

/**
 * The profile ROOT for a platform. Split out from resolveRealProfile so both
 * branches are testable without mocking `os` — the Windows layout is the half
 * nobody can exercise on the machine that wrote it.
 */
export function realProfileRoot(dolphinPath: string, platform: string = os.type()): string {
  if (platform === "Windows_NT") return path.join(path.dirname(dolphinPath), "User");
  if (platform === "Darwin") {
    const app = appBundleOf(dolphinPath);
    const inBundle = app ? path.join(app, "Contents", "Resources", "User") : null;
    // The old location only when the bundle has no User folder: a profile the
    // user never opened in the bundle should still be found where it was.
    if (inBundle && existsSync(inBundle)) return inBundle;
  }
  return path.resolve(appDataPath(platform), "SlippiPlayback");
}

/**
 * The `.app` bundle `p` is, or lives inside (`…/X.app/Contents/MacOS/X`), or
 * null. By name only — no filesystem access — so it is cheap and pure.
 */
export function appBundleOf(p: string): string | null {
  if (!p) return null;
  const parts = path.resolve(p).split(path.sep);
  for (let i = parts.length - 1; i > 0; i--) {
    if (parts[i]!.toLowerCase().endsWith(".app")) return parts.slice(0, i + 1).join(path.sep) || path.sep;
  }
  return null;
}

/**
 * The file to actually spawn for a `dolphinPath`.
 *
 * A macOS `.app` is a DIRECTORY; spawning it fails with EACCES, and "it's not
 * executable" is a baffling thing to tell someone who just picked the app in
 * Finder. So a bundle (a path ending in `.app`, or any directory with
 * `Contents/Info.plist`) resolves to `Contents/MacOS/<CFBundleExecutable>`,
 * falling back to the only file in `Contents/MacOS` when Info.plist is binary,
 * unreadable or names something absent. Anything else — including a bundle
 * that cannot be resolved, which `dolphinStatus` then reports — comes back
 * unchanged. Cheap: a stat, and a read of Info.plist only for a bundle.
 */
export function resolveDolphinExecutable(dolphinPath: string): string {
  if (!dolphinPath) return dolphinPath;
  let isDir = false;
  try {
    isDir = statSync(dolphinPath).isDirectory();
  } catch {
    return dolphinPath;
  }
  if (!isDir) return dolphinPath;
  const contents = path.join(dolphinPath, "Contents");
  const plist = path.join(contents, "Info.plist");
  const looksLikeBundle = /\.app[\\/]*$/i.test(dolphinPath) || existsSync(plist);
  if (!looksLikeBundle) return dolphinPath;
  const macos = path.join(contents, "MacOS");
  const name = bundleExecutableName(plist);
  if (name) {
    const exe = path.join(macos, name);
    if (isFile(exe)) return exe;
  }
  try {
    const files = readdirSync(macos).filter((n) => !n.startsWith(".") && isFile(path.join(macos, n)));
    if (files.length === 1) return path.join(macos, files[0]!);
  } catch {
    /* no Contents/MacOS */
  }
  return dolphinPath;
}

/** `CFBundleExecutable` from an XML Info.plist, or null (binary plist, absent). */
function bundleExecutableName(plist: string): string | null {
  let text: string;
  try {
    text = readFileSync(plist, "utf8");
  } catch {
    return null;
  }
  const m = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/.exec(text);
  return m ? m[1]! : null;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The ini layout of a profile root, real or throwaway. */
export function profileAt(root: string): RealProfile {
  const configDir = path.join(root, "Config");
  return {
    root,
    configDir,
    gfxIni: path.join(configDir, "GFX.ini"),
    dolphinIni: path.join(configDir, "Dolphin.ini"),
    gameSettingsIni: path.join(root, "GameSettings", "GALE01.ini"),
  };
}

/** True when the resolved profile actually has the inis we copy from. */
export function realProfileExists(p: RealProfile): boolean {
  return existsSync(p.gfxIni) && existsSync(p.dolphinIni);
}
