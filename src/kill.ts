import { spawnSync, spawn } from "node:child_process";

/**
 * What killTree needs from the OS, injectable so the Windows branch is testable
 * on Linux (the machine that writes this code cannot run taskkill).
 */
export interface KillDeps {
  /** `process.platform`. Default: the real one. */
  platform?: NodeJS.Platform;
  /** Run a fire-and-forget command (taskkill). Must never throw. */
  exec?: (cmd: string, args: string[]) => void;
  /** Send a POSIX signal to one pid. Must never throw. */
  signal?: (pid: number, sig: NodeJS.Signals) => void;
  /** Our pid plus its descendants (POSIX). Default: `pidTree`. */
  tree?: (root: number) => number[];
  /** Is this pid still running? Used before the Windows escalation. */
  alive?: (pid: number) => boolean;
  /** Called when a graceful stop had to be forced (the escalation fired on a live process). */
  onForce?: () => void;
}

/**
 * Our pid plus every descendant.
 *
 * An AppImage execs, so the pid that owns the Dolphin window is rarely the one
 * we spawned. Killing only the direct child leaves the real emulator running,
 * holding the GPU and the user dir — which is how a "cancelled" batch leaves
 * Dolphins behind.
 */
export function pidTree(root: number, platform: NodeJS.Platform = process.platform): number[] {
  if (platform === "win32") return [root]; // taskkill /T walks the tree itself
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
 * The taskkill argv. Pure, for tests.
 *
 * Without `/F`, taskkill asks politely: it posts WM_CLOSE to the process's
 * windows, which is Windows' nearest thing to SIGTERM and the only way a frame
 * dump gets to finalise its `.avi`. `/F` is TerminateProcess — no cleanup, no
 * index. `/T` takes the children too in both cases.
 */
export function taskkillArgs(pid: number, force: boolean): string[] {
  return ["/pid", String(pid), "/T", ...(force ? ["/F"] : [])];
}

function defaultExec(cmd: string, args: string[]): void {
  try {
    // A failed spawn (no taskkill on PATH) is an ASYNC 'error' event, which
    // try/catch never sees — unhandled, it would crash the host process.
    // windowsHide: a console flashing up for every kill is noise on a desktop.
    spawn(cmd, args, { stdio: "ignore", windowsHide: true }).on("error", () => {});
  } catch {
    /* already gone */
  }
}

function defaultSignal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    /* already gone */
  }
}

function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists and belongs to someone else — still alive.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Kill a process and everything it spawned.
 *
 * `graceful` asks first so a frame dump can finalise its .avi/.wav — use it at
 * end-of-replay — and escalates to a hard kill after `escalateMs`. A stall or
 * an abort should not wait: pass false.
 *
 * POSIX: SIGTERM, then SIGKILL, children first. Windows has no signals:
 * graceful is `taskkill /T` (WM_CLOSE), then `taskkill /T /F` if the process is
 * still there; not graceful is `/T /F` straight away. Before 0.5.7 Windows was
 * ALWAYS `/F`, so a recording that reached its end frame was terminated
 * mid-write and AVIDump never wrote its index. (The profile sets
 * `[Interface] ConfirmStop = False`, so WM_CLOSE does not stop at a "stop
 * emulation?" dialog.) The Windows path is unverified at runtime.
 */
export function killTree(root: number, graceful = false, escalateMs = 5000, deps: KillDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    const exec = deps.exec ?? defaultExec;
    const alive = deps.alive ?? defaultAlive;
    if (!graceful) {
      exec("taskkill", taskkillArgs(root, true));
      return;
    }
    exec("taskkill", taskkillArgs(root, false));
    const t = setTimeout(() => {
      // Only if it ignored the polite request: a pid that is gone may already
      // belong to something else.
      if (alive(root)) {
        deps.onForce?.();
        exec("taskkill", taskkillArgs(root, true));
      }
    }, escalateMs);
    t.unref?.();
    return;
  }
  const pids = (deps.tree ?? ((r: number) => pidTree(r, platform)))(root);
  const signal = deps.signal ?? defaultSignal;
  const send = (sig: NodeJS.Signals) => {
    // Children first: killing the parent first can reparent the tree to init
    // and orphan exactly the process we were trying to reach.
    for (const pid of [...pids].reverse()) signal(pid, sig);
  };
  if (!graceful) {
    send("SIGKILL");
    return;
  }
  send("SIGTERM");
  const t = setTimeout(() => {
    // POSIX: no cheap liveness check across the tree; report only if the root is still up.
    if ((deps.alive ?? defaultAlive)(root)) deps.onForce?.();
    send("SIGKILL");
  }, escalateMs);
  t.unref?.();
}
