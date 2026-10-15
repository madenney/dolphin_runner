import type { Rect } from "./place.ts";
import type { HideReport, HideTarget } from "./hide.ts";

export type { HideTarget, HideReport, HidePlan, SessionInfo } from "./hide.ts";

/** Where the two binaries this package drives actually live. */
export interface DolphinPaths {
  /** The Slippi PLAYBACK build — NOT the netplay build. Different binary. */
  dolphinPath: string;
  /** The Melee ISO. Playback Dolphin cannot render a replay without it. */
  isoPath: string;
}

/** The three ini files a real Dolphin profile keeps, resolved per-OS. */
export interface RealProfile {
  /** The profile root (`--user` points at a COPY of this, never at this). */
  root: string;
  configDir: string;
  gfxIni: string;
  dolphinIni: string;
  gameSettingsIni: string;
}

export type ProfileMode = "record" | "play";

export type DumpCodec = "ffv1" | "utvideo" | "mpeg4" | "default";

/**
 * A texture pack. A bare string uses the folder's own name as the destination,
 * which collides when two packs are both called e.g. `GALE01` — give them
 * explicit `name`s, or let the builder disambiguate.
 */
export type TexturePack = string | { path: string; name?: string };

export type RenderWindow =
  | { fullscreen: true }
  | { fullscreen?: false; width: number; height: number; x?: number; y?: number };

