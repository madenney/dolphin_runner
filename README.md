# slippi-dolphin-runner

Spawn an isolated Slippi **Playback** Dolphin to frame-dump or mirror a replay —
without hangs, leaked processes, or touching the user's real Dolphin profile.

Zero runtime dependencies. Node ESM + TypeScript. No Electron, no slippi-js.

> **Status:** used by jungle_media's VOD recorder, melee_skins, and MST's
> flag-guarded `obs-mirror` path. Windows is unverified at runtime — see CLAUDE.md.
> Running hidden / muted, and the codec speed trade-off: [docs/background-and-mute.md](docs/background-and-mute.md).

## Install

```sh
npm install slippi-dolphin-runner      # or: "file:../dolphin_runner" while local
```

## Use

```ts
import { buildProfile, record, dolphinStatus } from "slippi-dolphin-runner";

const paths = { dolphinPath: "/path/to/Slippi_Playback.AppImage", isoPath: "/path/to/melee.iso" };

const why = dolphinStatus(paths);
if (why) throw new Error(why);

// One throwaway profile PER CONCURRENT DOLPHIN. Not optional — two Dolphins
// sharing a user dir overwrite each other's frames silently.
await buildProfile("/tmp/worker-1", {
  mode: "record",
  efbScale: 6,
  aspectRatio: 6,        // 6 = Force16:9
  bitrateKbps: 60000,
  geckoIni: myGaleIniText,   // raw GALE01.ini; yours, we just place it
  dolphinPath: paths.dolphinPath,
});

const res = await record(paths, "/path/to/game.slp", {
  outDir: "/tmp/out",
  userDir: "/tmp/worker-1",
  display: ":1",             // a frame dump needs a live GL context
  signal: ac.signal,
  onFrame: (cur, end) => report(cur / end),
});

// res = { avi, wav, lastFrame, stalled, diagnostic }
// Muxing is YOURS. So is the length check — that is what lastFrame is for:
const expectedSec = (res.lastFrame + 123) / 60;
```

`onSpawn: (pid) => …` (record and mirror) is called once with the Dolphin's pid —
the root of the tree that owns the window (`pidTree(pid)` for the rest), e.g.
for window parking.

### Running it in the background, muted

```ts
import { BACKGROUND_RECORD, buildProfile, record } from "slippi-dolphin-runner";

await buildProfile("/tmp/worker-1", {
  ...BACKGROUND_RECORD,   // PauseOnFocusLost off, not on top, vsync off, 640x360 window
  mode: "record",
  efbScale: 6,            // an ENUM: 2 = native, 4 = 2x, 6 = 3x
  silent: true,           // [DSP] Backend = "No audio output" — the WAV dump is unaffected
  dumpCodec: "utvideo",   // lossless and ~8x faster than ffv1 at EFB 6; needs efbScale != 2
  dolphinPath: paths.dolphinPath,
});
const res = await record(paths, slp, {
  outDir, userDir: "/tmp/worker-1",
  appName: "jm-vod-1",    // per-instance Pulse application.name (WirePlumber keys on it)
  placement: { workspace: 9 },  // 0-based; parks THIS Dolphin's windows by pid, hands focus back
  onWarning: (w) => log(w),     // e.g. no window manager (Xvfb), xdotool missing, not Linux
});
// res.placement = { status: "placed" | "partial" | "none-found" | "skipped", windows }
```

Mirror (OBS) audio is muted by ROUTING (`pulseSink`), never by volume or `silent`:
OBS reads that sink's monitor. Why, with measurements: docs/background-and-mute.md.

### A stall is not a failure

`record()` resolves even when the watchdog fires, with `stalled: true` and a
`diagnostic`. Measured dumps at the moment of a stall have been 27%, 43%, 70%
and **94%** complete — rejecting on the watchdog throws away finished work.
Judge the footage, not the silence:

```ts
if (res.stalled) log(res.diagnostic);
const got = await durationOf(res.avi);
if (got < expectedSec * 0.9) throw new Error("dump is short — re-record");
```

## API

