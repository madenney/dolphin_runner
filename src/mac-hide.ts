/**
 * Hiding a recording Dolphin on macOS. **UNVERIFIED at runtime — needs a Mac.**
 * Written from Slippi's source and Apple docs (bg-research/mac-linux.md); the
 * pure parts (cache key, codesign/plutil/osascript argv, the recipe order) are
 * unit-tested, and every step fails safe: any failure falls back to the
 * original app plus a best-effort pid hide, and never fails the recording.
 *
 * The problem: Slippi's `Slippi Dolphin.app` is a regular (Dock) app. Each
 * recorder process gets its own bouncing Dock tile, and it is activated at
 * launch (focus steal). The fixes, none of which touch the user's own app:
 *
 * 1. **An accessory copy of the app.** `ditto`/`cp -c` the bundle into the
 *    consumer's cache, strip quarantine, set `LSUIElement=YES` (Accessory: no
 *    Dock tile, no menu bar, not in Cmd-Tab, not activated at launch) and a
 *    distinct `CFBundleIdentifier`, then ad-hoc re-sign with the original
 *    entitlements (arm64 requires a signature). Rebuilt when the source app's
 *    version or mtime changes. Spawn stays direct (`Contents/MacOS/<exe>`), so
 *    pid and stdout are kept.
 * 2. **Force OGL** (ProfileOptions / hide ini): occluded Vulkan/MoltenVK stalls
 *    to ~1 FPS; OpenGL does not and dumps from the FBO.
 * 3. **Hide by pid** as a belt-and-braces, through
 *    `NSRunningApplication(pid).hide()` via `osascript -l JavaScript` — no TCC
 *    prompt, and by pid only (every instance has the same name).
 *
 * Never: modify the user's original bundle, copy the bare executable out of its
 * bundle (loses bundle identity and takes the focus-steal path), or launch a
 * translocated/quarantined bundle (it shows a modal and exits).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appBundleOf } from "./paths.ts";

/** The identity for the accessory recorder copy. */
export interface MacRecorderIdentity {
  /** `CFBundleIdentifier` for the copy — its own LaunchServices identity. */
  bundleId: string;
  /** The copy's folder name, e.g. `Lunar Recorder.app`. */
  appName: string;
}

export const DEFAULT_MAC_IDENTITY: MacRecorderIdentity = {
  bundleId: "com.lunarmelee.recorder",
  appName: "Lunar Recorder.app",
};

/**
 * A stable cache key for a recorder copy: the SOURCE bundle's path, version and
 * mtime, so the copy is rebuilt exactly when the user updates Slippi. Pure.
 */
export function macRecorderCacheKey(sourceApp: string, version: string | null, mtimeMs: number): string {
  return createHash("sha256").update(`${path.resolve(sourceApp)}\0${version ?? ""}\0${Math.round(mtimeMs)}`).digest("hex").slice(0, 16);
}

/** Where the accessory copy lives under the consumer's cache dir. */
export function macRecorderAppPath(cacheDir: string, key: string, identity: MacRecorderIdentity = DEFAULT_MAC_IDENTITY): string {
  return path.join(cacheDir, `recorder-${key}`, identity.appName);
}

/**
 * The shell steps that build the accessory copy, as argv arrays, in order.
 * Pure and unit-tested; `prepareMacRecorderApp` runs them. `entitlementsFile`
 * is a temp path the caller fills from `codesign -d --entitlements`.
 */
export function macRecorderBuildSteps(
  sourceApp: string,
  destApp: string,
  identity: MacRecorderIdentity,
  entitlementsFile: string,
): Array<{ cmd: string; args: string[] }> {
  const infoPlist = path.join(destApp, "Contents", "Info.plist");
  return [
    // APFS clone — instant, no extra disk — preserving xattrs; the caller mkdirs the parent.
    { cmd: "ditto", args: [sourceApp, destApp] },
    // A copied bundle carries the source's quarantine xattr; strip it so the
    // copy is never translocated (which would show a modal and exit).
    { cmd: "xattr", args: ["-dr", "com.apple.quarantine", destApp] },
    // Accessory app: no Dock tile, no menu bar, no Cmd-Tab, not activated.
    { cmd: "plutil", args: ["-replace", "LSUIElement", "-bool", "YES", infoPlist] },
    // Own LaunchServices identity, so nothing groups with the user's Slippi.
    { cmd: "plutil", args: ["-replace", "CFBundleIdentifier", "-string", identity.bundleId, infoPlist] },
    // Editing Info.plist breaks the signature; ad-hoc re-sign. `-s -` is ad-hoc
    // (keeps arm64 happy); hardened runtime + the original entitlements.
    { cmd: "codesign", args: ["--force", "--deep", "-s", "-", "--options", "runtime", "--entitlements", entitlementsFile, destApp] },
  ];
}

