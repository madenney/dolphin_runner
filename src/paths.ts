import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import type { RealProfile } from "./types.ts";

/**
 * Where this OS keeps per-user app config.
 *
 * Degrades gracefully when Electron is absent — the package must work for
 * plain-Node consumers (the VOD recorder) as well as Electron ones (the clip tool),
 * so we never import electron. An Electron host can pass `sourceProfile`
 * explicitly if `app.getPath('appData')` disagrees with this.
 */
export function appDataPath(): string {
  const platform = os.type();
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
 * Linux/macOS: `<appData>/SlippiPlayback`.
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
  return path.resolve(appDataPath(), "SlippiPlayback");
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
