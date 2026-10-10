import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { writeComm } from "./comm.ts";
import { foldEnd, parseFrameLine, reachedEnd } from "./frames.ts";
import { killTree } from "./kill.ts";
import { checkPlacement, placeWindows, systemX11, warn, type PlacementHandle } from "./place.ts";
import { lastFrameOf } from "./slp.ts";
import { dolphinStatus } from "./status.ts";
import { tailBuffer } from "./tail.ts";
import type {
  DolphinPaths,
  PlacementReport,
  RecordOptions,
  RecordResult,
  RunOptions,
  StallDiagnostic,
} from "./types.ts";

const DEFAULT_BOOT_STALL_MS = 90_000;
const DEFAULT_FRAME_STALL_MS = 30_000;

interface SpawnPlan {
  args: string[];
  commPath: string;
}

/**
 * The environment a recording Dolphin is spawned with. Pure, for tests.
 * Order: inherited, then the caller's `env`, then the named options (which win).
 */
export function recordEnv(base: NodeJS.ProcessEnv, o: Pick<RunOptions, "env" | "display" | "audioSink" | "appName">) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v != null) env[k] = v;
  Object.assign(env, o.env ?? {});
  if (o.display) env.DISPLAY = o.display;
  if (o.audioSink) {
    // Pulse reads PULSE_SINK; the ALSA backend goes through pipewire's ALSA
    // plugin, which ignores PULSE_SINK but honours PIPEWIRE_NODE (measured).
    env.PULSE_SINK = o.audioSink;
    env.PIPEWIRE_NODE = o.audioSink;
  }
  if (o.appName) env.PULSE_PROP_OVERRIDE = appNameProp(o.appName);
  return env;
}

/**
 * `PULSE_PROP_OVERRIDE` for a stream name. Override, not PULSE_PROP: Dolphin
 * sets application.name itself ("dolphin-emu"), and only the override beats it.
 */
export function appNameProp(name: string): string {
  if (!/^[A-Za-z0-9 _.:-]+$/.test(name)) {
    throw new Error(`appName ${JSON.stringify(name)}: use letters, digits, space, _ . : - only`);
  }
  return `application.name='${name}'`;
}

/** Drive one Dolphin to completion, frame-watched. record()'s spawn loop. */
async function runDolphin(
  paths: DolphinPaths,
  slpPath: string,
  plan: SpawnPlan,
  o: RunOptions,
): Promise<{ stalled: boolean; diagnostic: StallDiagnostic | null }> {
  const bootStallMs = o.bootStallMs ?? DEFAULT_BOOT_STALL_MS;
  const frameStallMs = o.frameStallMs ?? DEFAULT_FRAME_STALL_MS;

  return await new Promise((resolvePromise, reject) => {
    const env = recordEnv(process.env, o);
    const child = spawn(paths.dolphinPath, plan.args, { env });
    // Hand the pid out as soon as there is one (window parking, diagnostics). A
    // throwing callback is the caller's bug, never a failed run.
    child.once("spawn", () => {
      try {
        if (child.pid != null) o.onSpawn?.(child.pid);
      } catch {
        /* ignore */
      }
    });

    let end = Infinity;
    let sawAnyFrame = false;
    let killedAtEnd = false;
    let settled = false;
    let stalled = false;
    let diagnostic: StallDiagnostic | null = null;
    let stderrBytes = 0;
    let lastProgress = Date.now();

    const stdoutTail = tailBuffer();
    const stderrTail = tailBuffer();

    // DRAIN STDERR. spawn() pipes all three streams; if we read stdout but not
    // stderr, then once Dolphin writes ~64KB into a pipe nobody is reading, the
    // write BLOCKS and the process stops dead — high CPU, no frames, never
    // exits. That is *the* classic "random stall", random only because it
    // depends on how chatty Dolphin happens to be for a given replay. We read
    // it, and keep a BOUNDED tail: accumulating the whole stream instead is a
    // slow memory leak across a long batch.
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (d: string) => {
      stderrBytes += d.length;
      for (const line of String(d).split(/\r?\n/)) stderrTail.push(line);
    });

    const snapshot = (): StallDiagnostic => ({
      replay: slpPath,
      silentForSec: Math.round((Date.now() - lastProgress) / 1000),
      hungOnBoot: !sawAnyFrame,
      endFrame: end === Infinity ? null : end,
      stderrBytes,
      stdoutTail: [...stdoutTail.lines],
      stderrTail: [...stderrTail.lines],
    });

    // Two-tier watchdog. Boot has to cover Dolphin start + ISO load, so it gets
    // a long grace; once frames are flowing, a 30s silence is a freeze and
    // waiting two minutes to say so just wastes the slot. The timer measures
    // the GAP BETWEEN frames, not total runtime, so it is length-independent —
    // a five-minute game that streams frames never trips it.
    const watchdog = setInterval(() => {
      if (settled) return;
      const window = sawAnyFrame ? frameStallMs : bootStallMs;
      if (Date.now() - lastProgress < window) return;
      stalled = true;
      diagnostic = snapshot();
      killTree(child.pid!, false); // a hang does not get a graceful exit
    }, 2000);
    watchdog.unref?.();

    const onAbort = () => killTree(child.pid!, false);
    o.signal?.addEventListener?.("abort", onAbort, { once: true });

    const finish = () => {
      clearInterval(watchdog);
      o.signal?.removeEventListener?.("abort", onAbort);
    };

    // readline handles PARTIAL LINES for us. Node delivers stdout in arbitrary
    // chunks, so a line can arrive split ("[CURRENT_FRA" + "ME] 8454"); matching
    // per chunk means neither half matches, the end-of-replay kill never fires,
    // and Dolphin idles forever — a hang decided by where a buffer boundary
    // happened to land.
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line: string) => {
      const parsed = parseFrameLine(line);
      if (parsed.kind === "playbackEnd" || parsed.kind === "gameEnd") {
        end = foldEnd(end, parsed.frame);
        return;
      }
      if (parsed.kind === "other") {
        stdoutTail.push(line); // keep everything BUT the frame spam
        return;
      }
      sawAnyFrame = true;
      lastProgress = Date.now();
      const current = parsed.frame;
      if (end !== Infinity) o.onFrame?.(current, end);
      // COMPARE NUMERICALLY, >= not == and never as a substring. A substring
      // test for `845` matches inside `8454` (early kill → truncated dump), and
      // an exact `==` on a frame Dolphin never happens to print means we never
      // kill it at all (hang). Both have shipped, in different projects.
      if (!killedAtEnd && reachedEnd(current, end)) {
        killedAtEnd = true;
        // SIGTERM so the .avi/.wav finalise; a dump killed with SIGKILL can be
        // left without a usable index.
        killTree(child.pid!, true);
      }
    });

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      finish();
      reject(e);
    });

    child.on("exit", () => {
      if (settled) return;
      settled = true;
      finish();
      rl.close();
      if (o.signal?.aborted) return reject(new Error("canceled"));
      // A STALL IS A SILENCE, NOT A VERDICT. Measured dumps at the moment of a
      // stall have been 27%, 43%, 70% and 94% complete — one was finished in
      // every sense except announcing it, and rejecting here throws away work
      // that already cost its full real-time record. Resolve, report `stalled`,
      // and let the caller's duration guard judge the footage.
      resolvePromise({ stalled, diagnostic });
    });
  });
}