/** `codesign -d --entitlements :- <app>` — dump the original entitlements. */
export function macDumpEntitlementsArgs(sourceApp: string): { cmd: string; args: string[] } {
  return { cmd: "codesign", args: ["-d", "--entitlements", ":-", "--xml", sourceApp] };
}

/** What `prepareMacRecorderApp` returns. */
export interface MacRecorderResult {
  /** The `.app` to pass as `dolphinPath`; the source app on any failure. */
  app: string;
  /** True when the accessory copy was built (or already cached); false = fell back. */
  prepared: boolean;
  /** Why it fell back, if it did. */
  reason?: string;
}

/**
 * Build (or reuse a cached) accessory copy of Slippi's Playback app for hidden
 * recording, and return the `.app` to spawn. **UNVERIFIED on macOS.** Never
 * throws: on any failure it returns the ORIGINAL app and `prepared: false`, so
 * the recording still runs (visible, with a Dock tile). `exec` is injectable
 * for tests; the real one shells out.
 *
 * The consumer calls this once and passes `result.app` to `record()` as
 * `dolphinPath` (and sets `hide` for the OGL ini + pid hide). It is a no-op on
 * non-macOS. Cache keyed on the source app's version + mtime (rebuilt on a
 * Slippi update).
 */
export async function prepareMacRecorderApp(
  dolphinPath: string,
  cacheDir: string,
  opts: {
    identity?: MacRecorderIdentity;
    platform?: NodeJS.Platform;
    exec?: (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>;
  } = {},
): Promise<MacRecorderResult> {
  const platform = opts.platform ?? (process.platform as NodeJS.Platform);
  const sourceApp = appBundleOf(dolphinPath) ?? dolphinPath;
  if (platform !== "darwin") return { app: dolphinPath, prepared: false, reason: "not macOS" };
  const identity = opts.identity ?? DEFAULT_MAC_IDENTITY;
  const exec =
    opts.exec ??
    ((cmd: string, args: string[]) =>
      new Promise<{ ok: boolean; stdout: string }>((resolve) => {
        execFile(cmd, args, { timeout: 60_000, encoding: "utf8" }, (err, stdout) =>
          resolve({ ok: !err, stdout: stdout || "" }),
        );
      }));

  try {
    const plistPath = path.join(sourceApp, "Contents", "Info.plist");
    const [version, st] = await Promise.all([readShortVersion(plistPath), fsp.stat(sourceApp)]);
    const key = macRecorderCacheKey(sourceApp, version, st.mtimeMs);
    const destApp = macRecorderAppPath(cacheDir, key, identity);

    if (await exists(path.join(destApp, "Contents", "MacOS"))) {
      return { app: destApp, prepared: true };
    }

    await fsp.rm(path.dirname(destApp), { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(path.dirname(destApp), { recursive: true });

    const dump = macDumpEntitlementsArgs(sourceApp);
    const ent = await exec(dump.cmd, dump.args);
    const entFile = path.join(os.tmpdir(), `lunar-rec-ent-${key}.plist`);
    await fsp.writeFile(entFile, ent.ok ? ent.stdout : "");

    for (const step of macRecorderBuildSteps(sourceApp, destApp, identity, entFile)) {
      const r = await exec(step.cmd, step.args);
      if (!r.ok) {
        await fsp.rm(path.dirname(destApp), { recursive: true, force: true }).catch(() => {});
        return { app: dolphinPath, prepared: false, reason: `${step.cmd} failed` };
      }
    }
    await fsp.rm(entFile, { force: true }).catch(() => {});
    return { app: destApp, prepared: true };
  } catch (e) {
    return { app: dolphinPath, prepared: false, reason: String(e) };
  }
}

async function readShortVersion(plist: string): Promise<string | null> {
  try {
    const text = await fsp.readFile(plist, "utf8");
    const m = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/.exec(text);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The osascript (JXA) that hides a running app by pid with no TCC prompt.
 * `NSRunningApplication.runningApplicationWithProcessIdentifier(pid).hide()`.
 * Pure; the caller spawns `osascript` with these args.
 */
export function macHideByPidArgs(pid: number): { cmd: string; args: string[] } {
  const js =
    "ObjC.import('AppKit');" +
    `var a=$.NSRunningApplication.runningApplicationWithProcessIdentifier(${Math.trunc(pid)});` +
    "if(a){a.hide;a.hide()}";
  return { cmd: "osascript", args: ["-l", "JavaScript", "-e", js] };
}
