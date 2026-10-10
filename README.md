# slippi-dolphin-runner

Spawn an isolated Slippi **Playback** Dolphin to frame-dump or mirror a replay —
without hangs, leaked processes, or touching the user's real Dolphin profile.

Zero runtime dependencies. Node ESM + TypeScript. No Electron, no slippi-js.

> **Status:** used by jungle_media's VOD recorder, melee_skins, and MST's
> flag-guarded `obs-mirror` path. Windows is unverified at runtime — see CLAUDE.md.
> Running hidden / muted, and the codec speed trade-off: [docs/background-and-mute.md](docs/background-and-mute.md).

Moving a project off its own Dolphin-spawning code?
**[MIGRATING.md](MIGRATING.md)** is the checklist of what to delete.
Version history and breaking changes: [CHANGELOG.md](CHANGELOG.md).

## Install

```sh
npm install slippi-dolphin-runner      # or: "file:../dolphin_runner" while local
```

Pin a tag, never a branch — and do not vendor a copy. A vendored fork that
drifts is the exact failure this package exists to end.

Two things about installing from git: **bumping the pin needs an explicit
`npm install "github:…#vX.Y.Z"`** (editing `package.json` and running
`npm install` keeps the old commit), and npm's **`allow-scripts` warning about
`prepare` is harmless** — `dist/` is not committed, but npm runs the build
while packing the git ref, so it is already there. See `MIGRATING.md` §1.

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

Every export is public — there is no internal/private split. Types live in
`src/types.ts` and their JSDoc is the long-form version of everything below.

### `record(paths, slp, opts) → Promise<RecordResult>`

Frame-dump one replay. Spawns Dolphin with `-b` (batch), watches `--cout` for
frames, SIGTERMs at the end frame so the `.avi`/`.wav` finalise, and resolves.

```ts
const res = await record({ dolphinPath, isoPath }, "/path/game.slp", {
  outDir: "/tmp/out",
  userDir: "/tmp/worker-1",   // REQUIRED, one per concurrent Dolphin
});
// → { avi, wav, lastFrame, stalled, diagnostic, placement }
```

**Resolves even when the watchdog fired** (`stalled: true`); see "A stall is not
a failure". It rejects only when there is nothing to judge: a bad path, an
unreadable `lastFrame`, a missing `userDir`, an aborted signal, or a hang that
produced no `.avi` at all.

`RecordResult`: `avi` (path), `wav` (path or `null`), `lastFrame` (so you can
length-check without re-reading the `.slp` — expected seconds =
`(lastFrame + 123) / 60`), `stalled`, `diagnostic` (a `StallDiagnostic` when
the watchdog fired, else `null`), `placement` (a `PlacementReport` or `null`).

### `obsMirror(paths, opts) → Promise<ObsMirrorHandle>`

A long-lived Dolphin another process captures in OBS through obs-vkcapture's
GL path. No `-b`, no watchdog — idling on "waiting for game" is healthy.

```ts
const commPath = "/tmp/setup-1/comm.json";
const h = await obsMirror(paths, {
  userDir: "/tmp/setup-1",
  commPath,
  captureName: "dolphin-1",   // what the OBS vkcapture source matches
  efbScale: 2,                // REQUIRED
  pulseSink: "game1",
});
// h = { pid, env, exited, placement, stop() }
writeMirrorComm(commPath, nextReplay);   // re-point it; Dolphin reloads itself
await h.stop();                          // SIGKILLs the tree
```

The caller owns the comm file. Nothing here watches anything.

### `play(paths, slp, opts) → Promise<PlayResult>`

A frame range on screen, no dump — a clip preview. The third launch shape:
`record()` dumps and runs hidden in batch, `obsMirror()` wants OBS capture env
and a mirror comm with no frame range; a preview is neither.

```ts
await buildProfile(userDir, { mode: "play", dolphinPath, efbScale: 4 });
const r = await play(paths, slp, { userDir, startFrame: 1000, endFrame: 1600 });
// → { lastFrame, stalled, stoppedEarly, diagnostic, placement }
```

