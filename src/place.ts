import { execFile } from "node:child_process";
import { pidTree } from "./kill.ts";
import type { PlacementOptions, PlacementReport, PlacedWindow, RunnerWarning } from "./types.ts";

/**
 * Window parking: move the windows of ONE Dolphin process tree onto another
 * EWMH workspace, so a background Dolphin never sits on the user's screen.
 *
 * Why the runner owns this (2026-10-09): four projects had copy-pasted parkers,
 * and two matched windows by TITLE ("dolphin", "slippi", "playback") — so one
 * project's parker grabbed another's in-progress recordings, and on a shared
 * box someone's netplay window. Only the code that spawned the
 * process knows its pid tree for sure. RULE: windows are found by pid, never
 * by title or class. Every Playback window is WM_CLASS "AppRun.wrapped" with
 * the same title, so nothing else can tell instances apart anyway.
 *
 * Method (measured on GNOME/mutter + RTX 5080, docs/background-and-mute.md):
 * poll fast; on a window the WM has not managed yet, set `_NET_WM_DESKTOP` so
 * the WM maps it straight onto the target (no flash). Once the WM manages it
 * (WM_STATE present), ALWAYS send the EWMH move too and read the desktop back.
 *
 * NEVER TRUST A PROPERTY YOU WROTE. Dolphin creates its two real windows and
 * maps them within one ~80 ms poll, so they are usually already up when found.
 * Writing `_NET_WM_DESKTOP` onto a MAPPED window does nothing on mutter — but
 * reading it back returns what we wrote. The first version "confirmed" every
 * window that way while the windows sat on the user's screen for the whole run
 * (measured 2026-10-09). The property is only written while the WM doesn't
 * know the window; after that, only the WM writes it.
 *
 * Dolphin raises itself at launch unconditionally, and a window moved to
 * another workspace KEEPS keyboard focus (measured: 18 s of a 36 s run) — so
 * the user's typing goes to a hidden Dolphin. `restoreFocus` (default on)
 * hands focus back to the window that had it before, only if that window is on
 * the user's current workspace, so it can never switch workspaces on them.
 *
 * Linux/X11 only, via xdotool + xprop + xwininfo (optional system tools; the
 * package keeps zero npm dependencies, as with pgrep/taskkill). Never fatal
 * unless `required`. Never moves a window twice once it is confirmed, so it
 * never fights a user who drags it back.
 */

const FAST_POLL_MS = 20;
const FAST_PHASE_MS = 5_000;
const SLOW_POLL_MS = 250;
const DEFAULT_TIMEOUT_MS = 20_000;
/**
 * Re-send the move this often until the WM reports it applied, at most
 * MAX_MOVES times. mutter answers a move sent in the first moments after
 * map late or not at all; re-sending is what lands it.
 */
const MOVE_RETRY_MS = 100;
const MAX_MOVES = 40;
/** The pid tree is stable after launch (the AppImage execs); re-walk it this often. */
const TREE_REFRESH_MS = 500;