| | |
|---|---|
| `record(paths, slp, opts)` | frame-dump → `{ avi, wav, lastFrame, stalled, diagnostic }` |
| `obsMirror(paths, opts)` | long-lived, OBS-capturable Dolphin (obs-vkcapture GL path) → handle with `stop()` |
| `buildProfile(userDir, opts)` | throwaway `--user` profile from a copy of the real one |
| `BACKGROUND_RECORD` | profile preset for a recording that stays out of the way (no focus pause, not on top, no vsync, 640x360) — spread it into `buildProfile` |
| `AUDIO_BACKENDS`, `NULL_AUDIO_BACKEND` | the `[DSP] Backend` strings Dolphin knows; anything else silently mutes, so `buildProfile` refuses it |
| `recordEnv`, `appNameProp` | the env `record()` spawns with, pure |
| `placeWindows(pid, opts)`, `checkPlacement(opts)` | park one process tree's windows on a workspace (Linux/X11, needs xdotool + x11-utils); for callers that spawn Dolphin themselves |
| `healRealProfile(dolphinPath)` | force the real profile's dump flags off |
| `dolphinStatus(paths)` | human-readable reason, or `null` |
| `lastFrameOf(slp)` | last frame from the UBJSON footer |
| `killTree(pid, graceful?)` | kill a process and everything it spawned |
| `writeMirrorComm(path, slp)` | re-point a running mirror at the next game |
| `parseFrameLine`, `reachedEnd`, `foldEnd` | the stdout rules, pure and tested |
| `setInSection`, `setEverywhere`, `getInSection` | the ini editor |

## CLI (for non-Node consumers)

```sh
dolphin-runner obs-mirror \
  --dolphin <AppImage> --iso <melee.iso> \
  --user-dir /tmp/setup-1 --comm /tmp/setup-1/comm.json [--replay <first.slp>] \
  --capture-name dolphin-1 --efb-scale 2 \
  [--display :1] [--pulse-sink game1] [--pulse-latency-ms 120] \
  [--vkcapture-shim <exe-override.so>] [--glcapture-lib <libobs_glcapture.so>] \
  [--fullscreen | --render-width W --render-height H [--window-x X --window-y Y]] \
  [--emulation-speed 1] [--audio-latency-ms 60] [--shader-cache <dir>] [--gecko-ini <file>] [--real-time]
  [--detach-hotkeys] [--app-name <pulse application.name>]
  [--workspace <n, 0-based> [--placement-required]] \
  [--game-settings-id GALE01] [--gfx-backend OGL|Vulkan] [--msaa 1|2|4|8] [--fresh-profile] [--no-capture]
```

`--fresh-profile` builds the `--user` dir from empty inis (only the keys above,
Dolphin defaults for the rest) instead of copying the real Playback profile —
the way MST's own launch always worked. `--no-capture` runs the same Dolphin
with no capture hook (`OBS_VKCAPTURE=0`, no `LD_PRELOAD`).

### Building the CLI (what MST runs)

```sh
cd ~/Projects/dolphin_runner && npm ci && npm run build   # → dist/cli.js
node dist/cli.js --help
```

MST (jungle `apps/mst`) uses this for its mirror feeds only when
`MST_DOLPHIN_RUNNER=1` (or `useDolphinRunner: true` in its config). It runs
`$DOLPHIN_RUNNER` if set (a command, or a path to `cli.js`), else
`~/Projects/dolphin_runner/dist/cli.js` via `node`. MST keeps the comm-file
follow; this process owns the profile, the config and the capture env.

Stays in the foreground; one JSON line per event on stdout
(`started` / `warning` / `placed` / `stopping` / `exited` / `error`); SIGTERM to it kills the whole
Dolphin tree. Re-point it by rewriting `--comm` with a new replay and
commandId — Dolphin reloads on its own.

## Scope

**In:** profile builder, comm.json, spawn, frame-watch, stall watchdog,
kill-tree, AbortSignal, cross-OS path handling, parking the windows of a
Dolphin it spawned (by pid — never by title).

**Out:** ffmpeg mux/re-encode/concat, overlay compositing, windows we didn't spawn,
uploads, progress UI, clip selection. Those belong to the app.

## Development

```sh
npm run check     # typecheck + tests
npm run smoke     # record one real replay with a real Dolphin; needs GPU + DISPLAY
```

Tests run on `node --test` against the TypeScript sources directly (Node 22+
strips types natively) — no jest, no vitest, no build step to test.
