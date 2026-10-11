/**
 * End-to-end smoke test: record ONE real replay with a real Playback Dolphin
 * and check the dump length against `lastFrame`.
 *
 * This is the one thing `npm test` cannot do — it needs a Dolphin, an ISO, a
 * GPU and a DISPLAY. It is NOT part of the suite. Run it by hand:
 *
 *   node scripts/smoke.ts [replay.slp]
 *
 * Env (no defaults for machine paths — see the usage error below):
 *   DOLPHIN   path to Slippi_Playback AppImage/exe
 *   ISO       path to the Melee ISO
 *   DISPLAY   X display for the GL context
 *   KEEP=1    leave the temp dirs behind for inspection
 *   EFB=2     EFBScale for the throwaway profile (default 2). Omitting it in a
 *             consumer inherits the real profile's value — whatever the user
 *             last played at. On this rig that was 7, which made the first
 *             smoke run a 25 GB lossless AVI at ~4 fps.
 *
 * ffprobe is used to measure the .avi — that is the CONSUMER's duration guard,
 * simulated here. It is not a dependency of the package.
 *
 * The leak and real-profile checks are only conclusive when nothing else is
 * running a Dolphin at the same time; the harness says so if it saw one.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProfile, dolphinStatus, lastFrameOf, record } from "../src/index.ts";

const paths = {
  dolphinPath:
    process.env.DOLPHIN ??
    path.join(os.homedir(), ".config", "Slippi Launcher", "playback", "Slippi_Playback-x86_64.AppImage"),
  isoPath: process.env.ISO ?? "",
};
const slp = process.argv[2] ?? process.env.SLP ?? "";
if (!paths.isoPath || !slp) {
  console.error(
    "usage: ISO=/path/to/melee.iso npm run smoke -- /path/to/replay.slp\n" +
      "  ISO      (required) the SSBM ISO\n" +
      "  SLP      the replay, if not given as the argument\n" +
      "  DOLPHIN  the Playback AppImage, if not in the default Slippi Launcher location\n" +
      "  DISPLAY  defaults to :1\n" +
      "These are machine paths on purpose: nothing identifying is committed here.",
  );
  process.exit(2);
}
const display = process.env.DISPLAY ?? ":1";

function log(msg: string, extra?: unknown) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}`, extra === undefined ? "" : JSON.stringify(extra));
}

/**
 * Every Dolphin-ish process, by exact comm name so we never match our own
 * shell. `Slippi_Playback` is the AppImage's FUSE mount daemon — it setsid()s
 * and outlives the emulator by a few seconds while the mount is torn down.
 */
function dolphinProcs(): string[] {
  const r = spawnSync("pgrep", ["-a", "-x", "Slippi_Playback|dolphin-emu|AppRun.wrapped"], { encoding: "utf8" });
  return (r.stdout || "").split("\n").filter(Boolean);
}

async function waitForProcsToClear(ignore: string[], maxMs = 20_000): Promise<string[]> {
  const t = Date.now();
  let left: string[] = [];
  do {
    left = dolphinProcs().filter((l) => !ignore.includes(l));
    if (!left.length) return [];
    await new Promise((r) => setTimeout(r, 1000));
  } while (Date.now() - t < maxMs);
  return left;
}

function sha(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function aviDurationSec(file: string): number {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  );
  return parseFloat(out.trim());
}

