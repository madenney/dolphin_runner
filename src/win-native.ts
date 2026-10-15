/**
 * Optional native Windows calls that a hidden recording wants but Node cannot
 * make: the process QoS opt-out and the foreground lock.
 *
 * **Zero required dependencies.** This package's `dependencies` stay `{}`. The
 * native calls go through `koffi` (an npm FFI with prebuilt binaries), which is
 * loaded LAZILY and only if the HOST has installed it — a Windows consumer adds
 * `koffi` to its own app. Without it, every function here is a clean no-op that
 * reports `"unavailable"`, and hiding still works (the window is hidden; it just
 * may land on the Low power-QoS tier and may steal focus once while the parent
 * app is foreground). UNVERIFIED at runtime — needs the Windows rig.
 *
 * Why these two:
 * - **QoS (`SetProcessInformation` + `ProcessPowerThrottling`).** Windows drops
 *   a window that is not visible and not audible to the Low QoS tier
 *   ("Minimized, or Fully Occluded"), which on hybrid CPUs schedules it onto
 *   E-cores at ~half speed. A muted, hidden Dolphin lands there. Setting
 *   `EXECUTION_SPEED` control with state 0 = HighQoS opts out; the same with
 *   `IGNORE_TIMER_RESOLUTION` keeps its timer request honoured.
 * - **`LockSetForegroundWindow(LSFW_LOCK)`.** Dolphin raises itself at launch
 *   (`SetForegroundWindow`), and Windows lets a process started by the
 *   foreground app take the foreground — so while the parent app is foreground,
 *   a hidden Dolphin would steal keyboard focus on every clip. Locking around
 *   the spawn blocks that; Windows auto-unlocks on the next user input.
 */

export interface NativeHideResult {
  /** Whether a native backend was loaded at all. */
  available: boolean;
  /** HighQoS opt-out on the child process handle. */
  qos: "high" | "unavailable" | "failed" | "skipped";
  /** The foreground lock around the spawn. */
  foregroundLock: "locked" | "unavailable" | "failed" | "skipped";
  /** What was loaded / why not, for diagnostics. */
  detail: string;
}

/** The subset of koffi this uses, so a test can inject a fake. */
export interface WinNativeBackend {
  /** HighQoS opt-out for a child pid. Returns true on success. */
  setHighQos(pid: number): boolean;
  /** LockSetForegroundWindow(LSFW_LOCK). */
  lockForeground(): boolean;
  /** LockSetForegroundWindow(LSFW_UNLOCK). */
  unlockForeground(): boolean;
}

let cached: WinNativeBackend | null | undefined;

/**
 * Try to build the koffi-backed backend. Returns null when koffi is not
 * installed (the normal case off Windows, and on a Windows host that didn't add
 * it). Cached so the require is attempted once. `loader` is injectable for tests.
 */
export function loadWinNative(
  platform: NodeJS.Platform = process.platform,
  loader: () => unknown = defaultKoffiLoader,
): WinNativeBackend | null {
  if (platform !== "win32") return null;
  if (cached !== undefined) return cached;
  cached = buildBackend(loader);
  return cached;
}

/** Reset the cache (tests only). */
export function _resetWinNativeCache(): void {
  cached = undefined;
}

function defaultKoffiLoader(): unknown {
  try {
    // Indirection keeps bundlers/`tsc` from treating this as a hard dep, and the
    // require only runs on Windows when loadWinNative is called.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const req = (0, eval)("require") as NodeRequire;
    return req("koffi");
  } catch {
    return null;
  }
}

function buildBackend(loader: () => unknown): WinNativeBackend | null {
  let koffi: any;
  try {
    koffi = loader();
  } catch {
    return null;
  }
  if (!koffi || typeof koffi.load !== "function") return null;
  try {
    const kernel32 = koffi.load("kernel32.dll");
    const user32 = koffi.load("user32.dll");
    const OpenProcess = kernel32.func("void* __stdcall OpenProcess(uint32, bool, uint32)");
    const CloseHandle = kernel32.func("bool __stdcall CloseHandle(void*)");
    // PROCESS_POWER_THROTTLING_STATE: { Version, ControlMask, StateMask } — 3 uint32s.
    const SetProcessInformation = kernel32.func(
      "bool __stdcall SetProcessInformation(void*, int, void*, uint32)",
    );
    const LockSetForegroundWindow = user32.func("bool __stdcall LockSetForegroundWindow(uint32)");

    const PROCESS_SET_INFORMATION = 0x0200;
    const ProcessPowerThrottling = 4; // PROCESS_INFORMATION_CLASS
    const POWER_THROTTLING_CURRENT_VERSION = 1;
    const EXECUTION_SPEED = 0x1;
    const IGNORE_TIMER_RESOLUTION = 0x4;
    const LSFW_LOCK = 1;
    const LSFW_UNLOCK = 2;

    return {
      setHighQos(pid: number): boolean {
        const h = OpenProcess(PROCESS_SET_INFORMATION, false, pid >>> 0);
        if (!h) return false;
        try {
          // ControlMask names the knobs; StateMask 0 = opt OUT of throttling
          // (HighQoS). 3 x uint32, little-endian.
          const buf = Buffer.alloc(12);
          buf.writeUInt32LE(POWER_THROTTLING_CURRENT_VERSION, 0);
          buf.writeUInt32LE(EXECUTION_SPEED | IGNORE_TIMER_RESOLUTION, 4);
          buf.writeUInt32LE(0, 8);
          return !!SetProcessInformation(h, ProcessPowerThrottling, buf, buf.length);
        } finally {
          CloseHandle(h);
        }
      },
      lockForeground: () => !!LockSetForegroundWindow(LSFW_LOCK),
      unlockForeground: () => !!LockSetForegroundWindow(LSFW_UNLOCK),
    };
  } catch {
    return null;
  }
}

/** The "nothing loaded" result, so callers can report uniformly. */
export function unavailableNative(detail = "koffi not installed; native QoS/foreground-lock skipped"): NativeHideResult {
  return { available: false, qos: "unavailable", foregroundLock: "unavailable", detail };
}