export interface ProfileOptions {
  mode: ProfileMode;
  /**
   * `[Settings] EFBScale` — an ENUM, not a multiplier (Ishiiruka `VideoConfig.h`):
   * 0 = auto, 1 = auto-integral (window-sized — huge dumps), 2 = 1x native
   * (939x528 dump at 16:9), 3 = 1.5x, 4 = 2x, 5 = 2.5x, 6 = 3x, 7 = 4x, 8 = 5x.
   * Omit to keep whatever the source profile says (see gotcha 17).
   */
  efbScale?: number;
  /** 6 = Force16:9 (widescreen), 5 = Force4:3. Omit to keep the source value. */
  aspectRatio?: 5 | 6;
  /**
   * Dump bitrate in kbps. Omit to keep the source value. Record mode only.
   * Only the mpeg4 codec reads it, and mpeg4 stops improving at ~141 Mb/s at
   * EFB 6 and ~37 Mb/s at native (qmin ceiling) — more is just bigger files.
   */
  bitrateKbps?: number;
  /**
   * The frame-dump codec. Record mode only. Omit to keep the source profile's
   * (`UseFFV1` / `DumpCodec`), which is today's behaviour.
   *
   * Dolphin encodes on ONE thread and that thread is the recording speed limit
   * (measured 2026-10-08, RTX 5080, docs/background-and-mute.md):
   * - "ffv1": lossless. 0.77x realtime at native, 0.10x at EFB 6.
   * - "utvideo": lossless (bit-exact to ffv1 after 4:2:0). 0.81x at EFB 6, but
   *   ~12 GB per 75 s game there. Needs an EVEN dump width — fails at native
   *   (939 wide), so it is refused for efbScale 2.
   * - "mpeg4": lossy, `bitrateKbps` applies. Fast at native (3.6x with
   *   emulationSpeed 0) but visible blocking at 60 Mb/s at EFB 6.
   *
   * **mpeg4's speed advantage is a native/low-resolution thing.** At EFB 3
   * (1408x792) utvideo and mpeg4 both top out at ~1.27x with emulationSpeed 0
   * — past that the limit is EMULATION, not the encoder, so lossy buys
   * nothing over lossless. ffv1 stays encoder-bound there at 0.50x either way.
   * - "default": force `UseFFV1 = False` and leave `DumpCodec` EMPTY, so
   *   Dolphin picks the container's default. The only way to reproduce a
   *   profile that never had a `DumpCodec` line — without it, a consumer
   *   byte-comparing old against new has to blank the key by hand.
   * Never "h264": it drops the last ~50 frames (lookahead unflushed at SIGTERM).
   */
  dumpCodec?: DumpCodec;
  /**
   * `[Settings] DumpFormat`, the dump CONTAINER. Record mode pins `"avi"`
   * unless you say otherwise, because `record()` asserts a `<base>.avi` and a
   * source profile left on something else fails only after a full-length run.
   */
  dumpFormat?: string;
  /** `[Settings] DumpFramesAsImages`. Record mode pins it off for the same reason. */
  dumpFramesAsImages?: boolean;
  /**
   * HD texture packs to make available: each is linked into
   * `<userDir>/Load/Textures/<gameSettingsId>/<name>` and turns
   * `HiresTextures` on. `name` defaults to the folder's basename; two packs
   * whose folders share a name (`GALE01` is common) would otherwise replace
   * each other, so a clash is disambiguated with a `-2` suffix. Pass
   * `{ path, name }` to control it. Symlinked by default — a pack is hundreds
   * of MB and a per-clip copy fills the disk.
   */
  texturePacks?: TexturePack[];
  /** `"symlink"` (default) or `"copy"`, for a host with no symlink privilege. */
  texturePackMode?: "symlink" | "copy";
  /** `[Settings] HiresTextures`. Implied by `texturePacks`; set false to force off. */
  hiresTextures?: boolean;
  /**
   * `[Settings] CacheHiresTextures`. Off is usually right for batch recording:
   * prefetching a multi-hundred-MB pack per clip costs more than lazy loading.
   */
  cacheHiresTextures?: boolean;
  /**
   * Copy `GC/SRAM.raw` from the source profile — the memory card holding the
   * console's language and sound settings. Record mode does it by default;
   * without it a throwaway profile boots with different settings than the
   * operator's real one.
   */
  sram?: boolean;
  /**
   * Profile-root-relative paths to copy verbatim instead of the default
   * (`GC/SRAM.raw`). For assets `buildProfile` knows nothing about. Missing
   * files are skipped, never fatal.
   */
  copyFromProfile?: string[];
  /**
   * RAW `GALE01.ini` text, written verbatim into the throwaway profile.
   *
   * Deliberately raw rather than a toggle API: the VOD recorder's profile carries a
   * hand-assembled gecko code (`$Center Align 2P HUD`, with its hex payload)
   * that no generator here would know about, and a "gecko options" surface
   * would silently drop it. Consumers own their codes; we only place them.
   */
  geckoIni?: string;
  /** Override the auto-resolved real profile to copy from. */
  sourceProfile?: RealProfile;
  /**
   * Start from EMPTY inis instead of copying the real profile: only the keys
   * set here exist, everything else is Dolphin's default. This is what the stream tool's
   * in-process launch always did (its per-setup dir never saw the real
   * profile), so a feed launched this way looks exactly like a legacy one and
   * no setting in the operator's own Playback profile can leak onto stream.
   */
  freshProfile?: boolean;
  /**
   * The GameSettings file name the gecko ini is written as (`<id>.ini`).
   * Default "GALE01" (applies to every revision); the stream tool historically writes
   * "GALE01r2" (NTSC 1.02).
   */
  gameSettingsId?: string;

  // --- Tuning for a live/captured window. All optional; omit = keep the copy's value.

