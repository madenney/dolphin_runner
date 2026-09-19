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

export type RenderWindow =
  | { fullscreen: true }
  | { fullscreen?: false; width: number; height: number; x?: number; y?: number };

export interface ProfileOptions {
  mode: ProfileMode;
  /** Internal-resolution multiplier. Omit to keep whatever the source profile says. */
  efbScale?: number;
  /** 6 = Force16:9 (widescreen), 5 = Force4:3. Omit to keep the source value. */
  aspectRatio?: 5 | 6;
  /** Dump bitrate in kbps. Omit to keep the source value. Record mode only. */
  bitrateKbps?: number;
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

  // --- Tuning for a live/captured window. All optional; omit = keep the copy's value.

  /**
   * `[Core] GFXBackend`. MUST be "OGL" for obs-vkcapture's GL path: its
   * LD_PRELOAD hooks glXSwapBuffers, so a Vulkan Dolphin makes no GL swaps and
   * OBS captures BLACK. A blank value means Vulkan on at least one box.
   */
  gfxBackend?: "OGL" | "Vulkan" | "Software Renderer" | "Null";
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
  /** `[DSP] Backend`. "Pulse" is the one that honours PULSE_SINK for routing. */
  audioBackend?: string;
  /** `[DSP] Volume`, 0–100. Slippi ships 25. */
  volume?: number;
  /**
   * The render window. `{ fullscreen: true }` takes the display's resolution.
   * A fixed size sets `Fullscreen=False`, `RenderWindowAutoSize=False` and
   * the geometry — but it MUST FIT THE DISPLAY'S WORK AREA: GNOME/mutter
   * refuses an initial map larger than that and Dolphin falls back to its
   * 640x480 default (measured 2026-09-19: 1920x1080 windowed on a 1920x1080
   * display captured at 640x443; 1280x720 landed exactly). For a 1:1 capture
   * on a 1080p canvas, fullscreen is the only option on a 1080p display.
   */
  window?: RenderWindow;
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
  /** No first frame within this long = hung boot. Covers Dolphin boot + ISO load. */
  bootStallMs?: number;
  /** Frames stopped for this long mid-record = frozen. */
  frameStallMs?: number;
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

  // --- Profile. Applied through buildProfile with mode "play".
  /** REQUIRED. Omitting it would inherit the real profile's — see gotcha 17. */
  efbScale: number;
  /**
   * Default `{ fullscreen: true }` — what MST's mirror ships, and the only way
   * to get a 1920x1080 surface on a 1920x1080 display (see RenderWindow).
   */
  window?: RenderWindow;
  /** Default 0 (unlimited) — a mirror is paced by the growing .slp, not the clock. */
  emulationSpeed?: number;
  /** Default 60. */
  audioLatencyMs?: number;
  shaderCacheDir?: string;
  geckoIni?: string;
  sourceProfile?: RealProfile;
}

export interface ObsMirrorHandle {
  pid: number;
  /** The env the child was spawned with, for diagnostics. */
  env: Record<string, string>;
  /** Resolves when Dolphin exits, however it exits. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderrTail: string[] }>;
  /** Kill the whole tree (SIGKILL — a mirror has nothing to finalise) and wait. */
  stop(): Promise<void>;
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
}
