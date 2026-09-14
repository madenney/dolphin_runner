import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { writeComm } from "./comm.ts";
import { foldEnd, parseFrameLine, reachedEnd } from "./frames.ts";
import { killTree } from "./kill.ts";
import { lastFrameOf } from "./slp.ts";
import { dolphinStatus } from "./status.ts";
import type {
  DolphinPaths,
  RecordOptions,
  RecordResult,
  RunOptions,
  StallDiagnostic,
} from "./types.ts";

const DEFAULT_BOOT_STALL_MS = 90_000;
const DEFAULT_FRAME_STALL_MS = 30_000;
const TAIL_LINES = 60;

interface SpawnPlan {
  args: string[];
  commPath: string;
}

/** Keep the last N lines of a stream — a bounded diagnostic, not a transcript. */
function tailBuffer(limit = TAIL_LINES) {
  const lines: string[] = [];
  return {
    lines,
    push(line: string) {
      if (!line.trim()) return;
      lines.push(line);
      if (lines.length > limit) lines.shift();
    },
  };
}

/**
 * Drive one Dolphin to completion. Shared by record() and mirror(): they differ
 * only in their args and in what they do with the output afterwards.
 */
async function runDolphin(
  paths: DolphinPaths,
  slpPath: string,
  plan: SpawnPlan,
  o: RunOptions,
): Promise<{ stalled: boolean; diagnostic: StallDiagnostic | null }> {
  const bootStallMs = o.bootStallMs ?? DEFAULT_BOOT_STALL_MS;
  const frameStallMs = o.frameStallMs ?? DEFAULT_FRAME_STALL_MS;

  return await new Promise((resolvePromise, reject) => {
    const env = { ...process.env, ...(o.display ? { DISPLAY: o.display } : {}) };
    const child = spawn(paths.dolphinPath, plan.args, { env });

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

/** Frame-dump one replay. Returns the raw dump paths — muxing is the caller's job. */
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

  const { stalled, diagnostic } = await runDolphin(paths, slpPath, { args, commPath }, o);

  const avi = path.join(o.outDir, `${base}.avi`);
  const wav = path.join(o.outDir, `${base}.wav`);
  if (!existsSync(avi)) throw new Error(`Dolphin produced no video for ${slpPath}`);

  return {
    avi,
    wav: existsSync(wav) ? wav : null,
    lastFrame,
    stalled,
    diagnostic,
  };
}

/**
 * Play one replay live, window on screen, no dump.
 *
 * PROVISIONAL — the signature is not locked. MST's real mirror spawn has not
 * been read yet, and its needs (workspace parking, OBS capture handoff, how a
 * mirror is stopped and restarted between games) may change the shape. Do not
 * migrate MST onto this without reading its spawn first.
 */
export async function mirror(
  paths: DolphinPaths,
  slpPath: string,
  o: RunOptions & { batch?: boolean; endFrame?: number },
): Promise<void> {
  if (o.signal?.aborted) throw new Error("canceled");
  if (!existsSync(slpPath)) throw new Error(`replay not found: ${slpPath}`);
  const why = dolphinStatus(paths);
  if (why) throw new Error(`cannot mirror: ${why}`);

  const lastFrame = lastFrameOf(slpPath);
  const commPath = path.join(o.userDir, "comm.json");
  writeComm(commPath, {
    replay: slpPath,
    startFrame: -123,
    endFrame: o.endFrame ?? lastFrame ?? 0,
    isRealTimeMode: true,
  });

  const args = [
    "-i", commPath,
    ...(o.batch === false ? [] : ["-b"]),
    "-e", paths.isoPath,
    "--user", o.userDir,
    "--cout",
  ];

  await runDolphin(paths, slpPath, { args, commPath }, o);
}