  /**
   * `[Core] GFXBackend`. MUST be "OGL" for obs-vkcapture's GL path: its
   * LD_PRELOAD hooks glXSwapBuffers, so a Vulkan Dolphin makes no GL swaps and
   * OBS captures BLACK. A blank value resolves to OGL on Linux (measured
   * 2026-10-08); set it anyway so a profile left on Vulkan can't win. These
   * are the only two on Linux — Playback has no software or null renderer.
   *
   * On Windows the Direct3D names are valid too (`"DX11"`, `"D3D12"`, `"DX9"`,
   * the exact `GetName()` strings); `hide` pins `"DX11"` there unless you set
   * one. A blank value resolves to DX11 on Windows, OGL on Linux.
   */
  gfxBackend?: "OGL" | "Vulkan" | "DX11" | "D3D12" | "DX9";
  /**
   * Hide a RECORDING Dolphin: no window, no focus steal, no taskbar/Dock, with
   * the dump as correct and fast as a visible run. Per-OS; see `HideTarget` and
   * `record()`'s `hide` (set the SAME value on both — this writes the ini half,
   * `record()` does the runtime half and reports the result). Record mode only.
   */
  hide?: HideTarget;
  /**
   * Override the platform `hide`'s ini is written for. Defaults to
   * `process.platform`; exists so the per-OS ini selection is testable and so a
   * cross-build tool can target another OS.
   */
  platform?: NodeJS.Platform;
  /**
   * `[Core] Latency` — audio buffer headroom in ms. MUST NOT be 0 for a live
   * feed: a cold launch stalls audio during ISO load + shader compile, the
   * Pulse backend underflows and never recovers, and the feed is silent for
   * the rest of the session. The stream tool measured 60 as the value that survives
   * launching several Dolphins at once.
   */
  audioLatencyMs?: number;
  /** `[Core] EmulationSpeed`. 1 = real time, 0 = unlimited. */
  emulationSpeed?: number;
  /**
   * `[DSP] Backend`. "Pulse" is the one that honours PULSE_SINK for routing;
   * "ALSA" ignores PULSE_SINK (PIPEWIRE_NODE does route it). Must be one of
   * `AUDIO_BACKENDS` — Dolphin silently falls back to NO AUDIO on any string it
   * doesn't know, so a typo would mute with no warning; we throw instead.
   */
  audioBackend?: AudioBackend;
  /**
   * Mute Dolphin: `[DSP] Backend = "No audio output"`. The audio DUMP is
   * unaffected — it is written from the mixer before any backend (measured:
   * WAV bit-identical to ALSA/Pulse runs) — so this is the mute for RECORDING.
   * Never for an OBS mirror: OBS hears nothing. Conflicts with `audioBackend`.
   */
  silent?: boolean;
  /**
   * `[DSP] Volume`, 0–100. Slippi ships 25. Does NOTHING on Linux: the Pulse
   * and ALSA backends never implement SetVolume (measured: same RMS at 0 and
   * 100), and it never affects the dump. To mute, use `silent` (recording) or
   * route a mirror to its own sink.
   */
  volume?: number;
  /**
   * `[Interface] PauseOnFocusLost`. A hidden or parked Dolphin loses focus by
   * design, and with True it pauses: measured, a recording that lost focus
   * after boot never emitted a frame and died to the watchdog. Record mode
   * FORCES False unless you set it; play mode keeps the copy's value.
   */
  pauseOnFocusLost?: boolean;
  /** `[Display] KeepWindowOnTop`. False for anything meant to stay out of the way. */
  keepWindowOnTop?: boolean;
  /**
   * Write a Hotkeys.ini bound to no device, so a Dolphin that steals focus at
   * launch (it always raises itself) can't receive the operator's keystrokes.
   * Record mode always does this; for play mode it is opt-in.
   */
  detachHotkeys?: boolean;
  /**
   * The render window. `{ fullscreen: true }` takes the display's resolution.
   * A fixed size sets `Fullscreen=False`, `RenderWindowAutoSize=False` and
   * the geometry — but size + WM decorations MUST FIT the work area of the
   * output-tied RandR monitor: Dolphin itself (not the WM — reproduced with no
   * WM, 2026-10-08) resets anything larger to 640x480, and clamps off-screen
   * positions back on. 1920x1080 windowed on a decorated 1080p GNOME display
   * became 640x480; 1280x720 landed but captured 1280x683. On a decorated 1080p
   * desktop fullscreen is the only 1:1 option; on a larger screen, undecorated
   * 1080p tiles keep their exact geometry.
   */
  window?: RenderWindow;
  /**
   * `[Settings] MSAA` sample count (1 = off, 2, 4, 8; anything else = 1).
   * Setting it also forces `SSAA = False` (supersampling is far heavier).
   * Omit to keep the copy's value.
   */
  msaa?: number;
  /** `[Hardware] VSync`. False for a mirror — never gate on the display. */
  vsync?: boolean;
  /** `[Settings] ShaderCompilationMode`. 0 = specialized/synchronous-on-demand. */
  shaderCompilationMode?: 0 | 1 | 2 | 3;
  /**
   * Link `<userDir>/Cache` here (a symlink; a directory junction on Windows,
   * since 0.5.7) so shaders compiled once persist across
   * throwaway dirs and reboots. PER INSTANCE, never shared: two Dolphins
   * writing one cache corrupt it, shaders never stick, and every launch is a
   * cold (audio-stalling) recompile. Best-effort; a failure never fails the build.
   */
  shaderCacheDir?: string;
}