async function main() {
  const why = dolphinStatus(paths);
  if (why) throw new Error(why);

  const before = dolphinProcs();
  if (before.length) log("WARNING: other Dolphins running — leak/profile checks will be inconclusive", before);

  const realCfg = path.join(os.homedir(), ".config", "SlippiPlayback", "Config");
  const realFiles = ["Dolphin.ini", "GFX.ini"].map((f) => path.join(realCfg, f));
  const realBefore = realFiles.map(sha);

  const expectedLast = lastFrameOf(slp);
  log("replay", { slp, lastFrame: expectedLast });

  const work = mkdtempSync(path.join(os.tmpdir(), "dr-smoke-"));
  const userDir = path.join(work, "user");
  const outDir = path.join(work, "out");
  mkdirSync(userDir, { recursive: true });

  const efbScale = Number(process.env.EFB ?? 2);
  log("buildProfile →", { userDir, efbScale });
  await buildProfile(userDir, { mode: "record", efbScale, dolphinPath: paths.dolphinPath });

  let lastReported = -Infinity;
  const t0 = Date.now();
  log("record() start", { display, outDir });
  const res = await record(paths, slp, {
    outDir,
    userDir,
    display,
    onFrame: (cur, end) => {
      // Throttle: every ~10% or 600 frames.
      if (cur - lastReported >= 600 || cur >= end) {
        lastReported = cur;
        log(`  frame ${cur}/${end} (${Math.round((100 * (cur + 123)) / (end + 123))}%)`);
      }
    },
  });
  const tExit = Date.now();
  const wallSec = (tExit - t0) / 1000;
  log("record() resolved", { wallSec, avi: res.avi, wav: res.wav, lastFrame: res.lastFrame, stalled: res.stalled });
  if (res.diagnostic) log("diagnostic", res.diagnostic);

  // --- Checks -------------------------------------------------------------
  const failures: string[] = [];

  const expectedSec = (res.lastFrame + 123) / 60;
  const gotSec = aviDurationSec(res.avi);
  const ratio = gotSec / expectedSec;
  log("duration", { expectedSec: +expectedSec.toFixed(2), gotSec: +gotSec.toFixed(2), ratio: +ratio.toFixed(3) });
  if (ratio < 0.9) failures.push(`dump is short: ${gotSec.toFixed(1)}s vs expected ${expectedSec.toFixed(1)}s`);
  if (ratio > 1.1) failures.push(`dump is LONG: ${gotSec.toFixed(1)}s vs expected ${expectedSec.toFixed(1)}s — end-frame kill did not fire?`);

  const aviBytes = statSync(res.avi).size;
  log("avi size", { mb: +(aviBytes / 1e6).toFixed(1) });
  if (aviBytes < 1e6) failures.push(`avi suspiciously small: ${aviBytes} bytes`);
  if (!res.wav) failures.push("no .wav produced — DSP dump flags not honoured?");

  if (res.stalled) failures.push("watchdog fired (stalled: true) on a healthy replay");
  if (res.lastFrame !== expectedLast) failures.push(`lastFrame mismatch: ${res.lastFrame} vs ${expectedLast}`);

  // Nothing of ours may survive. The FUSE daemon needs a few seconds.
  const after = await waitForProcsToClear(before);
  if (after.length) failures.push(`leaked Dolphin processes:\n  ${after.join("\n  ")}`);

  // The real profile must be byte-identical. buildProfile never writes it and
  // a --user Dolphin must not either — this is the assertion the package
  // exists for. Dolphin saves config on exit, so if the bytes changed, the
  // mtime relative to OUR exit says whether it could have been us.
  const foreign = before.length || dolphinProcs().filter((l) => !before.includes(l)).length;
  realFiles.forEach((f, i) => {
    if (sha(f) === realBefore[i]) return;
    const mtime = statSync(f).mtimeMs;
    const when = `written ${new Date(mtime).toISOString()}, our Dolphin exited ${new Date(tExit).toISOString()}`;
    if (mtime >= tExit - 5000 && !foreign) failures.push(`REAL PROFILE WAS MODIFIED by our run: ${f} (${when})`);
    else log(`NOTE: real profile changed during the run but not at our exit — ${foreign ? "other Dolphins were running; " : ""}${f} ${when}`);
  });

  if (process.env.KEEP) log("keeping", work);
  else rmSync(work, { recursive: true, force: true });

  if (failures.length) {
    console.error("\nSMOKE FAILED:");
    for (const f of failures) console.error(" - " + f);
    process.exit(1);
  }
  log("SMOKE PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
