import { spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, openSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDolphinExecutable } from "./paths.ts";
import type { DolphinPaths } from "./types.ts";

/** What dolphinStatus may look at besides the paths. All optional. */
export interface StatusOptions {
  /** `os.type()` — "Linux", "Darwin", "Windows_NT". Default: this machine's. */
  platform?: string;
  /**
   * The environment Dolphin will be spawned with. Default `process.env`.
   * `record()`/`play()`/`obsMirror()` pass the inherited env merged with
   * their `env` option, so APPIMAGE_EXTRACT_AND_RUN or DISPLAY set there count.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * The X display the run will use (`RunOptions.display`). When given, a
   * missing DISPLAY in `env` is not a problem. Pass it if you preflight with
   * dolphinStatus and hand `display` to record() rather than setting DISPLAY.
   */
  display?: string;
  /** Is libfuse.so.2 loadable? Injectable for tests. Default: `hasLibfuse2()`. */
  hasLibfuse2?: () => boolean;
}

/**
 * Why we cannot run, phrased for whoever has to fix it — or null when we can.
 *
 * Parameterised rather than reading env at import time: a library that decides
 * its configuration when it is first imported cannot be used by a consumer that
 * resolves paths at runtime, and cannot be tested without mutating env.
 *
 * Cheap and side-effect free: a few stats, 20 bytes of the binary, and at
 * worst one `ldconfig -p` (cached). It catches the startup failures that
 * otherwise only show up as a Dolphin that exits at once or a 90-second boot
 * stall: not executable, an AppImage with no FUSE 2, no display on Linux.
 */
export function dolphinStatus(p: DolphinPaths, o: StatusOptions = {}): string | null {
  const platform = o.platform ?? os.type();
  const env = o.env ?? process.env;
  if (!p.dolphinPath) return "dolphinPath is not set";
  if (!existsSync(p.dolphinPath)) return `dolphinPath does not exist: ${p.dolphinPath}`;

  const exe = resolveDolphinExecutable(p.dolphinPath);
  let isDir = false;
  try {
    isDir = statSync(exe).isDirectory();
  } catch {
    /* existsSync said yes a moment ago; let the spawn report it */
  }
  if (isDir) {
    return /\.app[\\/]*$/i.test(p.dolphinPath)
      ? `dolphinPath is an app bundle with no executable in Contents/MacOS: ${p.dolphinPath}`
      : `dolphinPath is a directory, not the Dolphin executable: ${p.dolphinPath}`;
  }
  if (platform !== "Windows_NT" && !isExecutable(exe)) {
    return `dolphinPath is not executable: ${exe} — run: chmod +x "${exe}"`;
  }

  if (platform === "Linux") {
    if (isAppImage(exe) && env.APPIMAGE_EXTRACT_AND_RUN !== "1" && !(o.hasLibfuse2 ?? hasLibfuse2)()) {
      return (
        `dolphinPath is an AppImage and libfuse.so.2 was not found, so it cannot mount itself: ${exe} — ` +
        `install libfuse2 (Debian/Ubuntu: libfuse2 or libfuse2t64; Fedora: fuse-libs), ` +
        `or set APPIMAGE_EXTRACT_AND_RUN=1 in its environment`
      );
    }
    if (!o.display && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
      return "no display: neither DISPLAY nor WAYLAND_DISPLAY is set, and Dolphin needs one even to dump — pass `display` or set DISPLAY";
    }
  }

  if (!p.isoPath) return "isoPath is not set";
  if (!existsSync(p.isoPath)) return `isoPath does not exist: ${p.isoPath}`;
  return null;
}

export function dolphinConfigured(p: DolphinPaths, o: StatusOptions = {}): boolean {
  return dolphinStatus(p, o) === null;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * An AppImage by name, or by its magic: an ELF with `AI\x02` at offset 8
 * (type 2, what Slippi ships). Reads 11 bytes; false on any error.
 */
export function isAppImage(p: string): boolean {
  if (/\.appimage$/i.test(path.basename(p))) return true;
  let fd: number | null = null;
  try {
    fd = openSync(p, "r");
    const b = Buffer.alloc(11);
    if (readSync(fd, b, 0, 11, 0) < 11) return false;
    return b[0] === 0x7f && b.toString("latin1", 1, 4) === "ELF" && b[8] === 0x41 && b[9] === 0x49 && b[10] === 0x02;
  } catch {
    return false;
  } finally {
    if (fd != null) closeSync(fd);
  }
}

/** Where distros put libfuse.so.2. Checked before falling back to `ldconfig -p`. */
export const LIBFUSE2_PATHS = [
  "/usr/lib/x86_64-linux-gnu/libfuse.so.2",
  "/lib/x86_64-linux-gnu/libfuse.so.2",
  "/usr/lib/aarch64-linux-gnu/libfuse.so.2",
  "/lib/aarch64-linux-gnu/libfuse.so.2",
  "/usr/lib64/libfuse.so.2",
  "/lib64/libfuse.so.2",
  "/usr/lib/libfuse.so.2",
  "/lib/libfuse.so.2",
];

let ldconfigSaysFuse2: boolean | null = null;

/**
 * Can an AppImage's runtime load FUSE 2? Without it the AppImage prints
 * "dlopen(): error loading libfuse.so.2" and exits before Dolphin starts —
 * the classic first-run failure on a fresh Ubuntu 22.04+. Common lib dirs
 * first; `ldconfig -p` (once per process) only if none of them has it.
 */
export function hasLibfuse2(): boolean {
  if (LIBFUSE2_PATHS.some((p) => existsSync(p))) return true;
  if (ldconfigSaysFuse2 == null) {
    // No ldconfig to ask: don't claim it is missing on a guess. /sbin is often
    // off a normal user's PATH (Debian).
    ldconfigSaysFuse2 = true;
    for (const cmd of ["ldconfig", "/sbin/ldconfig"]) {
      try {
        const r = spawnSync(cmd, ["-p"], { encoding: "utf8", timeout: 2000 });
        if (r.error || r.status !== 0) continue;
        ldconfigSaysFuse2 = /\blibfuse\.so\.2\b/.test(r.stdout || "");
        break;
      } catch {
        /* try the next */
      }
    }
  }
  return ldconfigSaysFuse2;
}