/** Every `[DSP] Backend` value Ishiiruka knows (ConfigManager.h). */
export type AudioBackend =
  | "No audio output"
  | "ALSA"
  | "Pulse"
  | "Cubeb"
  | "OpenAL"
  | "AOSound"
  | "CoreAudio"
  | "Exclusive WASAPI"
  | "Shared-mode WASAPI"
  | "DSound"
  | "XAudio2"
  | "OpenSLES";

/**
 * Something the runner chose not to do, or couldn't, that did NOT fail the run.
 * Delivered through `onWarning`; the CLI prints it as `{"event":"warning"}`.
 */
export interface RunnerWarning {
  code:
    | "placement-unsupported" // not Linux, no DISPLAY, tools missing, bad workspace number
    | "placement-no-wm" // no EWMH window manager (Xvfb): nothing to park
    | "placement-no-workspace" // that workspace doesn't exist on this display
    | "placement-ignored" // the WM left some window elsewhere after retries
    | "placement-no-monitor" // `monitor` named an output that isn't connected
    | "hide-unsupported" // hide asked for on an OS with no implementation
    | "hide-desktop-fallback" // hide: "desktop" asked for off Windows
    | "hide-session-unsupported" // a Wayland compositor we can't hide a window on (wlroots, etc.)
    | "hide-native-unavailable" // Windows: koffi not installed, so QoS/foreground-lock skipped
    | "hide-failed"; // a hide step threw; the recording still ran
  detail: string;
}

/** Park a Dolphin's windows on another workspace. See `placeWindows` (place.ts). */
export interface PlacementOptions {
  /**
   * EWMH workspace, 0-BASED (GNOME's "Workspace 10" is 9). Never created — must
   * exist. `"last"` is the trailing workspace (`desktops - 1`), the right target
   * for GNOME's DYNAMIC workspaces, where a fixed number may not exist yet and
   * mutter keeps one empty workspace at the end.
   */
  workspace: number | "last";
  /**
   * Resize the window after the WM takes it, via EWMH `_NET_MOVERESIZE_WINDOW`.
   *
   * This is the way to get a surface BIGGER than Dolphin will open on its own:
   * `ProfileOptions.window` only writes the ini, and Dolphin clamps anything
   * that doesn't fit the work area back to 640x480 (its own clamp, not the
   * WM's). Moving it afterwards goes around that. `x`/`y` default to the
   * chosen `monitor`'s origin, or 0,0.
   */
  geometry?: { x?: number; y?: number; width: number; height: number };
  /**
   * Strip window decorations (`_MOTIF_WM_HINTS`). A titlebar eats ~37px off
   * the top and a capture then grabs the SHORTER client surface — a 1920x1080
   * window captured as 1920x1043, which no longer fills a 1080p canvas.
   */
  undecorate?: boolean;
  /**
   * Which monitor to place on: an output name (`"DP-2"`), or `"landscape"` for
   * the largest non-rotated one. Without `geometry` the window fills it.
   * `"landscape"` exists for a rig whose primary is a rotated portrait panel,
   * where a fullscreen feed comes out squished.
   */
  monitor?: string;
  /** X display; defaults to the run's `display`, then DISPLAY. */
  display?: string;
  /** How long to keep watching for windows. Default 20 s. */
  timeoutMs?: number;
  /**
   * Default true. A parked Dolphin keeps keyboard focus (it raises itself at
   * launch), so typing goes to a window you can't see. Once parked, focus is
   * handed back to the window that had it before the launch — only if that
   * window is on your current workspace, so it never switches workspaces.
   */
  restoreFocus?: boolean;
  /**
   * Default false: if placement can't work here (no X tools, no WM, not
   * Linux) the run goes ahead with the window where Dolphin puts it, and
   * `onWarning` says why. True refuses to spawn instead.
   */
  required?: boolean;
  signal?: AbortSignal;
  onWarning?: (w: RunnerWarning) => void;
}

