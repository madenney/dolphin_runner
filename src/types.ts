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

export type DumpCodec = "ffv1" | "utvideo" | "mpeg4";

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
   * Never "h264": it drops the last ~50 frames (lookahead unflushed at SIGTERM).
   */
  dumpCodec?: DumpCodec;
  /**
   * RAW `GALE01.ini` text, written verbatim into the throwaway profile.
   *
   * Deliberately raw rather than a toggle API: jungle_media's profile carries a
   * hand-assembled gecko code (`$Center Align 2P HUD`, with its hex payload)
   * that no generator here would know about, and a "gecko options" surface
   * would silently drop it. Consumers own their codes; we only place them.
   */
  geckoIni?: string;
  /** Override the auto-resolved real profile to copy from. */
  sourceProfile?: RealProfile;
  /**
   * Start from EMPTY inis instead of copying the real profile: only the keys
   * set here exist, everything else is Dolphin's default. This is what MST's
   * in-process launch always did (its per-setup dir never saw the real
   * profile), so a feed launched this way looks exactly like a legacy one and
   * no setting in the operator's own Playback profile can leak onto stream.
   */
  freshProfile?: boolean;
  /**
   * The GameSettings file name the gecko ini is written as (`<id>.ini`).
   * Default "GALE01" (applies to every revision); MST historically writes
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
   */
  gfxBackend?: "OGL" | "Vulkan";
  /**
   * `[Core] Latency` — audio buffer headroom in ms. MUST NOT be 0 for a live
   * feed: a cold launch stalls audio during ISO load + shader compile, the
   * Pulse backend underflows and never recovers, and the feed is silent for
   * the rest of the session. MST measured 60 as the value that survives
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
   * Symlink `<userDir>/Cache` here so shaders compiled once persist across
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
    | "placement-ignored"; // the WM left some window elsewhere after retries
  detail: string;
}

/** Park a Dolphin's windows on another workspace. See `placeWindows` (place.ts). */
export interface PlacementOptions {
  /** EWMH workspace, 0-BASED (GNOME's "Workspace 10" is 9). Never created — must exist. */
  workspace: number;
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
  onFrame?: (current: number, end: number) => void;
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
  /** Non-fatal things the runner skipped or couldn't do (placement today). */
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
   * the whole game (FPS 0, no DSP, "choppy" feed). MST reproduced this
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
   * too). MST's load test uses this to tell capture cost from render cost.
   */
  capture?: boolean;

  // --- Profile. Applied through buildProfile with mode "play".
  /** REQUIRED. Omitting it would inherit the real profile's — see gotcha 17. */
  efbScale: number;
  /**
   * Default `{ fullscreen: true }` — what MST's mirror ships, and the only way
   * to get a 1920x1080 surface on a 1920x1080 display (see RenderWindow).
   */
  window?: RenderWindow;
  /**
   * Default 1 (real time). 0 = unlimited would fast-forward on air whenever the
   * mirror is pointed at a finished or partly-written replay, with crackling
   * Pulse audio. (Before 2026-10-09 the default was 0; MST always passed 1.)
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
  /** See ProfileOptions.detachHotkeys. Off by default for parity with MST. */
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

export interface RecordResult {
  avi: string;
  wav: string | null;
  /**
   * The `.slp`'s lastFrame, returned so the caller can length-check the dump
   * without re-reading the replay. Expected seconds = (lastFrame + 123) / 60.
   */
  lastFrame: number;
  /** True if the watchdog fired. NOT a verdict — judge the footage. */
  stalled: boolean;
  diagnostic: StallDiagnostic | null;
  /** How window placement went; null if none was asked for. */
  placement: PlacementReport | null;
}
