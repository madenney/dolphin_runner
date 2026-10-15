/**
 * Hiding a RECORDING Dolphin so it never shows a window, steals focus, or
 * spams the taskbar/Dock — on every OS, with dumps as correct and as fast as a
 * visible run (frame dumps come from an off-screen FBO, so window state does
 * not change them; measured on Linux, docs/background-and-mute.md).
 *
 * `hide` is ONE option the consumer sets on both `buildProfile` (the ini half)
 * and `record()` (the runtime half). It resolves to a per-OS plan here, and
 * `record()` reports what it actually achieved on `RecordResult.hide` the way
 * placement reports its status and warnings.
 *
 * What each OS does, and what is VERIFIED:
 * - **Linux (verified here, X11/GNOME):** park the Dolphin's windows by pid on
 *   a hidden workspace (the existing placement, defaulting to `"last"` so
 *   GNOME's dynamic workspaces always have a target). Under sway/Hyprland the
 *   window is an XWayland client with no EWMH workspace count, so it is moved
 *   by pid through the compositor's own IPC instead. See `planHide`.
 * - **Windows (UNVERIFIED — needs the Windows rig):** force a single hidden
 *   main window — `RenderToMain=True`, `Fullscreen=False`, a small
 *   `MainWindow*`, `DisableScreenSaver=False`, `GFXBackend=DX11` — and spawn
 *   with `windowsHide: true` so the first `ShowWindow` is `SW_HIDE`. No window,
 *   no taskbar button. Optional native QoS opt-out and a foreground lock
 *   (win-native.ts). `hide: "desktop"` adds the separate-desktop launcher
 *   (native/win/, experimental). The graceful stop stays `taskkill /T` (WM_CLOSE).
 * - **macOS (UNVERIFIED — needs a Mac):** run an accessory copy of the Playback
 *   app (LSUIElement, own bundle id, ad-hoc re-signed), force OGL, and hide the
 *   process by pid (mac-hide.ts). Falls back to the original app + hide helper.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NativeHideResult } from "./win-native.ts";
import type { PlacementReport, RunnerWarning } from "./types.ts";

/**
 * How hard to hide a recording Dolphin.
 * - `true` / `"window"`: the default per-OS hiding described above.
 * - `"desktop"`: Windows only — the separate-desktop launcher (experimental).
 *   On any other OS it means `"window"` with a `hide-desktop-fallback` warning.
 * - `false` / omitted: today's behaviour (visible window; `placement` still
 *   applies if given).
 */
export type HideTarget = boolean | "window" | "desktop";

/** A Linux desktop session, as far as it changes how we hide a window. */
export interface SessionInfo {
  /** The display server the X11 client lands on. */
  server: "x11" | "xwayland" | "wayland" | "unknown";
  /** The compositor / DE, lower-cased from `XDG_CURRENT_DESKTOP`. */
  compositor: "gnome" | "kde" | "sway" | "hyprland" | "wlroots" | "other" | "unknown";
}

/**
 * The resolved per-OS plan. Describes what to DO; the doing (spawn flag,
 * placement, compositor IPC, native calls) happens in run.ts, which also turns
 * this plus the results into a `HideReport`.
 */
export interface HidePlan {
  target: HideTarget;
  platform: NodeJS.Platform;
  /** The human-named method, for the report. */
  method:
    | "linux-parking"
    | "linux-compositor"
    | "windows-hidden-window"
    | "windows-desktop"
    | "mac-accessory"
    | "none";
  /** Pass `windowsHide: true` to `spawn` (Windows only). */
  spawnHidden: boolean;
  /** Linux: park the windows via EWMH on this workspace (`"last"` = trailing). */
  parkWorkspace: number | "last" | null;
  /** Linux: move by pid through a compositor IPC instead of EWMH. */
  compositorMove: "sway" | "hyprland" | null;
  /** Windows: also try the native QoS/foreground-lock opt-out (win-native.ts). */
  wantNative: boolean;
  /** Windows: use the separate-desktop launcher (experimental). */
  useDesktopLauncher: boolean;
  /** macOS: prepare and spawn the accessory recorder app, then hide by pid. */
  macAccessory: boolean;
  /** Warnings to surface immediately (unsupported session, desktop fallback). */
  warnings: RunnerWarning[];
  /**
   * False on Windows and macOS: the recipe is written from source and docs but
   * has not been run on that OS. The report carries this through so a consumer
   * knows not to trust "hidden" as proven there.
   */
  verified: boolean;
}

/** `false`/omitted → null; otherwise the requested target. */
export function normalizeHide(hide: HideTarget | undefined): Exclude<HideTarget, false> | null {
  if (hide == null || hide === false) return null;
  return hide === true ? "window" : hide;
}

/** One ini directive for Dolphin.ini. */
export interface IniDirective {
  section: string;
  key: string;
  value: string;
}

