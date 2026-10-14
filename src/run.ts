import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { writeComm } from "./comm.ts";
import { foldEnd, parseFrameLine, reachedEnd } from "./frames.ts";
import { killTree } from "./kill.ts";
import { checkPlacement, placeWindows, systemX11, warn, type PlacementHandle } from "./place.ts";
import { resolveDolphinExecutable } from "./paths.ts";
import { lastFrameOf } from "./slp.ts";
import { dolphinStatus } from "./status.ts";
import { tailBuffer } from "./tail.ts";
import type {
  DolphinPaths,
  DolphinRunError,
  ExitInfo,
  PlacementReport,
  PlayOptions,
  PlayResult,
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
  const env = stripAppImageEnv(base);
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

/** The AppImage runtime's own variables. Meaningless (and misleading) to a child. */
export const APPIMAGE_RUNTIME_VARS = ["APPDIR", "APPIMAGE", "ARGV0", "OWD"] as const;

/**
 * A copy of `base` without what an AppImage runtime injected into its OWN
 * process. Pure, for tests.
 *
 * A consumer that itself runs as an AppImage (an Electron app, typically)
 * hands every child `APPDIR`/`APPIMAGE`/`ARGV0`/`OWD` and a PATH and
 * LD_LIBRARY_PATH led by `$APPDIR/usr/...`. Dolphin then resolves libraries
 * from the CONSUMER's bundle first — a different libstdc++/GL/Qt than it was
 * built against — and an AppImage Dolphin can mistake the consumer's
 * variables for its own. Only entries under `$APPDIR` are removed from the two
 * path lists; everything else the user had stays, in order. A list left empty
 * is dropped rather than set to "".
 */
export function stripAppImageEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v != null) env[k] = v;
  const appdir = env.APPDIR?.replace(/\/+$/, "");
  for (const k of APPIMAGE_RUNTIME_VARS) delete env[k];
  if (!appdir) return env;
  const inside = (entry: string) => entry === appdir || entry.startsWith(`${appdir}/`);
  for (const k of ["PATH", "LD_LIBRARY_PATH"]) {
    if (env[k] == null) continue;
    const kept = env[k]!.split(":").filter((e) => !inside(e));
    if (kept.some(Boolean)) env[k] = kept.join(":");
    else delete env[k];
  }
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

/** What runDolphin hands back to record()/play(). */
interface RunOutcome extends ExitInfo {
  stalled: boolean;
  diagnostic: StallDiagnostic | null;
  stoppedEarly: boolean;
}

/** How long to wait after exit for the last of stdout/stderr to drain. */
const DRAIN_AFTER_EXIT_MS = 500;