export interface PlacedWindow {
  /** X window id as xdotool prints it (decimal). */
  id: string;
  /** Its workspace when placement finished, null if the WM didn't say. */
  desktop: number | null;
}

export interface PlacementReport {
  workspace: number;
  /** The rect placement asked the WM for, if any. */
  geometry?: Rect | null;
  /**
   * "placed": every mapped window is on `workspace`. "partial": some aren't
   * (also warned). "none-found": no window mapped before the timeout or exit.
   * "skipped": placement couldn't run here (see the warning).
   */
  status: "placed" | "partial" | "none-found" | "skipped";
  windows: PlacedWindow[];
}

export interface StallDiagnostic {
  replay: string;
  /**
   * Which rule fired. `"boot-stall"` and `"frame-stall"` are silences (the
   * process was SIGKILLed); `"hard-timeout"` is a Dolphin that kept printing
   * frames past its wall-clock cap and was SIGTERMed so the dump finalises.
   *
   * `"early-exit"` (0.5.7) is not the watchdog: Dolphin exited ON ITS OWN
   * before printing a single frame — a crash or refusal at startup (bad ISO,
   * no GL context, an AppImage without FUSE, a missing library). `stalled`
   * stays false; `exitCode`/`exitSignal` and the tails say what happened.
   * Before 0.5.7 that case resolved with `diagnostic: null`, like success.
   */
  reason: "boot-stall" | "frame-stall" | "hard-timeout" | "early-exit";
  /** How Dolphin exited. Set for `"early-exit"`; absent for the watchdog reasons (see the result's `exitCode`). */
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  /** Seconds without a `[CURRENT_FRAME]` when the watchdog fired. */
  silentForSec: number;
  /** True if it never emitted a single frame — a hung boot, not a freeze. */
  hungOnBoot: boolean;
  /** The end frame Dolphin reported, or null if it never said. */
  endFrame: number | null;
  /** Bytes Dolphin wrote to stderr in total (not the tail's length). */
  stderrBytes: number;
  /** Last lines of each stream, frame spam excluded. */
  stdoutTail: string[];
  stderrTail: string[];
}

