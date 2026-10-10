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
import { BACKGROUND_RECORD, buildProfile } from "./profile.ts";
import { play, record } from "./run.ts";

const USAGE = `usage:
  dolphin-runner record --dolphin <bin> --iso <iso> --slp <replay.slp>
                        --out <dir> --user-dir <dir> --efb-scale <n>
                        [--base-name dump] [--comm <path>] [--display <:N>]
                        [--start-frame -123] [--end-frame <n>] [--last-frame <n>]
                        [--aspect-ratio 6] [--bitrate-kbps <n>] [--dump-codec ffv1|utvideo|mpeg4]
                        [--gecko-ini <file>] [--game-settings-id GALE01]
                        [--texture-pack <dir> ...] [--silent] [--background]
                        [--shader-cache <dir>] [--fresh-profile]
                        [--hard-timeout-ms <n>] [--boot-stall-ms 90000] [--frame-stall-ms 30000]
                        [--workspace <n> [--placement-required]] [--undecorate]
                        [--geometry WxH[+X+Y]] [--monitor landscape|<output>]
  dolphin-runner play   --dolphin <bin> --iso <iso> --slp <replay.slp>
                        --user-dir <dir> [--start-frame N] [--end-frame N]
                        [--last-frame N] [--comm <path>] [--display <:N>]
                        [--no-batch] [--hide-seekbar] [--real-time]
                        [--frame-stall-ms N] [--hard-timeout-ms N]
                        [--workspace N [--undecorate --geometry WxH --monitor M]]
  events: started, progress, warning, placed, result, error

  dolphin-runner obs-mirror --dolphin <bin> --iso <iso> --user-dir <dir> --comm <path>
                            --capture-name <name> --efb-scale <n>
                            [--replay <slp>] [--real-time]
                            [--display <:N>] [--pulse-sink <sink>] [--pulse-latency-ms <120>]
                            [--vkcapture-shim <.so>] [--glcapture-lib <.so>]
                            [--fullscreen (default) | --render-width <w> --render-height <h> [--window-x <n>] [--window-y <n>]]
                            [--emulation-speed <1>] [--audio-latency-ms <60>]
                            [--shader-cache <dir>] [--gecko-ini <file>] [--game-settings-id <GALE01>]
                            [--gfx-backend <OGL|Vulkan>] [--msaa <1|2|4|8>]
                            [--fresh-profile] [--no-capture]
                            [--detach-hotkeys] [--app-name <pulse application.name>]
                            [--workspace <n, 0-based> [--placement-required]]

events (one JSON line each): started, warning, placed, stopping, exited, error
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
      "game-settings-id": { type: "string" },
      "gfx-backend": { type: "string" },
      msaa: { type: "string" },
      "fresh-profile": { type: "boolean", default: false },
      "no-capture": { type: "boolean", default: false },
      "detach-hotkeys": { type: "boolean", default: false },
      "app-name": { type: "string" },
      workspace: { type: "string" },
      "placement-required": { type: "boolean", default: false },
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

  const backend = v["gfx-backend"];
  if (backend != null && backend !== "OGL" && backend !== "Vulkan") {
    throw new Error(`--gfx-backend must be OGL or Vulkan, got ${JSON.stringify(backend)}`);
  }

  const workspace = num(v.workspace, "workspace");
  if (v["placement-required"] && workspace == null) throw new Error("--placement-required needs --workspace");

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
      gameSettingsId: v["game-settings-id"],
      gfxBackend: backend as "OGL" | "Vulkan" | undefined,
      msaa: num(v.msaa, "msaa"),
      freshProfile: v["fresh-profile"],
      capture: !v["no-capture"],
      detachHotkeys: v["detach-hotkeys"],
      appName: v["app-name"],
      placement: workspace != null ? { workspace, required: v["placement-required"] } : undefined,
      onWarning: (w) => emit({ event: "warning", ...w }),
      signal: ac.signal,
    },
  );

  emit({ event: "started", pid: handle.pid, captureName: v["capture-name"], userDir: v["user-dir"], comm: v.comm });
  void handle.placement?.then((r) => emit({ event: "placed", ...r }));

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

/** `WxH` or `WxH+X+Y`. */
function parseGeometry(v: string | undefined): { x?: number; y?: number; width: number; height: number } | undefined {
  if (v == null) return undefined;
  const m = /^(\d+)x(\d+)(?:\+(-?\d+)\+(-?\d+))?$/.exec(v.trim());
  if (!m) throw new Error(`--geometry must be WxH or WxH+X+Y, got ${JSON.stringify(v)}`);
  return {
    width: +m[1]!,
    height: +m[2]!,
    ...(m[3] != null ? { x: +m[3]!, y: +m[4]! } : {}),
  };
}

async function recordCmd(argv: string[]) {
  const { values: v } = parseArgs({
    args: argv,
    strict: true,
    options: {
      dolphin: { type: "string" },
      iso: { type: "string" },
      slp: { type: "string" },
      out: { type: "string" },
      "user-dir": { type: "string" },
      "base-name": { type: "string" },
      comm: { type: "string" },
      display: { type: "string" },
      "start-frame": { type: "string" },
      "end-frame": { type: "string" },
      "last-frame": { type: "string" },
      "efb-scale": { type: "string" },
      "aspect-ratio": { type: "string" },
      "bitrate-kbps": { type: "string" },
      "dump-codec": { type: "string" },
      "gecko-ini": { type: "string" },
      "game-settings-id": { type: "string" },
      "texture-pack": { type: "string", multiple: true },
      silent: { type: "boolean", default: false },
      background: { type: "boolean", default: false },
      "shader-cache": { type: "string" },
      "fresh-profile": { type: "boolean", default: false },
      "no-batch": { type: "boolean", default: false },
      "hard-timeout-ms": { type: "string" },
      "boot-stall-ms": { type: "string" },
      "frame-stall-ms": { type: "string" },
      workspace: { type: "string" },
      "placement-required": { type: "boolean", default: false },
      undecorate: { type: "boolean", default: false },
      geometry: { type: "string" },
      monitor: { type: "string" },
    },
  });
  for (const k of ["dolphin", "iso", "slp", "out", "user-dir", "efb-scale"] as const) {
    if (!v[k]) throw new Error(`--${k} is required`);
  }

  const paths = { dolphinPath: v.dolphin!, isoPath: v.iso! };
  const codec = v["dump-codec"];
  if (codec != null && !["ffv1", "utvideo", "mpeg4", "default"].includes(codec)) {
    throw new Error(
      `--dump-codec must be ffv1, utvideo, mpeg4 or default (never h264 — it drops the last ~50 frames)`,
    );
  }

  // The CLI builds the profile too: a consumer that can only shell out would
  // otherwise need a Node shim just to call buildProfile, which is exactly the
  // shim melee_skins had to write.
  await buildProfile(v["user-dir"]!, {
    mode: "record",
    dolphinPath: paths.dolphinPath,
    efbScale: num(v["efb-scale"], "efb-scale"),
    aspectRatio: num(v["aspect-ratio"], "aspect-ratio") as 5 | 6 | undefined,
    bitrateKbps: num(v["bitrate-kbps"], "bitrate-kbps"),
    dumpCodec: codec as "ffv1" | "utvideo" | "mpeg4" | "default" | undefined,
    geckoIni: v["gecko-ini"] ? readFileSync(v["gecko-ini"], "utf8") : undefined,
    gameSettingsId: v["game-settings-id"],
    texturePacks: v["texture-pack"],
    silent: v.silent,
    shaderCacheDir: v["shader-cache"],
    freshProfile: v["fresh-profile"],
    ...(v.background ? BACKGROUND_RECORD : {}),
  });

  const workspace = num(v.workspace, "workspace");
  if (v["placement-required"] && workspace == null) throw new Error("--placement-required needs --workspace");
  const geometry = parseGeometry(v.geometry);
  if ((geometry || v.undecorate || v.monitor) && workspace == null) {
    throw new Error("--geometry/--undecorate/--monitor need --workspace (placement is what applies them)");
  }

  let lastReported = -Infinity;
  const res = await record(paths, v.slp!, {
    outDir: v.out!,
    userDir: v["user-dir"]!,
    baseName: v["base-name"],
    commPath: v.comm,
    display: v.display,
    batch: !v["no-batch"],
    startFrame: num(v["start-frame"], "start-frame"),
    endFrame: num(v["end-frame"], "end-frame"),
    lastFrame: num(v["last-frame"], "last-frame"),
    hardTimeoutMs: num(v["hard-timeout-ms"], "hard-timeout-ms"),
    bootStallMs: num(v["boot-stall-ms"], "boot-stall-ms"),
    frameStallMs: num(v["frame-stall-ms"], "frame-stall-ms"),
    placement:
      workspace != null
        ? {
            workspace,
            required: v["placement-required"],
            ...(geometry ? { geometry } : {}),
            ...(v.undecorate ? { undecorate: true } : {}),
            ...(v.monitor ? { monitor: v.monitor } : {}),
          }
        : undefined,
    onWarning: (w) => emit({ event: "warning", ...w }),
    onSpawn: (pid) => emit({ event: "started", pid, replay: v.slp }),
    // Throttled: one line per ~600 frames is a progress bar, not a flood.
    onFrame: (current, end) => {
      if (current - lastReported < 600 && current < end) return;
      lastReported = current;
      emit({ event: "progress", current, end });
    },
  });
  emit({
    event: "result",
    avi: res.avi,
    wav: res.wav,
    lastFrame: res.lastFrame,
    stalled: res.stalled,
    stoppedEarly: res.stoppedEarly,
    placement: res.placement,
    ...(res.diagnostic ? { diagnostic: res.diagnostic } : {}),
  });
}

async function playCmd(argv: string[]) {
  const { values: v } = parseArgs({
    args: argv,
    strict: true,
    options: {
      dolphin: { type: "string" },
      iso: { type: "string" },
      slp: { type: "string" },
      "user-dir": { type: "string" },
      comm: { type: "string" },
      display: { type: "string" },
      "start-frame": { type: "string" },
      "end-frame": { type: "string" },
      "last-frame": { type: "string" },
      "no-batch": { type: "boolean", default: false },
      "hide-seekbar": { type: "boolean", default: false },
      "real-time": { type: "boolean", default: false },
      "boot-stall-ms": { type: "string" },
      "frame-stall-ms": { type: "string" },
      "hard-timeout-ms": { type: "string" },
      workspace: { type: "string" },
      "placement-required": { type: "boolean", default: false },
      undecorate: { type: "boolean", default: false },
      geometry: { type: "string" },
      monitor: { type: "string" },
    },
  });
  for (const k of ["dolphin", "iso", "slp", "user-dir"] as const) {
    if (!v[k]) throw new Error(`--${k} is required`);
  }
  const workspace = num(v.workspace, "workspace");
  if (v["placement-required"] && workspace == null) throw new Error("--placement-required needs --workspace");
  const geometry = parseGeometry(v.geometry);
  if ((geometry || v.undecorate || v.monitor) && workspace == null) {
    throw new Error("--geometry/--undecorate/--monitor need --workspace (placement is what applies them)");
  }

  let lastReported = -Infinity;
  const res = await play({ dolphinPath: v.dolphin!, isoPath: v.iso! }, v.slp!, {
    userDir: v["user-dir"]!,
    commPath: v.comm,
    display: v.display,
    startFrame: num(v["start-frame"], "start-frame"),
    endFrame: num(v["end-frame"], "end-frame"),
    lastFrame: num(v["last-frame"], "last-frame"),
    batch: !v["no-batch"],
    hideSeekbar: v["hide-seekbar"],
    isRealTimeMode: v["real-time"],
    bootStallMs: num(v["boot-stall-ms"], "boot-stall-ms"),
    frameStallMs: num(v["frame-stall-ms"], "frame-stall-ms"),
    hardTimeoutMs: num(v["hard-timeout-ms"], "hard-timeout-ms"),
    placement:
      workspace != null
        ? {
            workspace,
            required: v["placement-required"],
            ...(geometry ? { geometry } : {}),
            ...(v.undecorate ? { undecorate: true } : {}),
            ...(v.monitor ? { monitor: v.monitor } : {}),
          }
        : undefined,
    onWarning: (w) => emit({ event: "warning", ...w }),
    onSpawn: (pid) => emit({ event: "started", pid, replay: v.slp }),
    onFrame: (current, end) => {
      if (current - lastReported < 600 && current < end) return;
      lastReported = current;
      emit({ event: "progress", current, end });
    },
  });
  emit({ event: "result", ...res });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "record":
      return recordCmd(rest);
    case "play":
      return playCmd(rest);
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
