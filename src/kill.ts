import { spawnSync, spawn } from "node:child_process";

const isWindows = process.platform === "win32";

/**
 * Our pid plus every descendant.
 *
 * An AppImage execs, so the pid that owns the Dolphin window is rarely the one
 * we spawned. Killing only the direct child leaves the real emulator running,
 * holding the GPU and the user dir — which is how a "cancelled" batch leaves
 * Dolphins behind.
 */
export function pidTree(root: number): number[] {
  if (isWindows) return [root]; // taskkill /T walks the tree itself
  const out = [root];
  for (let i = 0; i < out.length; i++) {
    const kids = spawnSync("pgrep", ["-P", String(out[i]!)], { encoding: "utf8" }).stdout || "";
    for (const k of kids.split(/\s+/).filter(Boolean)) {
      const pid = Number(k);
      if (Number.isFinite(pid) && !out.includes(pid)) out.push(pid);
    }
  }
  return out;
}

/**
 * Kill a process and everything it spawned.
 *
 * `graceful` sends SIGTERM first so a frame dump can finalise its .avi/.wav —
 * use it at end-of-replay. A stall or an abort should not wait: pass false.
 * Windows has no real signals, so `taskkill /T /F` is the whole story there.
 */
export function killTree(root: number, graceful = false, escalateMs = 5000): void {
  if (isWindows) {
    try {
      // A failed spawn (no taskkill on PATH) is an ASYNC 'error' event, which
      // try/catch never sees — unhandled, it would crash the host process.
      spawn("taskkill", ["/pid", String(root), "/T", "/F"], { stdio: "ignore" }).on("error", () => {});
    } catch {
      /* already gone */
    }
    return;
  }
  const pids = pidTree(root);
  const send = (sig: NodeJS.Signals) => {
    // Children first: killing the parent first can reparent the tree to init
    // and orphan exactly the process we were trying to reach.
    for (const pid of [...pids].reverse()) {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
  };
  if (!graceful) {
    send("SIGKILL");
    return;
  }
  send("SIGTERM");
  const t = setTimeout(() => send("SIGKILL"), escalateMs);
  t.unref?.();
}