/**
 * The Dolphin.ini overrides `hide` writes in RECORD mode, per OS. Pure, so the
 * per-OS selection is unit-tested without a Dolphin. `hasGfxBackend` is true
 * when the caller set `gfxBackend` explicitly — then we never override it.
 *
 * Linux needs none (record mode already forces `PauseOnFocusLost=False` and
 * `ConfirmStop=False`, and the window is parked, not reshaped). The Windows set
 * is the research's ship-first recipe; the macOS one only forces OGL (occluded
 * Vulkan/MoltenVK stalls to ~1 FPS — the accessory app does the hiding).
 */
export function hideDolphinIniDirectives(
  platform: NodeJS.Platform,
  opts: { hasGfxBackend?: boolean } = {},
): IniDirective[] {
  if (platform === "win32") {
    const d: IniDirective[] = [
      // One window, and the one SW_HIDE covers. With RenderToMain=False a
      // second render frame is a second ShowWindow that appears normally.
      { section: "Display", key: "RenderToMain", value: "True" },
      // Fullscreen would force-show and resize the frame.
      { section: "Display", key: "Fullscreen", value: "False" },
      // Default True keeps the user's monitor awake for a hidden batch.
      { section: "Display", key: "DisableScreenSaver", value: "False" },
      // Under RenderToMain the backbuffer size is MainWindow*, not
      // RenderWindow*. Keep it small (low VRAM); IR dumps ignore it.
      { section: "Interface", key: "MainWindowWidth", value: "640" },
      { section: "Interface", key: "MainWindowHeight", value: "360" },
      { section: "Interface", key: "MainWindowPosX", value: "0" },
      { section: "Interface", key: "MainWindowPosY", value: "0" },
    ];
    // A blank GFXBackend resolves to DX11 on Windows anyway, but a profile left
    // on OGL/Vulkan would stay — pin DX11, the most robust off-screen backend
    // (its blt-model Present is ignored when occluded; the dump is from its own
    // texture). Only when the caller didn't choose a backend.
    if (!opts.hasGfxBackend) d.push({ section: "Core", key: "GFXBackend", value: "DX11" });
    return d;
  }
  if (platform === "darwin") {
    // Occluded Vulkan/MoltenVK drops to ~1 FPS; OpenGL does not, and dumps from
    // the FBO regardless. Only when the caller didn't choose a backend.
    return opts.hasGfxBackend ? [] : [{ section: "Core", key: "GFXBackend", value: "OGL" }];
  }
  return [];
}

/**
 * Detect the Linux session from the environment. Pure (env is passed in), so
 * the dispatch is testable. `server` is how the X11 Dolphin actually lands:
 * Ishiiruka Playback is GLX-only and its AppImage forces `GDK_BACKEND=x11`, so
 * on a Wayland session it is an XWayland client on `$DISPLAY`.
 */
export function detectSession(env: NodeJS.ProcessEnv = process.env): SessionInfo {
  const type = (env.XDG_SESSION_TYPE || "").toLowerCase();
  const onWayland = type === "wayland" || !!env.WAYLAND_DISPLAY;
  const server: SessionInfo["server"] = onWayland ? "xwayland" : type === "x11" ? "x11" : env.DISPLAY ? "x11" : "unknown";
  const desk = (env.XDG_CURRENT_DESKTOP || env.XDG_SESSION_DESKTOP || "").toLowerCase();
  let compositor: SessionInfo["compositor"] = "unknown";
  if (/gnome/.test(desk)) compositor = "gnome";
  else if (/kde|plasma/.test(desk)) compositor = "kde";
  else if (/sway/.test(desk) || env.SWAYSOCK) compositor = "sway";
  else if (/hyprland/.test(desk) || env.HYPRLAND_INSTANCE_SIGNATURE) compositor = "hyprland";
  else if (/wlroots|river|wayfire/.test(desk)) compositor = "wlroots";
  else if (desk) compositor = "other";
  return { server, compositor };
}

/**
 * Resolve the per-OS plan. `env` is only read for the Linux session; Windows
 * and macOS ignore it. Never throws — an unsupported session yields a plan that
 * does what it can and carries a warning.
 */