It keeps `--cout`, so playback stops on the same numeric end-frame rule
`record()` uses rather than a timer guessing that the clip finished. `-b` is on
by default (Dolphin exits with emulation); pass `batch: false` to leave the
window up. Takes the same `placement`, `signal`, `onFrame`, `hardTimeoutMs`
and `commPath` options as `record()`. No `-o` and no `--output-directory` are
ever passed — a preview that quietly wrote frames would fill a disk.

### `buildProfile(userDir, opts) → Promise<void>`

Builds the throwaway `--user` profile: copies every real `Config/*.ini`, then
applies your overrides to the copies. **Never writes the real profile.**
Anything you do not set keeps the source profile's value — including the dump
codec and `UseFFV1`, which are the consumer's choice, not ours.

Pass `dolphinPath` (to locate the real profile) or `sourceProfile` (to override
that resolution — an Electron host whose `app.getPath('appData')` disagrees).

#### Profile options

| option | default | what it does |
|---|---|---|
| `mode` | — | `"record"` (dump flags on, hotkeys detached, `PauseOnFocusLost` forced off) or `"play"` |
| `efbScale` | source | `[Settings] EFBScale`, an **enum not a multiplier**: 0 auto, 1 auto-integral, 2 = 1x native, 3 = 1.5x, 4 = 2x, 5 = 2.5x, 6 = 3x, 7 = 4x, 8 = 5x. **Always pass it** (gotcha 17) |
| `aspectRatio` | source | 6 = Force16:9, 5 = Force4:3 |
| `dumpCodec` | source | `"ffv1"` \| `"utvideo"` \| `"mpeg4"`. The real speed lever — see below |
| `dumpFormat` | `"avi"` in record mode | the container. Pinned because `record()` asserts a `<base>.avi`, and a profile left on another format fails only after a full-length run |
| `dumpFramesAsImages` | `false` in record mode | same reason |
| `texturePacks` | — | HD packs, symlinked into `<userDir>/Load/Textures/<gameSettingsId>/`; turns `HiresTextures` on |
| `texturePackMode` | `"symlink"` | `"copy"` for a host with no symlink privilege |
| `hiresTextures`, `cacheHiresTextures` | source | `cacheHiresTextures: false` suits batch recording — prefetching a huge pack per clip costs more than lazy loading |
| `sram` / `copyFromProfile` | `GC/SRAM.raw` in record mode | non-ini profile assets. SRAM is the memory card holding language and sound settings |
| `bitrateKbps` | source | mpeg4 only; stops helping past ~141 Mb/s at EFB 6 |
| `geckoIni` | copied | raw `GALE01.ini` text, written verbatim |
| `gameSettingsId` | `GALE01` | which `GameSettings/<id>.ini` to write |
| `silent` | off | `[DSP] Backend = "No audio output"`. **The WAV dump is unaffected** — it comes off the mixer before any backend. The mute for recording; never for a mirror |
| `audioBackend` | source | must be in `AUDIO_BACKENDS`; unknown values make Dolphin silently mute, so we throw |
| `audioLatencyMs` | source | `[Core] Latency`. Must not be 0 for a live feed |
| `volume` | source | **no-op on Linux** — Pulse/ALSA never implement SetVolume |
| `pauseOnFocusLost` | `false` in record mode | with `true`, a Dolphin that loses focus pauses and the run dies to the watchdog |
| `keepWindowOnTop` | source | `[Display] KeepWindowOnTop` |
| `detachHotkeys` | on in record mode | writes a `Hotkeys.ini` bound to no device, so a focus-stealing Dolphin can't eat keystrokes |
| `window` | source | `{ fullscreen: true }` or `{ width, height, x?, y? }`. **Oversize windows become 640x480** — Dolphin's own clamp, not the WM's |
| `gfxBackend` | source | `"OGL"` \| `"Vulkan"`. OGL is required for obs-vkcapture |
| `emulationSpeed` | source | `[Core] EmulationSpeed`; 1 = real time, 0 = unlimited |
| `vsync`, `shaderCompilationMode`, `msaa` | source | GFX tuning |
| `shaderCacheDir` | none | symlinks `<userDir>/Cache` here so shaders survive a throwaway dir. **Per instance** — a shared cache corrupts |
| `freshProfile` | off | build from empty inis instead of copying the real profile |
| `sourceProfile` | resolved | override where the real profile is |