/** The X11 calls placement needs. Injected in tests; real ones shell out. */
export interface X11 {
  /** EWMH WM present? How many workspaces? null = no EWMH window manager. */
  wmDesktops(): Promise<number | null>;
  /** Window ids whose `_NET_WM_PID` is `pid`, mapped or not. */
  windowsOf(pid: number): Promise<string[]>;
  /** Has the WM taken this window on (WM_STATE set)? Before that, the property route works. */
  isManaged(id: string): Promise<boolean>;
  /** Set the property directly — what the WM reads when the window maps. */
  setDesktopProperty(id: string, desktop: number): Promise<void>;
  /** The EWMH client message — how a MAPPED window is moved. */
  moveToDesktop(id: string, desktop: number): Promise<void>;
  getDesktop(id: string): Promise<number | null>;
  /** The focused window, or null. */
  activeWindow(): Promise<string | null>;
  /** The workspace the user is looking at. */
  currentDesktop(): Promise<number | null>;
  /** Give `id` focus (EWMH activate). */
  activate(id: string): Promise<void>;
  /** Our pid plus descendants (the AppImage execs; see kill.ts). */
  pidTree(root: number): number[];
  /** Is the process still alive? */
  alive(pid: number): boolean;
  /**
   * Move AND resize a managed window, via EWMH `_NET_MOVERESIZE_WINDOW`.
   * A raw ConfigureWindow is ignored by mutter for managed windows; the EWMH
   * message (what `wmctrl -e` sends) is honoured.
   */
  moveResize(id: string, r: Rect): Promise<void>;
  /** Strip decorations via `_MOTIF_WM_HINTS` (flags=DECORATIONS, decorations=0). */
  undecorate(id: string): Promise<void>;
  /** Connected monitors and their rects, for `monitor` selection. */
  monitors(): Promise<Monitor[]>;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Monitor extends Rect {
  name: string;
}

function run(cmd: string, args: string[], display: string | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(display ? { DISPLAY: display } : {}) };
    execFile(cmd, args, { env, timeout: 2000, encoding: "utf8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** The real X11 calls, through xdotool / xprop / xwininfo on `display`. */
export function systemX11(display?: string): X11 {
  const ok = (p: Promise<unknown>) => p.then(() => {}, () => {});
  return {
    async wmDesktops() {
      const out = await run("xprop", ["-root", "-notype", "_NET_SUPPORTING_WM_CHECK", "_NET_NUMBER_OF_DESKTOPS"], display);
      if (!/_NET_SUPPORTING_WM_CHECK.*window id/i.test(out)) return null;
      const m = /_NET_NUMBER_OF_DESKTOPS\s*=\s*(\d+)/.exec(out);
      return m ? Number(m[1]) : null;
    },
    async windowsOf(pid) {
      // xdotool exits 1 when nothing matches — that is "none yet", not an error.
      const out = await run("xdotool", ["search", "--pid", String(pid)], display).catch(() => "");
      return out.split(/\s+/).filter(Boolean);
    },
    async isManaged(id) {
      const out = await run("xprop", ["-id", id, "WM_STATE"], display).catch(() => "");
      return /window state:/i.test(out);
    },
    setDesktopProperty: (id, d) =>
      ok(run("xprop", ["-id", id, "-f", "_NET_WM_DESKTOP", "32c", "-set", "_NET_WM_DESKTOP", String(d)], display)),
    moveToDesktop: (id, d) => ok(run("xdotool", ["set_desktop_for_window", id, String(d)], display)),
    getDesktop: async (id) => int(await run("xdotool", ["get_desktop_for_window", id], display).catch(() => "")),
    activeWindow: async () =>
      (await run("xdotool", ["getactivewindow"], display).catch(() => "")).trim() || null,
    currentDesktop: async () => int(await run("xdotool", ["get_desktop"], display).catch(() => "")),
    activate: (id) => ok(run("xdotool", ["windowactivate", id], display)),
    moveResize: (id, r) =>
      // `wmctrl -e <gravity>,<x>,<y>,<w>,<h>`; gravity 0 = whatever the WM uses.
      ok(run("wmctrl", ["-i", "-r", id, "-e", `0,${r.x},${r.y},${r.width},${r.height}`], display)),
    undecorate: (id) =>
      // MWM_HINTS_DECORATIONS (flags=2), decorations=0. A titlebar otherwise
      // eats ~37px off the top and a capture grabs the SHORTER client surface.
      ok(run("xprop", ["-id", id, "-f", "_MOTIF_WM_HINTS", "32c", "-set", "_MOTIF_WM_HINTS", "2, 0, 0, 0, 0"], display)),
    async monitors() {
      const out = await run("xrandr", ["--listmonitors"], display).catch(() => "");
      const found: Monitor[] = [];
      for (const line of out.split("\n")) {
        // ` 0: +*DP-2 1920/598x1080/336+0+0  DP-2`
        const m = /^\s*\d+:\s+\+?\*?(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/.exec(line);
        if (m) found.push({ name: m[1]!, width: +m[2]!, height: +m[3]!, x: +m[4]!, y: +m[5]! });
      }
      return found;
    },
    pidTree,
    alive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function int(out: string): number | null {
  const t = out.trim();
  const n = Number(t);
  return t !== "" && Number.isInteger(n) ? n : null;
}

export type PlacementCheck = { ok: true; desktops: number } | { ok: false; warning: RunnerWarning };

/**
 * Can placement work here? Checked BEFORE spawning, so `required` fails fast
 * instead of after a launch. Order matters: the cheapest, most common
 * "not here" answers first.
 */
export async function checkPlacement(
  o: Pick<PlacementOptions, "workspace" | "display">,
  x: X11 = systemX11(o.display),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlacementCheck> {
  const no = (code: RunnerWarning["code"], detail: string): PlacementCheck => ({ ok: false, warning: { code, detail } });
  const last = o.workspace === "last";
  if (!last && (!Number.isInteger(o.workspace) || (o.workspace as number) < 0)) {
    return no("placement-unsupported", `workspace must be a 0-based integer or "last", got ${o.workspace}`);
  }
  if (platform !== "linux") return no("placement-unsupported", `window placement is Linux/X11 only (this is ${platform})`);
  if (!(o.display ?? env.DISPLAY)) return no("placement-unsupported", "no DISPLAY to place windows on");
  let desktops: number | null;
  try {
    desktops = await x.wmDesktops();
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException)?.code === "ENOENT";
    return no(
      "placement-unsupported",
      missing ? "xprop/xdotool/xwininfo not installed (apt: x11-utils xdotool)" : `could not query the X server: ${String(e)}`,
    );
  }
  if (desktops == null) {
    // Xvfb and other bare displays: no window manager, and nobody looking.
    return no("placement-no-wm", "no EWMH window manager on this display — nothing to park, and nothing to hide from");
  }
  if (!last && (o.workspace as number) >= desktops) {
    return no("placement-no-workspace", `workspace ${o.workspace} does not exist (this display has ${desktops}, 0-based)`);
  }
  return { ok: true, desktops };
}

export interface PlacementHandle {
  /** Resolves when placement finishes: timeout, process exit, or stop(). Never rejects. */
  done: Promise<PlacementReport>;
  /** Stop polling now; `done` resolves with what was placed so far. */
  stop(): void;
}

/**
 * Park the windows of `pid`'s process tree on `o.workspace`, for up to
 * `o.timeoutMs` (default 20 s) — long enough for Dolphin's main and render
 * windows, both of which map within ~1 s of each other. Call it the moment you
 * have the pid: windows are findable ~220 ms after spawn and map at ~400 ms+,
 * and pre-map placement is the only kind that never flashes.
 *
 * Does NOT run its own preflight; call `checkPlacement` first (record() and
 * obsMirror() do).
 */
export function placeWindows(
  pid: number,
  o: PlacementOptions & { previousActive?: string | null },
  x: X11 = systemX11(o.display),
): PlacementHandle {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // `"last"` (GNOME dynamic workspaces) is resolved to the trailing workspace
  // on the first tick, once we can ask the WM how many there are.
  let ws: number = typeof o.workspace === "number" ? o.workspace : -1;
  let wanted: Rect | null = null;
  let geometryResolved = false;
  const restoreFocus = o.restoreFocus !== false;
  const t0 = Date.now();
  type W = {
    id: string;
    mapped: boolean;
    desktop: number | null;
    moves: number;
    lastMove: number;
    confirmed: boolean;
    shaped: boolean;
  };
  let tree: number[] = [];
  let treeAt = -Infinity;
  let focusRestored = false;
  const seen = new Map<string, W>();
  let stopped = false;
  let wake: (() => void) | null = null;

  const stop = () => {
    stopped = true;
    wake?.();
  };
  o.signal?.addEventListener?.("abort", stop, { once: true });

  const sleep = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      t.unref?.();
      wake = () => {
        clearTimeout(t);
        r();
      };
    });

  async function tick() {
    if (ws < 0) {
      // Resolve `"last"` now: the trailing workspace (0-based desktops - 1).
      const n = await x.wmDesktops().catch(() => null);
      ws = n && n > 0 ? n - 1 : 0;
    }
    if (Date.now() - treeAt > TREE_REFRESH_MS) {
      tree = x.pidTree(pid);
      treeAt = Date.now();
    }
    const ids = new Set<string>();
    for (const p of tree) for (const id of await x.windowsOf(p)) ids.add(id);
    for (const id of ids) {
      let w = seen.get(id);
      if (!w) {
        w = { id, mapped: await x.isManaged(id), desktop: null, moves: 0, lastMove: 0, confirmed: false, shaped: false };
        seen.set(id, w);
        // Not yet managed: the WM reads this when it maps the window, so it
        // never appears on the user's workspace. Harmless on the unmapped
        // helper windows Dolphin also creates. Too late once managed — see top.
        if (!w.mapped) await x.setDesktopProperty(id, ws);
      }
      if (w.confirmed) continue;
      if (!w.mapped) w.mapped = await x.isManaged(id);
      if (!w.mapped) continue;
      // Managed: always send the real move once (a racing pre-map write may
      // have landed after the map), then believe only what the WM reports.
      if (w.moves === 0 || (w.moves < MAX_MOVES && Date.now() - w.lastMove >= MOVE_RETRY_MS)) {
        w.moves++;
        w.lastMove = Date.now();
        await x.moveToDesktop(id, ws);
      }
      // Shape it once, after the WM owns it. Decorations first: stripping them
      // changes the frame, so sizing before would leave the client area short
      // by exactly the titlebar — the bug this exists to avoid.
      if (!w.shaped && (o.undecorate || o.geometry || o.monitor)) {
        w.shaped = true;
        if (o.undecorate) await x.undecorate(id);
        const rect = await resolveGeometry();
        if (rect) await x.moveResize(id, rect);
      }
      w.desktop = await x.getDesktop(id);
      if (w.desktop === ws) w.confirmed = true;
    }
    if (restoreFocus && !focusRestored) await giveFocusBack(ids);
  }

  /**
   * The rect to give our windows: an explicit `geometry`, else the chosen
   * `monitor` filled edge to edge. Resolved once, lazily — `xrandr` is a
   * process, and a run that asks for neither should never pay for it.
   */
  async function resolveGeometry(): Promise<Rect | null> {
    if (geometryResolved) return wanted;
    geometryResolved = true;
    if (o.geometry && o.geometry.x != null && o.geometry.y != null) {
      wanted = o.geometry as Rect;
      return wanted;
    }
    let origin: Rect | null = null;
    if (o.monitor) {
      const all = await x.monitors().catch(() => [] as Monitor[]);
      origin =
        o.monitor === "landscape"
          ? // The widest LANDSCAPE output. A rig with a rotated portrait
            // primary would otherwise give a feed a portrait surface.
            all.filter((m) => m.width > m.height).sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null
          : all.find((m) => m.name === o.monitor) ?? null;
      if (!origin) {
        warn(o, {
          code: "placement-no-monitor",
          detail: `no ${o.monitor === "landscape" ? "landscape" : `monitor named ${o.monitor}`} found; leaving geometry alone`,
        });
      }
    }
    if (o.geometry) {
      // Size from the caller, position from the monitor when it gave none.
      wanted = {
        x: o.geometry.x ?? origin?.x ?? 0,
        y: o.geometry.y ?? origin?.y ?? 0,
        width: o.geometry.width,
        height: o.geometry.height,
      };
    } else {
      wanted = origin;
    }
    return wanted;
  }

  /**
   * If one of OUR windows has focus once parked, hand it back to whatever had
   * it before launch — only when that window is on the workspace the user is
   * looking at (activating a window elsewhere would switch workspaces on them).
   */
  async function giveFocusBack(ours: Set<string>) {
    const prev = o.previousActive;
    if (!prev || ours.has(prev)) return;
    const parked = [...seen.values()].filter((w) => w.mapped);
    if (parked.length === 0 || !parked.every((w) => w.confirmed)) return;
    const active = await x.activeWindow();
    if (!active || !ours.has(active)) return;
    const [here, prevDesk] = [await x.currentDesktop(), await x.getDesktop(prev)];
    // -1 = sticky ("all workspaces"); fine to activate from anywhere.
    if (here == null || prevDesk == null || (prevDesk !== here && prevDesk !== -1)) return;
    await x.activate(prev);
    focusRestored = true;
  }

  const done = (async (): Promise<PlacementReport> => {
    while (!stopped && Date.now() - t0 < timeoutMs && x.alive(pid)) {
      try {
        await tick();
      } catch {
        /* a window vanished mid-query; the next tick sees the new state */
      }
      if (stopped) break;
      await sleep(Date.now() - t0 < FAST_PHASE_MS ? FAST_POLL_MS : SLOW_POLL_MS);
    }
    o.signal?.removeEventListener?.("abort", stop);
    const windows: PlacedWindow[] = [...seen.values()]
      .filter((w) => w.mapped)
      .map((w) => ({ id: w.id, desktop: w.desktop }));
    const report: PlacementReport = {
      // `ws` is still -1 only if the process died before the first tick; report
      // the caller's number then (or 0 for an unresolved "last").
      workspace: ws < 0 ? (typeof o.workspace === "number" ? o.workspace : 0) : ws,
      status: windows.length === 0 ? "none-found" : windows.every((w) => w.desktop === ws) ? "placed" : "partial",
      windows,
    };
    if (report.status === "partial") {
      warn(o, {
        code: "placement-ignored",
        detail: `the window manager left ${windows.filter((w) => w.desktop !== ws).length} window(s) off workspace ${ws}`,
      });
    }
    return report;
  })();

  return { done, stop };
}

/** A throwing onWarning is the caller's bug, never a failed run. */
export function warn(o: { onWarning?: (w: RunnerWarning) => void }, w: RunnerWarning): void {
  try {
    o.onWarning?.(w);
  } catch {
    /* ignore */
  }
}