export interface RunOptions {
  /**
   * This instance's throwaway `--user` profile. MANDATORY, not optional.
   *
   * The dump path is a property of the user dir, not of the invocation:
   * `Dump/Frames/` is where Dolphin writes regardless of `--output-directory`,
   * so two Dolphins sharing one user dir overwrite each other's frames. The
   * failure is SILENT and looks like footage from the wrong replay.
   */
  userDir: string;
  signal?: AbortSignal;
  /**
   * DISPLAY for the GL context. A frame dump needs a live one. The package
   * never manages X — pass what you want, or inherit the environment.
   */
  display?: string;
  /**
   * Called for every frame Dolphin reports, once the end frame is known.
   *
   * Return `"stop"` to end the dump HERE and keep the footage: Dolphin is
   * SIGTERMed (so the `.avi` index is written) and `record()` resolves with
   * `stoppedEarly: true`. That is for a caller who wants N frames around some
   * moment rather than a whole game. Do not use an AbortSignal for that — an
   * abort SIGKILLs and rejects, which loses both the index and the result.
   */
  onFrame?: (current: number, end: number) => void | "stop";
  /**
   * Called once with the spawned Dolphin's pid. The AppImage execs, so this is
   * the root of the tree that owns the window (its descendants: `pidTree`).
   * Lets a caller park the window without `pgrep -f <userDir>`.
   */
  onSpawn?: (pid: number) => void;
  /** No first frame within this long = hung boot. Covers Dolphin boot + ISO load. */
  bootStallMs?: number;
  /** Frames stopped for this long mid-record = frozen. */
  frameStallMs?: number;
  /**
   * Absolute wall-clock cap on the whole run. Off by default.
   *
   * The stall windows only catch SILENCE — a Dolphin that keeps printing
   * frames but never reaches the end never trips them, which is why two
   * consumers each bolted their own timer on. When this fires the run is
   * SIGTERMed (so the `.avi` finalises) and `record()` RESOLVES with
   * `stalled: true` and `diagnostic.reason === "hard-timeout"`. It is not an
   * abort: the footage so far is real, and your duration guard should judge it.
   */
  hardTimeoutMs?: number;
  /**
   * Extra environment for the Dolphin process, on top of ours. `display`,
   * `audioSink` and `appName` are applied after it and win.
   */
  env?: Record<string, string>;
  /**
   * Route this Dolphin's live audio to a sink by name: sets PULSE_SINK (Pulse
   * backend) and PIPEWIRE_NODE (ALSA via pipewire's ALSA plugin, which ignores
   * PULSE_SINK). For keeping a recording's live audio off the speakers while
   * still hearing it somewhere; `silent` is the simpler mute. Linux only.
   */
  audioSink?: string;
  /**
   * Park this Dolphin's windows on another workspace (Linux/X11), found BY PID
   * — never by title. Omit to leave them where Dolphin puts them (today's
   * behaviour). See PlacementOptions; `display` defaults to this run's.
   */
  placement?: Omit<PlacementOptions, "display" | "signal" | "onWarning"> & { display?: string };
  /**
   * Hide this recording Dolphin: no window on screen, no focus steal, no
   * taskbar/Dock, dumps unchanged. Per-OS (see `HideTarget`). Set the SAME
   * value on `buildProfile` so the ini half is written too. The result carries
   * a `HideReport` saying what each OS achieved.
   *
   * On Linux `hide` drives window parking itself (by pid, workspace `"last"` by
   * default, or the compositor's IPC under sway/Hyprland), so you don't also
   * pass `placement`; an explicit `placement` still wins if given.
   */
  hide?: HideTarget;
  /** Non-fatal things the runner skipped or couldn't do (placement, hiding). */
  onWarning?: (w: RunnerWarning) => void;
  /**
   * The audio stream's `application.name` (PULSE_PROP_OVERRIDE; Pulse backend
   * only). Every Dolphin otherwise calls itself "dolphin-emu", and WirePlumber
   * remembers volume, mute and target BY THAT NAME — mute one by hand and every
   * future Dolphin starts muted. A per-instance name scopes all of that.
   */
  appName?: string;
}

export interface RecordOptions extends RunOptions {
  /**
   * Where the comm file is written. Default `<outDir>/comm.json`.
   *
   * Override it whenever several recordings share an `outDir`: the default
   * name is fixed, so two workers would overwrite each other's comm between
   * the write and Dolphin's read, and each would record the other's replay
   * with no error anywhere.
   */
  commPath?: string;
  /**
   * `-b`: Dolphin exits when emulation stops. Default TRUE, and almost always
   * right for a dump. False leaves the window up after the dump finishes —
   * for a consumer whose "fullscreen" toggle meant exactly this.
   */
  batch?: boolean;
  /**
   * The replay's last frame, when you already know it (from a database, say).
   * Skips reading the file. Without it the footer is read, then the raw event
   * stream, then `endFrame` is used — see `record()`.
   */
  lastFrame?: number;
  /** Where Dolphin writes `<baseName>.avi` / `.wav`. */
  outDir: string;
  baseName?: string;
  /** Defaults to -123, the pre-GO! lead-in. Clip callers pass their own. */
  startFrame?: number;
  /** Defaults to the `.slp`'s lastFrame. Must be FINITE — see comm.ts. */
  endFrame?: number;
}