`BACKGROUND_RECORD` is a preset to spread in: `pauseOnFocusLost: false`,
`keepWindowOnTop: false`, `vsync: false`, `window: { width: 640, height: 360 }`.

**Codec, the real speed lever.** Dolphin encodes on one thread and that thread
is the recording speed limit (measured; `docs/background-and-mute.md`):
`ffv1` is lossless but 0.77x realtime at native and **0.10x at EFB 6**;
`utvideo` is ~bit-exact and 0.81x at EFB 6 but needs an even dump width (so it
is refused at `efbScale: 2`, which is 939 wide) and writes ~12 GB per 75 s game;
`mpeg4` is lossy and fast. `h264` is refused — it drops the last ~50 frames.

#### Run options (`record` and `obsMirror`)

| option | default | what it does |
|---|---|---|
| `userDir` | — | **REQUIRED.** The dump path is a property of the user dir, so two Dolphins sharing one silently overwrite each other's frames |
| `display` | inherited | `DISPLAY` for the GL context |
| `env` | — | extra environment; the named options below win over it |
| `audioSink` | — | sets `PULSE_SINK` **and** `PIPEWIRE_NODE` (the ALSA backend ignores the former) |
| `appName` | — | `application.name` for the audio stream. WirePlumber remembers volume/mute **by that name**, and every Dolphin is otherwise `dolphin-emu` — hand-mute one and every future Dolphin starts muted |
| `placement` | — | `{ workspace, required?, restoreFocus?, timeoutMs? }` — see below |
| `signal` | — | `AbortSignal`; aborting SIGKILLs the tree |
| `onFrame` | — | `(current, end)`, record only. **Return `"stop"`** to end here and keep the footage: SIGTERM, resolves with `stoppedEarly: true`. Do not use an abort for that — an abort SIGKILLs (no `.avi` index) and rejects |
| `onSpawn` | — | `(pid) => void`, once, as soon as there is a pid |
| `onWarning` | — | `(w: RunnerWarning) => void` — things skipped but not fatal |
| `bootStallMs` | `90000` | no first frame within this = hung boot. Must cover Dolphin start + ISO load |
| `frameStallMs` | `30000` | frames stopped this long mid-record = frozen |
| `hardTimeoutMs` | off | absolute wall-clock cap. The stall windows only catch **silence**; a Dolphin printing frames forever never trips them. SIGTERMs and **resolves** with `stalled: true`, `reason: "hard-timeout"` |
| `commPath` | `<outDir>/comm.json` | record only. **Override it when several recordings share an `outDir`** — the default name is fixed, so workers overwrite each other's comm and each records the other's replay |
| `lastFrame` | read from the file | record only; when you already know the length |
| `startFrame` | `-123` | record only; the pre-GO! lead-in |
| `endFrame` | the `.slp`'s | record only. **Must be finite** or Dolphin idles forever |
| `baseName` | `"dump"` | record only; `<baseName>.avi` / `.wav` |

#### Placement (Linux/X11)