/** Drive one Dolphin to completion, frame-watched. record()'s spawn loop. */
async function runDolphin(
  paths: DolphinPaths,
  slpPath: string,
  plan: SpawnPlan,
  o: RunOptions,
): Promise<RunOutcome> {
  const bootStallMs = o.bootStallMs ?? DEFAULT_BOOT_STALL_MS;
  const frameStallMs = o.frameStallMs ?? DEFAULT_FRAME_STALL_MS;
  const startedAt = Date.now();

  return await new Promise((resolvePromise, reject) => {
    const env = recordEnv(process.env, o);
    // A macOS .app is a directory; spawn the executable inside it.
    const child = spawn(resolveDolphinExecutable(paths.dolphinPath), plan.args, { env });
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
    let stoppedEarly = false;
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

    const snapshot = (reason: StallDiagnostic["reason"]): StallDiagnostic => ({
      replay: slpPath,
      reason,
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
      // The HARD cap, if asked for. The stall windows only catch SILENCE; a
      // Dolphin that keeps printing frames but never reaches the end is not
      // silent and never trips them, so both the VOD recorder and the archiver
      // had to bolt their own wall-clock timer on top. Unlike an abort, this
      // RESOLVES: the dump so far is real footage and the caller's duration
      // guard is what should judge it.
      if (o.hardTimeoutMs != null && Date.now() - startedAt >= o.hardTimeoutMs) {
        stalled = true;
        diagnostic = snapshot("hard-timeout");
        // SIGTERM, not SIGKILL: we want the .avi index written.
        killTree(child.pid!, true);
        return;
      }
      const window = sawAnyFrame ? frameStallMs : bootStallMs;
      if (Date.now() - lastProgress < window) return;
      stalled = true;
      diagnostic = snapshot(sawAnyFrame ? "frame-stall" : "boot-stall");
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
      // Lines still draining after exit count as "it printed frames" but must
      // not kill anything: that pid is gone and may already be someone else's.
      if (settled) return;
      const current = parsed.frame;
      // A caller that returns "stop" wants the footage it already has — a
      // stage shot is N frames around one frame, not a whole game. Aborting
      // instead would SIGKILL (no .avi index) and reject (no result), which is
      // why a consumer doing this had to catch its own abort and rebuild the
      // path by hand. Stop gracefully and resolve normally.
      let want: unknown;
      if (end !== Infinity) {
        try {
          want = o.onFrame?.(current, end);
        } catch {
          /* a throwing callback is the caller's bug, never a failed run */
        }
      }
      if (!killedAtEnd && want === "stop") {
        killedAtEnd = true;
        stoppedEarly = true;
        killTree(child.pid!, true);
        return;
      }
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

    // Both pipes at EOF. Not `close`: a grandchild that inherited the pipes
    // (the AppImage FUSE daemon, gotcha 18) can hold them open for seconds
    // after the emulator is gone, and the result must not wait on it.
    let openStreams = 2;
    let onDrained: (() => void) | null = null;
    const drained = () => {
      if (--openStreams === 0) onDrained?.();
    };
    child.stdout?.once("end", drained);
    child.stderr?.once("end", drained);

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      finish();
      const done = () => {
        onDrained = null;
        rl.close();
        if (o.signal?.aborted) return reject(new Error("canceled"));
        const exit: ExitInfo = {
          exitCode: code,
          exitSignal: signal,
          stdoutTail: [...stdoutTail.lines],
          stderrTail: [...stderrTail.lines],
        };
        // Dolphin went away BY ITSELF before printing a single frame: it
        // crashed or refused at startup (bad ISO, no GL context, an AppImage
        // with no FUSE, a missing library). Before 0.5.7 this resolved exactly
        // like success, with nothing to tell the two apart.
        if (!killedAtEnd && !stalled && !stoppedEarly && !sawAnyFrame && diagnostic == null) {
          diagnostic = { ...snapshot("early-exit"), exitCode: code, exitSignal: signal };
        }
        // A STALL IS A SILENCE, NOT A VERDICT. Measured dumps at the moment of a
        // stall have been 27%, 43%, 70% and 94% complete — one was finished in
        // every sense except announcing it, and rejecting here throws away work
        // that already cost its full real-time record. Resolve, report `stalled`,
        // and let the caller's duration guard judge the footage.
        resolvePromise({ stalled, diagnostic, stoppedEarly, ...exit });
      };
      if (openStreams === 0) return done();
      // The exit event can beat the last chunk of stderr — which is the chunk
      // that says why it died. Wait for EOF, but never long.
      const t = setTimeout(done, DRAIN_AFTER_EXIT_MS);
      onDrained = () => {
        clearTimeout(t);
        done();
      };
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
  const why = dolphinStatus(paths, statusContext(o));
  if (why) throw new Error(`cannot record: ${why}`);
  if (!existsSync(o.userDir)) throw new Error(`user dir does not exist: ${o.userDir}`);

  // The replay's length, in order of preference: what the caller already knows,
  // what the file says, then the explicit endFrame. The last fallback matters —
  // a replay whose metadata carries no lastFrame used to be a hard failure even
  // when the caller had supplied the range, and a consumer worked around that
  // by REWRITING the replay file. Never refuse work we have the numbers for.
  const scanned = o.lastFrame ?? lastFrameOf(slpPath);
  const lastFrame = scanned != null && scanned > 0 ? scanned : (o.endFrame ?? null);
  if (lastFrame == null || lastFrame <= 0) {
    throw new Error(
      `could not read lastFrame from ${slpPath} — pass lastFrame or endFrame if you already know it`,
    );
  }

  mkdirSync(o.outDir, { recursive: true });
  const base = o.baseName ?? "dump";
  // Default is inside outDir, but it MUST be overridable: consumers run N
  // workers against one shared outDir with per-clip basenames, and a fixed
  // `comm.json` there means worker B overwrites A's between write and
  // Dolphin's read — silently recording the wrong replay.
  const commPath = o.commPath ?? path.join(o.outDir, "comm.json");
  mkdirSync(path.dirname(commPath), { recursive: true });
  writeComm(commPath, {
    replay: slpPath,
    startFrame: o.startFrame ?? -123,
    endFrame: o.endFrame ?? lastFrame,
    isRealTimeMode: false,
  });

  const args = recordArgs(paths, { ...o, commPath, baseName: base });

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
  let out: RunOutcome;
  try {
    out = await runDolphin(paths, slpPath, { args, commPath }, runOpts);
  } finally {
    (placing as PlacementHandle | null)?.stop();
  }
  const placement = placing ? await (placing as PlacementHandle).done : place.skipped;

  const avi = path.join(o.outDir, `${base}.avi`);
  const wav = path.join(o.outDir, `${base}.wav`);
  if (!existsSync(avi)) throw noVideoError(slpPath, out);

  return {
    avi,
    wav: existsSync(wav) ? wav : null,
    lastFrame,
    stalled: out.stalled,
    stoppedEarly: out.stoppedEarly,
    diagnostic: out.diagnostic,
    placement,
    exitCode: out.exitCode,
    exitSignal: out.exitSignal,
    stdoutTail: out.stdoutTail,
    stderrTail: out.stderrTail,
  };
}

/** The argv for a frame dump. Pure, for tests. */
export function recordArgs(
  paths: DolphinPaths,
  o: Pick<RecordOptions, "userDir" | "outDir" | "batch"> & { commPath: string; baseName: string },
): string[] {
  return [
    "-i", o.commPath,
    "-o", o.baseName,
    `--output-directory=${o.outDir}`,
    ...(o.batch === false ? [] : ["-b"]),
    "-e", paths.isoPath,
    "--user", o.userDir,
    "--hide-seekbar",
    "--cout",
  ];
}

/**
 * The argv for a preview. Pure, for tests.
 *
 * No `-o` and no `--output-directory`: those are what make a run DUMP, and a
 * preview that quietly wrote frames would fill a disk behind the operator.
 * `--cout` stays — it is how the end frame is detected at all.
 */
export function playArgs(
  paths: DolphinPaths,
  o: Pick<PlayOptions, "userDir" | "batch" | "hideSeekbar"> & { commPath: string },
): string[] {
  return [
    "-i", o.commPath,
    ...(o.batch === false ? [] : ["-b"]),
    "-e", paths.isoPath,
    "--user", o.userDir,
    ...(o.hideSeekbar ? ["--hide-seekbar"] : []),
    "--cout",
  ];
}

/**
 * Play a frame range with the window ON SCREEN and no dump — a clip preview.
 *
 * The third launch shape, and the one the package was missing: `record()`
 * dumps and runs hidden in batch, `obsMirror()` wants OBS capture env and a
 * mirror comm with no frame range. A preview is neither. `--cout` is kept, so
 * the same numeric end-frame rule stops it at the right place (gotcha 7)
 * rather than a timer guessing that playback finished.
 *
 * Build the profile with `mode: "play"` first — this does not touch it.
 */
export async function play(paths: DolphinPaths, slpPath: string, o: PlayOptions): Promise<PlayResult> {
  if (o.signal?.aborted) throw new Error("canceled");
  if (!existsSync(slpPath)) throw new Error(`replay not found: ${slpPath}`);
  const why = dolphinStatus(paths, statusContext(o));
  if (why) throw new Error(`cannot play: ${why}`);
  if (!existsSync(o.userDir)) throw new Error(`user dir does not exist: ${o.userDir}`);

  const scanned = o.lastFrame ?? lastFrameOf(slpPath);
  const lastFrame = scanned != null && scanned > 0 ? scanned : (o.endFrame ?? null);
  if (lastFrame == null || lastFrame <= 0) {
    throw new Error(
      `could not read lastFrame from ${slpPath} — pass lastFrame or endFrame if you already know it`,
    );
  }

  const commPath = o.commPath ?? path.join(o.userDir, "comm.json");
  mkdirSync(path.dirname(commPath), { recursive: true });
  writeComm(commPath, {
    replay: slpPath,
    startFrame: o.startFrame ?? -123,
    endFrame: o.endFrame ?? lastFrame,
    isRealTimeMode: o.isRealTimeMode ?? false,
  });

  const args = playArgs(paths, { ...o, commPath });

  const place = await preparePlacement(o, o.display);
  let placing: PlacementHandle | null = null;
  const runOpts: PlayOptions = {
    ...o,
    onSpawn: (pid) => {
      if (place.start) placing = place.start(pid);
      o.onSpawn?.(pid);
    },
  };
  let out: RunOutcome;
  try {
    out = await runDolphin(paths, slpPath, { args, commPath }, runOpts);
  } finally {
    (placing as PlacementHandle | null)?.stop();
  }
  const placement = placing ? await (placing as PlacementHandle).done : place.skipped;

  return {
    lastFrame,
    stalled: out.stalled,
    stoppedEarly: out.stoppedEarly,
    diagnostic: out.diagnostic,
    placement,
    exitCode: out.exitCode,
    exitSignal: out.exitSignal,
    stdoutTail: out.stdoutTail,
    stderrTail: out.stderrTail,
  };
}

/** What dolphinStatus should know about a run: its env and display. */
export function statusContext(o: Pick<RunOptions, "env" | "display">): { env: NodeJS.ProcessEnv; display?: string } {
  return { env: { ...process.env, ...(o.env ?? {}) }, display: o.display };
}

/** How many stderr lines go into the "produced no video" MESSAGE (all of them are on the error). */
const NO_VIDEO_MESSAGE_LINES = 8;

/**
 * The "produced no video" rejection, carrying what Dolphin said. It used to be
 * the bare sentence, and a run that produces no AVI produces no diagnostic
 * either, so contention, a bad profile and a startup crash all looked the same.
 * The message starts exactly as before, for anyone matching on it.
 */
export function noVideoError(slpPath: string, out: ExitInfo & { diagnostic: StallDiagnostic | null }): DolphinRunError {
  const how =
    out.exitSignal != null ? `killed by ${out.exitSignal}` : out.exitCode != null ? `exit code ${out.exitCode}` : "no exit status";
  const why = out.diagnostic ? `, ${out.diagnostic.reason}` : "";
  const said = out.stderrTail.slice(-NO_VIDEO_MESSAGE_LINES);
  const msg =
    `Dolphin produced no video for ${slpPath} (${how}${why})` +
    (said.length ? `; stderr tail:\n${said.join("\n")}` : "; stderr was empty");
  return Object.assign(new Error(msg), {
    code: "no-video" as const,
    replay: slpPath,
    exitCode: out.exitCode,
    exitSignal: out.exitSignal,
    stdoutTail: out.stdoutTail,
    stderrTail: out.stderrTail,
    diagnostic: out.diagnostic,
  });
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
