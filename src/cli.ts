#!/usr/bin/env node
/**
 * `dolphin-runner` — the process boundary for consumers that are not Node.
 *
 * MST is Rust/Tauri; it cannot import this package, so it spawns this and
 * treats the child's lifetime as the feed's lifetime. Every subcommand:
 *   - prints ONE JSON line per event to stdout (`{"event":"started",...}`),
 *   - stays in the foreground until the Dolphin exits,
 *   - forwards SIGINT/SIGTERM to the whole Dolphin tree and exits with its code.
 */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { obsMirror } from "./obs.ts";

const USAGE = `usage:
  dolphin-runner obs-mirror --dolphin <bin> --iso <iso> --user-dir <dir> --comm <path>
                            --capture-name <name> --efb-scale <n>
                            [--replay <slp>] [--real-time]
                            [--display <:N>] [--pulse-sink <sink>] [--pulse-latency-ms <120>]
                            [--vkcapture-shim <.so>] [--glcapture-lib <.so>]
                            [--fullscreen (default) | --render-width <w> --render-height <h> [--window-x <n>] [--window-y <n>]]
                            [--emulation-speed <0>] [--audio-latency-ms <60>]
                            [--shader-cache <dir>] [--gecko-ini <file>]
`;

function num(v: string | undefined, name: string): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got ${JSON.stringify(v)}`);
  return n;
}

function emit(event: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

async function obsMirrorCmd(argv: string[]) {
  const { values: v } = parseArgs({
    args: argv,
    strict: true,
    options: {
      dolphin: { type: "string" },
      iso: { type: "string" },
      "user-dir": { type: "string" },
      comm: { type: "string" },
      replay: { type: "string" },
      "real-time": { type: "boolean", default: false },
      display: { type: "string" },
      "capture-name": { type: "string" },
      "pulse-sink": { type: "string" },
      "pulse-latency-ms": { type: "string" },
      "vkcapture-shim": { type: "string" },
      "glcapture-lib": { type: "string" },
      "efb-scale": { type: "string" },
      fullscreen: { type: "boolean" },
      "render-width": { type: "string" },
      "render-height": { type: "string" },
      "window-x": { type: "string" },
      "window-y": { type: "string" },
      "emulation-speed": { type: "string" },
      "audio-latency-ms": { type: "string" },
      "shader-cache": { type: "string" },
      "gecko-ini": { type: "string" },
    },
  });

  for (const k of ["dolphin", "iso", "user-dir", "comm", "capture-name", "efb-scale"] as const) {
    if (!v[k]) throw new Error(`--${k} is required`);
  }

  // Windowed only when a size is given; a windowed size larger than the
  // display's work area silently becomes 640x480 (see RenderWindow).
  const width = num(v["render-width"], "render-width");
  const height = num(v["render-height"], "render-height");
  const x = num(v["window-x"], "window-x");
  const y = num(v["window-y"], "window-y");
  if ((width == null) !== (height == null)) throw new Error("--render-width and --render-height go together");
  if (v.fullscreen && width != null) throw new Error("--fullscreen and --render-width are mutually exclusive");
  const window =
    width != null && height != null
      ? { width, height, ...(x != null ? { x } : {}), ...(y != null ? { y } : {}) }
      : { fullscreen: true as const };

  const ac = new AbortController();
  const handle = await obsMirror(
    { dolphinPath: v.dolphin!, isoPath: v.iso! },
    {
      userDir: v["user-dir"]!,
      commPath: v.comm!,
      replay: v.replay,
      isRealTimeMode: v["real-time"],
      display: v.display,
      captureName: v["capture-name"]!,
      pulseSink: v["pulse-sink"],
      pulseLatencyMs: num(v["pulse-latency-ms"], "pulse-latency-ms"),
      exeOverrideShim: v["vkcapture-shim"],
      glcaptureLib: v["glcapture-lib"],
      efbScale: num(v["efb-scale"], "efb-scale")!,
      window,
      emulationSpeed: num(v["emulation-speed"], "emulation-speed"),
      audioLatencyMs: num(v["audio-latency-ms"], "audio-latency-ms"),
      shaderCacheDir: v["shader-cache"],
      geckoIni: v["gecko-ini"] ? readFileSync(v["gecko-ini"], "utf8") : undefined,
      signal: ac.signal,
    },
  );

  emit({ event: "started", pid: handle.pid, captureName: v["capture-name"], userDir: v["user-dir"], comm: v.comm });

  // Our death is the feed's death. Forward the signal to the whole tree.
  const onSignal = (sig: NodeJS.Signals) => {
    emit({ event: "stopping", signal: sig });
    ac.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);

  const r = await handle.exited;
  emit({ event: "exited", code: r.code, signal: r.signal, stderrTail: r.stderrTail });
  process.exit(r.code ?? (r.signal ? 128 : 1));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "obs-mirror":
      return obsMirrorCmd(rest);
    case undefined:
    case "-h":
    case "--help":
      process.stdout.write(USAGE);
      return;
    default:
      throw new Error(`unknown command: ${cmd}\n${USAGE}`);
  }
}

main().catch((e: unknown) => {
  emit({ event: "error", message: e instanceof Error ? e.message : String(e) });
  process.exit(2);
});