`placement: { workspace }` parks **this** Dolphin's windows on an EWMH
workspace (0-based: GNOME's "Workspace 10" is `9`), finding them **by pid**.
Never by title — every Playback window is WM_CLASS `AppRun.wrapped` with the
same title, which is how the copy-pasted parkers grabbed each other's Dolphins.

It can also shape the window, which is the **only** way to get a surface bigger
than Dolphin will open on its own (it clamps an oversize window to 640x480
itself — see `ProfileOptions.window`):

```ts
placement: {
  workspace: 9,
  undecorate: true,                              // a titlebar costs you 37px of capture
  geometry: { width: 1920, height: 1080 },       // x/y default to the monitor's origin
  monitor: "landscape",                          // or an output name like "DP-2"
}
```

Measured 2026-10-09 on GNOME: **1920x1080 on a 1920x1080 display**, against a
640x480 control in the same session. Decorations are stripped before the
resize — the other order leaves the client area a titlebar short.
`monitor: "landscape"` is for a rig whose primary is a rotated portrait panel.

Non-fatal by default: no `xdotool`/`x11-utils`, no window manager, a missing
workspace or a non-Linux host produces an `onWarning` and a `"skipped"` report,
and the Dolphin runs unparked. `required: true` refuses to spawn instead.
`restoreFocus` (default `true`) hands focus back afterwards, only to a window
on your current workspace so it can never switch workspaces on you.

The report: `{ workspace, status, windows }` where `status` is `"placed"`
(all mapped windows are there), `"partial"` (the WM left some elsewhere —
also warned), `"none-found"` (nothing mapped before the timeout) or
`"skipped"`. Needs `xdotool` and `x11-utils`; `checkPlacement()` is the
preflight if you want to know before you spawn.

`placeWindows(pid, opts)` is the same thing standalone, for a caller that
spawns Dolphin itself.

#### Helpers

| | |
|---|---|
| `dolphinStatus(paths)` / `dolphinConfigured(paths)` | why we can't run, as a human sentence, or `null` |
| `lastFrameOf(slp)` | last frame from the UBJSON footer — a byte scan, no slippi-js |
| `healRealProfile(dolphinPath)` | the one deliberate write to the real profile: force its dump flags off, to undo damage from older in-place versions |
| `writeMirrorComm(path, slp)` / `writeComm` / `buildComm` | the comm file Dolphin reads |
| `pidTree(pid)` / `killTree(pid, graceful?)` | the tree walk and the kill. `graceful` = SIGTERM then SIGKILL |
| `recordEnv`, `obsMirrorEnv`, `obsMirrorArgs`, `appNameProp` | exactly what gets spawned, pure and unit-tested |
| `parseFrameLine`, `reachedEnd`, `foldEnd` | the `--cout` rules, pure and unit-tested |
| `setInSection`, `setEverywhere`, `getInSection` | the ini editor (`setInSection` creates a missing key *and* section) |
| `resolveRealProfile`, `realProfileRoot`, `profileAt`, `appDataPath` | where a profile lives, per OS |
| `AUDIO_BACKENDS`, `NULL_AUDIO_BACKEND`, `BACKGROUND_RECORD`, `DEFAULT_GLCAPTURE_LIB` | constants |

## CLI (for non-Node consumers)

Three subcommands. `record` builds the profile too, so a Python or shell
consumer needs no Node shim; `play` previews a range on screen:

```sh
dolphin-runner record \
  --dolphin <AppImage> --iso <melee.iso> --slp <game.slp> \
  --out <dir> --user-dir <dir> --efb-scale 2 \
  [--comm <path>] [--base-name dump] [--display :1] \
  [--start-frame -123] [--end-frame N] [--last-frame N] \
  [--dump-codec ffv1|utvideo|mpeg4] [--bitrate-kbps N] [--aspect-ratio 6] \
  [--texture-pack <dir> ...] [--gecko-ini <file>] [--silent] [--background] \
  [--hard-timeout-ms N] [--shader-cache <dir>] [--fresh-profile] \
  [--workspace N [--undecorate --geometry 1920x1080 --monitor landscape]]
```

```sh
dolphin-runner play \
  --dolphin <AppImage> --iso <melee.iso> --slp <game.slp> --user-dir <dir> \
  [--start-frame 1000] [--end-frame 1600] [--no-batch] [--hide-seekbar]
```

Events on stdout, one JSON line each: `started`, `progress`, `warning`,
`placed`, `result` (with `avi`, `wav`, `lastFrame`, `stalled`, `stoppedEarly`),
`error`. Exit code is non-zero on failure.

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