/** A live, OBS-capturable Dolphin. See `obsMirror()`. */
export interface ObsMirrorOptions {
  /** Throwaway `--user` dir. Per instance — see RunOptions.userDir. */
  userDir: string;
  /**
   * The comm file passed as `-i`. The CALLER owns this file after launch:
   * rewriting it with a new replay and a fresh commandId makes Dolphin reload
   * onto the next game by itself. Nothing here watches anything.
   */
  commPath: string;
  /** If given, an initial mirror comm for this replay is written to commPath. */
  replay?: string;
  /**
   * Slippi's `isRealTimeMode`. Default FALSE: true parks the playback Dolphin
   * at the live edge waiting on wall-clock and never advances emulation for
   * the whole game (FPS 0, no DSP, "choppy" feed). The stream tool reproduced this
   * 2026-08-10. false plays frames as the `.slp` grows.
   */
  isRealTimeMode?: boolean;
  display?: string;
  /**
   * OBS_VKCAPTURE_EXE_NAME — what an OBS "Game Capture (vkcapture)" source
   * matches on, e.g. "dolphin-1". Also passed to the exe-override shim.
   */
  captureName: string;
  /**
   * libobs_glcapture.so to LD_PRELOAD. Default is what `obs-gamecapture` uses:
   * `/usr/$LIB/obs_glcapture/libobs_glcapture.so` — ld.so expands `$LIB`.
   */
  glcaptureLib?: string;
  /**
   * A caller-supplied .so prepended to LD_PRELOAD that makes the process
   * report `captureName` as its exe name (readlink override). Without it the
   * source would have to match on "dolphin-emu" and every instance looks alike.
   */
  exeOverrideShim?: string;
  /** PULSE_SINK — per-instance audio sink so OBS can capture each feed alone. */
  pulseSink?: string;
  /**
   * PULSE_LATENCY_MSEC. Default 120. Dolphin's Pulse backend opens a 132-byte
   * buffer and only grows it on underflow; asking for a big one up front is
   * what makes the stream start stable instead of choppy/silent.
   */
  pulseLatencyMs?: number;
  signal?: AbortSignal;
  /**
   * Default true. False launches the same Dolphin WITHOUT the capture hook:
   * OBS_VKCAPTURE=0 and no LD_PRELOAD at all (an inherited one is dropped
   * too). The stream tool's load test uses this to tell capture cost from render cost.
   */
  capture?: boolean;

  // --- Profile. Applied through buildProfile with mode "play".
  /** REQUIRED. Omitting it would inherit the real profile's — see gotcha 17. */
  efbScale: number;
  /**
   * Default `{ fullscreen: true }` — what the stream tool's mirror ships, and the only way
   * to get a 1920x1080 surface on a 1920x1080 display (see RenderWindow).
   */
  window?: RenderWindow;
  /**
   * Default 1 (real time). 0 = unlimited would fast-forward on air whenever the
   * mirror is pointed at a finished or partly-written replay, with crackling
   * Pulse audio. (Before 2026-10-09 the default was 0; the stream tool always passed 1.)
   */
  emulationSpeed?: number;
  /** Default 60. */
  audioLatencyMs?: number;
  shaderCacheDir?: string;
  geckoIni?: string;
  sourceProfile?: RealProfile;
  /** Default "OGL" — the only backend obs-vkcapture's GL hook sees. "Vulkan" relies on the vkcapture layer. */
  gfxBackend?: "OGL" | "Vulkan";
  /** MSAA samples (1 = off). Omit to keep the profile's value. */
  msaa?: number;
  /** See ProfileOptions.freshProfile. */
  freshProfile?: boolean;
  /** See ProfileOptions.gameSettingsId. */
  gameSettingsId?: string;
  /** See ProfileOptions.detachHotkeys. Off by default for parity with the stream tool. */
  detachHotkeys?: boolean;
  /** See RunOptions.appName. Pulse `application.name` for this feed. */
  appName?: string;
  /** Extra environment, applied before the capture variables (which win). */
  env?: Record<string, string>;
  /** See RunOptions.placement. Parked mirrors still capture (measured, fullscreen and windowed). */
  placement?: Omit<PlacementOptions, "display" | "signal" | "onWarning"> & { display?: string };
  /** See RunOptions.onWarning. */
  onWarning?: (w: RunnerWarning) => void;
}

export interface ObsMirrorHandle {
  pid: number;
  /** The env the child was spawned with, for diagnostics. */
  env: Record<string, string>;
  /** Resolves when Dolphin exits, however it exits. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderrTail: string[] }>;
  /** Kill the whole tree (SIGKILL — a mirror has nothing to finalise) and wait. */
  stop(): Promise<void>;
  /** Resolves when window placement finishes; null if none was asked for. */
  placement: Promise<PlacementReport> | null;
}

