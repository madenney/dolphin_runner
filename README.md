# slippi-dolphin-runner

Spawn an isolated Slippi **Playback** Dolphin to frame-dump or mirror a replay —
without hangs, leaked processes, or touching the user's real Dolphin profile.

Zero runtime dependencies. Node ESM + TypeScript. No Electron, no slippi-js.

> **Status: unconsumed.** Built standalone and tested; no project imports it yet.
> `mirror()` is provisional and Windows is unverified at runtime — see CLAUDE.md.

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
| `mirror(paths, slp, opts)` | batch-mode live playback, no dump *(leftover; prefer obsMirror)* |
| `buildProfile(userDir, opts)` | throwaway `--user` profile from a copy of the real one |
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
  [--emulation-speed 0] [--audio-latency-ms 60] [--shader-cache <dir>] [--gecko-ini <file>] [--real-time]
```

Stays in the foreground; one JSON line per event on stdout
(`started` / `stopping` / `exited` / `error`); SIGTERM to it kills the whole
Dolphin tree. Re-point it by rewriting `--comm` with a new replay and
commandId — Dolphin reloads on its own.

## Scope

**In:** profile builder, comm.json, spawn, frame-watch, stall watchdog,
kill-tree, AbortSignal, cross-OS path handling.

**Out:** ffmpeg mux/re-encode/concat, overlay compositing, X11 workspace parking,
uploads, progress UI, clip selection. Those belong to the app.

## Development

```sh
npm run check     # typecheck + tests
npm run smoke     # record one real replay with a real Dolphin; needs GPU + DISPLAY
```

Tests run on `node --test` against the TypeScript sources directly (Node 22+
strips types natively) — no jest, no vitest, no build step to test.
