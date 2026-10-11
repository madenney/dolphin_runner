import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { writeMirrorComm } from "./comm.ts";
import { killTree } from "./kill.ts";
import { buildProfile } from "./profile.ts";
import { appNameProp, preparePlacement } from "./run.ts";
import { dolphinStatus } from "./status.ts";
import { tailBuffer } from "./tail.ts";
import type { DolphinPaths, ObsMirrorHandle, ObsMirrorOptions, ProfileOptions } from "./types.ts";

/** What `obs-gamecapture` preloads. ld.so expands `$LIB` (lib / lib64 / x86_64-linux-gnu). */
export const DEFAULT_GLCAPTURE_LIB = "/usr/$LIB/obs_glcapture/libobs_glcapture.so";
const DEFAULT_PULSE_LATENCY_MS = 120;
const DEFAULT_AUDIO_LATENCY_MS = 60;
const DEFAULT_WINDOW = { fullscreen: true } as const;

/**
 * The environment an OBS-capturable Dolphin needs. Pure, so the tests can
 * pin the exact shape the stream tool depends on.
 *
 * LD_PRELOAD order matters: the exe-override shim goes FIRST so its readlink
 * wins, whatever the caller already had stays in the middle, and glcapture
 * goes last — the same order `obs-gamecapture` produces when wrapped around a
 * command that already set the shim.
 */
export function obsMirrorEnv(
  base: NodeJS.ProcessEnv,
  o: Pick<
    ObsMirrorOptions,
    | "captureName"
    | "glcaptureLib"
    | "exeOverrideShim"
    | "pulseSink"
    | "pulseLatencyMs"
    | "display"
    | "capture"
    | "appName"
    | "env"
  >,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v != null) env[k] = v;
  // The caller's extras go in before everything below, so capture-critical
  // variables can't be clobbered by accident. An LD_PRELOAD here is treated as
  // "already had" and kept in the middle of the chain.
  Object.assign(env, o.env ?? {});
  const inheritedPreload = env.LD_PRELOAD ?? "";

  const common = () => {
    env.OBS_VKCAPTURE_EXE_NAME = o.captureName;
    if (o.pulseSink) env.PULSE_SINK = o.pulseSink;
    env.PULSE_LATENCY_MSEC = String(o.pulseLatencyMs ?? DEFAULT_PULSE_LATENCY_MS);
    if (o.display) env.DISPLAY = o.display;
    if (o.appName) env.PULSE_PROP_OVERRIDE = appNameProp(o.appName);
  };
  if (o.capture === false) {
    // Same Dolphin, no hook: nothing preloaded (an inherited preload included)
    // and the vkcapture layer switched off.
    delete env.LD_PRELOAD;
    env.OBS_VKCAPTURE = "0";
    common();
    return env;
  }

  const preload = [
    o.exeOverrideShim,
    ...inheritedPreload.split(":").filter(Boolean),
    o.glcaptureLib ?? DEFAULT_GLCAPTURE_LIB,
  ].filter((x): x is string => !!x);
  env.LD_PRELOAD = preload.join(":");

  env.OBS_VKCAPTURE = "1";
  common();
  return env;
}

/** The profile options obsMirror applies, pure for tests. */
export function obsMirrorProfile(paths: DolphinPaths, o: ObsMirrorOptions): ProfileOptions & { dolphinPath: string } {
  return {
    mode: "play",
    dolphinPath: paths.dolphinPath,
    sourceProfile: o.sourceProfile,
    freshProfile: o.freshProfile,
    geckoIni: o.geckoIni,
    gameSettingsId: o.gameSettingsId,
    efbScale: o.efbScale,
    msaa: o.msaa,
    gfxBackend: o.gfxBackend ?? "OGL",
    audioBackend: "Pulse",
    volume: 100,
    audioLatencyMs: o.audioLatencyMs ?? DEFAULT_AUDIO_LATENCY_MS,
    emulationSpeed: o.emulationSpeed ?? 1,
    window: o.window ?? DEFAULT_WINDOW,
    vsync: false,
    shaderCompilationMode: 0,
    shaderCacheDir: o.shaderCacheDir,
    // A parked mirror loses focus by design; it must not pause on air.
    pauseOnFocusLost: false,
    detachHotkeys: o.detachHotkeys,
  };
}

/** The exact argv, pure for tests. No `-b`: the window must stay up. No `--cout`: nobody is listening. */
export function obsMirrorArgs(paths: DolphinPaths, o: Pick<ObsMirrorOptions, "userDir" | "commPath">): string[] {
  return ["-i", o.commPath, "-e", paths.isoPath, "--user", o.userDir];
}

/**
 * Launch a Dolphin that another process captures in OBS via obs-vkcapture's
 * GL path, and hand back a handle. Nothing here watches frames: a mirror
 * that idles on "waiting for game" between sets is healthy, so there is no
 * watchdog. Stopping the feed is `stop()`, an AbortSignal, or the caller
 * killing the pid — all SIGKILL the whole tree.
 *
 * Config is written ONLY into `userDir`. The shared real profile is copied,
 * never written — writing it is what broke every other capture on the box.
 */
export async function obsMirror(paths: DolphinPaths, o: ObsMirrorOptions): Promise<ObsMirrorHandle> {
  if (o.signal?.aborted) throw new Error("canceled");
  const why = dolphinStatus(paths);
  if (why) throw new Error(`cannot mirror: ${why}`);
  if (!Number.isFinite(o.efbScale) || o.efbScale <= 0) throw new Error("efbScale is required");

  const place = await preparePlacement(o, o.display);

  mkdirSync(o.userDir, { recursive: true });
  await buildProfile(o.userDir, obsMirrorProfile(paths, o));

  if (o.replay) {
    if (!existsSync(o.replay)) throw new Error(`replay not found: ${o.replay}`);
    mkdirSync(path.dirname(o.commPath), { recursive: true });
    writeMirrorComm(o.commPath, o.replay, o.isRealTimeMode ?? false);
  } else if (!existsSync(o.commPath)) {
    throw new Error(`comm file does not exist and no replay was given: ${o.commPath}`);
  }

  const env = obsMirrorEnv(process.env, o);
  const args = obsMirrorArgs(paths, o);
  const child = spawn(paths.dolphinPath, args, {
    env,
    cwd: path.dirname(paths.dolphinPath),
    // stdout is nobody's business; stderr is DRAINED into a bounded tail so a
    // chatty Dolphin can never block on a full pipe (gotcha 10).
    stdio: ["ignore", "ignore", "pipe"],
  });

  const stderrTail = tailBuffer();
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => {
    for (const line of String(d).split(/\r?\n/)) stderrTail.push(line);
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderrTail: string[] }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal, stderrTail: [...stderrTail.lines] }));
    },
  );

  const onAbort = () => killTree(child.pid!, false);
  o.signal?.addEventListener?.("abort", onAbort, { once: true });
  void exited.finally(() => o.signal?.removeEventListener?.("abort", onAbort));

  // A spawn failure (bad path, EACCES) surfaces here rather than as a pid.
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  // Straight after spawn: windows must be caught before they map.
  const placing = place.start ? place.start(child.pid!) : null;
  if (placing) void exited.finally(() => placing.stop()).catch(() => {});
  const placement = placing ? placing.done : place.skipped ? Promise.resolve(place.skipped) : null;

  return {
    pid: child.pid!,
    env,
    exited,
    placement,
    async stop() {
      killTree(child.pid!, false);
      await exited.catch(() => {});
    },
  };
}