/**
 * A live playback window: an explicit frame range on screen, no dump.
 *
 * Neither `record()` (batch, dumps, hidden) nor `obsMirror()` (OBS capture
 * env, mirror comm with no frame range) can do this, and it is what a clip
 * PREVIEW is — the operator watching the range they are about to render.
 */
export interface PlayOptions extends RunOptions {
  /** Defaults to -123, the pre-GO! lead-in. */
  startFrame?: number;
  /** Defaults to the `.slp`'s lastFrame. Must be FINITE — see comm.ts. */
  endFrame?: number;
  /** The replay's last frame when you already know it. See `RecordOptions.lastFrame`. */
  lastFrame?: number;
  /** Where the comm file goes. Defaults to `<userDir>/comm.json`. */
  commPath?: string;
  /**
   * `-b`: Dolphin exits when emulation stops. Default TRUE — a preview that
   * outlives its clip leaves a window the operator has to close by hand.
   */
  batch?: boolean;
  /** `--hide-seekbar`. Default false: a human watching a preview usually wants it. */
  hideSeekbar?: boolean;
  /**
   * Slippi's `isRealTimeMode`. Default false. True only makes sense for a
   * replay still being written — on a finished one it parks at the live edge
   * and never advances (see ObsMirrorOptions).
   */
  isRealTimeMode?: boolean;
}

/**
 * How the Dolphin process ended, on every `record()`/`play()` result (0.5.7).
 *
 * A run that reached its end frame was SIGTERMed by us, so `exitSignal` is
 * usually "SIGTERM" (or `exitCode` 0/1 — Dolphin may catch it) on a perfectly
 * good recording: these are for diagnosis, not a verdict. The verdict on an
 * unexpected exit is `diagnostic.reason === "early-exit"`.
 */
export interface ExitInfo {
  /** The exit code, or null when it was killed by a signal. */
  exitCode: number | null;
  /** The signal that ended it ("SIGTERM", "SIGKILL"), or null. Always null on Windows. */
  exitSignal: NodeJS.Signals | null;
  /** The last ~60 non-frame lines Dolphin printed on stdout (frame spam excluded). */
  stdoutTail: string[];
  /** The last ~60 lines of stderr. */
  stderrTail: string[];
}

/**
 * What `record()` rejects with when Dolphin left no `.avi` ("produced no
 * video"). The message starts exactly as it always did, then adds how Dolphin
 * exited and the last few stderr lines; the full tails are properties.
 * Check with `(e as DolphinRunError).code === "no-video"`.
 */
export interface DolphinRunError extends Error, ExitInfo {
  code: "no-video";
  replay: string;
  /** The watchdog's or early-exit's diagnostic, if one was taken. */
  diagnostic: StallDiagnostic | null;
}

export interface PlayResult extends ExitInfo {
  /** The replay's last frame, however it was determined. */
  lastFrame: number;
  /** True if the watchdog fired — including a window the operator left open. */
  stalled: boolean;
  /** True if your own `onFrame` returned `"stop"`. */
  stoppedEarly: boolean;
  diagnostic: StallDiagnostic | null;
  placement: PlacementReport | null;
}

export interface RecordResult extends ExitInfo {
  avi: string;
  wav: string | null;
  /**
   * The `.slp`'s lastFrame, returned so the caller can length-check the dump
   * without re-reading the replay. Expected seconds = (lastFrame + 123) / 60.
   */
  lastFrame: number;
  /** True if the watchdog fired. NOT a verdict — judge the footage. */
  stalled: boolean;
  /** True if your own `onFrame` returned `"stop"`. A clean, deliberate end. */
  stoppedEarly: boolean;
  /**
   * Set when the watchdog fired, or (0.5.7) when Dolphin exited by itself
   * before its first frame (`reason: "early-exit"`). Null on a normal run.
   */
  diagnostic: StallDiagnostic | null;
  /** How window placement went; null if none was asked for. */
  placement: PlacementReport | null;
  /** How hiding went (`hide` on record()), per OS; null if none was asked for. */
  hide: HideReport | null;
}