export function planHide(
  hide: HideTarget | undefined,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): HidePlan | null {
  const target = normalizeHide(hide);
  if (!target) return null;
  const base = {
    target,
    platform,
    spawnHidden: false,
    parkWorkspace: null as number | "last" | null,
    compositorMove: null as "sway" | "hyprland" | null,
    wantNative: false,
    useDesktopLauncher: false,
    macAccessory: false,
    warnings: [] as RunnerWarning[],
  };

  if (platform === "win32") {
    return {
      ...base,
      method: target === "desktop" ? "windows-desktop" : "windows-hidden-window",
      spawnHidden: true,
      // The desktop launcher sets HighQoS on Dolphin itself, and a Dolphin on
      // another desktop cannot take the foreground: no koffi calls needed.
      wantNative: target !== "desktop",
      useDesktopLauncher: target === "desktop",
      verified: false,
    };
  }

  if (platform === "darwin") {
    const warnings = target === "desktop" ? [desktopFallbackWarning(platform)] : [];
    return { ...base, method: "mac-accessory", macAccessory: true, warnings, verified: false };
  }

  if (platform === "linux") {
    const warnings = target === "desktop" ? [desktopFallbackWarning(platform)] : [];
    const session = detectSession(env);
    if (session.compositor === "sway" || session.compositor === "hyprland") {
      return { ...base, method: "linux-compositor", compositorMove: session.compositor, warnings, verified: true };
    }
    // GNOME/KDE on X11 or XWayland publish EWMH on the (X)Wayland root, so the
    // pid-scoped EWMH parker works. wlroots/other without a known IPC can't be
    // parked by us; say so honestly rather than pretend.
    if (session.compositor === "wlroots" || (session.server === "wayland" && session.compositor !== "gnome" && session.compositor !== "kde")) {
      warnings.push({
        code: "hide-session-unsupported",
        detail: `no supported way to hide a window on ${session.compositor}/${session.server}; the recording runs visible`,
      });
      return { ...base, method: "none", warnings, verified: true };
    }
    return { ...base, method: "linux-parking", parkWorkspace: "last", warnings, verified: true };
  }

  return {
    ...base,
    method: "none",
    warnings: [{ code: "hide-unsupported", detail: `hide is not supported on ${platform}` }],
    verified: false,
  };
}

function desktopFallbackWarning(platform: NodeJS.Platform): RunnerWarning {
  return {
    code: "hide-desktop-fallback",
    detail: `hide: "desktop" is Windows-only; using the default window hiding on ${platform}`,
  };
}

/**
 * The argv to move one pid's window out of sight through a wlroots compositor's
 * IPC. Pure, for tests. Both act by pid (the rule: never by title).
 * - sway: `swaymsg '[pid=N] move scratchpad'` — the scratchpad is shown nowhere.
 * - Hyprland: `hyprctl dispatch movetoworkspacesilent special:lunar,pid:N`
 *   — a hidden special workspace; "silent" keeps focus where it is.
 */
export function compositorMoveArgs(kind: "sway" | "hyprland", pid: number): { cmd: string; args: string[] } {
  if (kind === "sway") return { cmd: "swaymsg", args: [`[pid=${pid}] move scratchpad`] };
  return { cmd: "hyprctl", args: ["dispatch", "movetoworkspacesilent", `special:lunar,pid:${pid}`] };
}

/** What `record()` reports about hiding, on `RecordResult.hide`. */
export interface HideReport {
  /** What the caller asked for. */
  requested: HideTarget;
  platform: NodeJS.Platform;
  method: HidePlan["method"];
  /** False on Windows/macOS: the recipe is unverified on that OS (see HidePlan). */
  verified: boolean;
  /** `windowsHide` was passed to spawn. */
  spawnHidden: boolean;
  /** Dolphin.ini hide overrides were written by buildProfile. Null = not known here. */
  profileApplied: boolean | null;
  /** Linux EWMH parking outcome, if that was the method. */
  parking: PlacementReport | null;
  /** Linux compositor move: which pids were moved, if that was the method. */
  compositor: { kind: "sway" | "hyprland"; movedPids: number[] } | null;
  /** Windows native QoS/foreground-lock result, if attempted. */
  native: NativeHideResult | null;
  /** macOS accessory-app + hide-by-pid result, if attempted. */
  mac: { bundle: string | null; hiddenByPid: boolean | null } | null;
  /**
   * Windows `hide: "desktop"`: the launcher spawned and the desktop it was told
   * to create. `launcher: null` means none was found and the run fell back to
   * the hidden window (`method` then reads `windows-hidden-window`).
   */
  desktop: { launcher: string | null; name: string | null } | null;
  warnings: RunnerWarning[];
}

/** The launcher's file name, as shipped in `native/win/bin/`. */
export const HIDE_LAUNCHER_EXE = "lunar-hidden-launcher.exe";

/** Where this package keeps its prebuilt launcher (`<pkg>/native/win/bin/`). */
export function bundledHideLauncher(): string {
  // src/hide.ts and dist/hide.js are both one level below the package root.
  return fileURLToPath(new URL(`../native/win/bin/${HIDE_LAUNCHER_EXE}`, import.meta.url));
}

/**
 * The launcher `hide: "desktop"` spawns through, or null when there is none:
 * the explicit option, then `DOLPHIN_RUNNER_HIDE_LAUNCHER`, then the bundled
 * copy. Pure apart from `exists` (injectable for tests).
 */
export function resolveHideLauncher(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
  bundled: string = bundledHideLauncher(),
): string | null {
  for (const p of [explicit, env.DOLPHIN_RUNNER_HIDE_LAUNCHER, bundled]) {
    if (p && exists(p)) return p;
  }
  return null;
}

let desktopSeq = 0;
/** A desktop name unique to this process and run: `LunarRec-<pid>-<n>`. */
export function nextHideDesktopName(pid: number = process.pid): string {
  desktopSeq += 1;
  return `LunarRec-${pid}-${desktopSeq}`;
}
