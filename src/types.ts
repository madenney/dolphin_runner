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