/**
 * Frame-dump one replay. Returns the raw dump paths — muxing is the caller's job.
 *
 * Resolves even when the watchdog fired (`stalled: true` — judge the footage).
 * The one watchdog case that REJECTS is a hang that left no `.avi` at all
 * ("produced no video"): there is no footage to judge.
 */
export async function record(
  paths: DolphinPaths,
  slpPath: string,
  o: RecordOptions,
): Promise<RecordResult> {
  if (o.signal?.aborted) throw new Error("canceled");
  if (!existsSync(slpPath)) throw new Error(`replay not found: ${slpPath}`);
  const why = dolphinStatus(paths);
  if (why) throw new Error(`cannot record: ${why}`);
  if (!existsSync(o.userDir)) throw new Error(`user dir does not exist: ${o.userDir}`);

  const lastFrame = lastFrameOf(slpPath);
  if (lastFrame == null || lastFrame <= 0) {
    throw new Error(`could not read lastFrame from ${slpPath}`);
  }

  mkdirSync(o.outDir, { recursive: true });
  const base = o.baseName ?? "dump";
  const commPath = path.join(o.outDir, "comm.json");
  writeComm(commPath, {
    replay: slpPath,
    startFrame: o.startFrame ?? -123,
    endFrame: o.endFrame ?? lastFrame,
    isRealTimeMode: false,
  });

  const args = [
    "-i", commPath,
    "-o", base,
    `--output-directory=${o.outDir}`,
    "-b",
    "-e", paths.isoPath,
    "--user", o.userDir,
    "--hide-seekbar",
    "--cout",
  ];

  const place = await preparePlacement(o, o.display);
  let placing: PlacementHandle | null = null;
  const runOpts: RecordOptions = {
    ...o,
    onSpawn: (pid) => {
      // Placement first: the window must be found before it maps to never flash.
      if (place.start) placing = place.start(pid);
      o.onSpawn?.(pid);
    },
  };
  let stalled: boolean;
  let diagnostic: StallDiagnostic | null;
  try {
    ({ stalled, diagnostic } = await runDolphin(paths, slpPath, { args, commPath }, runOpts));
  } finally {
    (placing as PlacementHandle | null)?.stop();
  }
  const placement = placing ? await (placing as PlacementHandle).done : place.skipped;

  const avi = path.join(o.outDir, `${base}.avi`);
  const wav = path.join(o.outDir, `${base}.wav`);
  if (!existsSync(avi)) throw new Error(`Dolphin produced no video for ${slpPath}`);

  return {
    avi,
    wav: existsSync(wav) ? wav : null,
    lastFrame,
    stalled,
    diagnostic,
    placement,
  };
}

/**
 * The pre-spawn half of placement, shared by record() and obsMirror(). Throws
 * only when placement is `required` and can't work here; otherwise a skip is
 * a warning plus a "skipped" report, and the Dolphin launches unparked.
 */
export async function preparePlacement(
  o: Pick<RunOptions, "placement" | "onWarning" | "signal">,
  runDisplay: string | undefined,
): Promise<{ start: ((pid: number) => PlacementHandle) | null; skipped: PlacementReport | null }> {
  const p = o.placement;
  if (!p) return { start: null, skipped: null };
  const display = p.display ?? runDisplay;
  const check = await checkPlacement({ workspace: p.workspace, display });
  if (!check.ok) {
    if (p.required) throw new Error(`window placement required but unavailable: ${check.warning.detail}`);
    warn(o, check.warning);
    return { start: null, skipped: { workspace: p.workspace, status: "skipped", windows: [] } };
  }
  // Who has focus BEFORE Dolphin raises itself — restoreFocus hands it back.
  const previousActive = p.restoreFocus === false ? null : await systemX11(display).activeWindow();
  return {
    start: (pid) => placeWindows(pid, { ...p, display, previousActive, signal: o.signal, onWarning: o.onWarning }),
    skipped: null,
  };
}
