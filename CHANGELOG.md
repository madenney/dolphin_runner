# Changelog

Versions are what a consumer pins. Every entry says what BREAKS first, because
consumers load this package from disk and a silent behaviour change is the
failure mode this package exists to prevent.

Until 1.0 the minor is the breaking digit: `0.x.0` may break, `0.x.y` never does.

## 0.5.1 — 2026-10-10

**Added**

- **`play()` and `dolphin-runner play`** — a frame range on screen with no
  dump. The package had two launch shapes and needed three: `record()` dumps
  and runs hidden in batch, `obsMirror()` wants OBS capture env and a mirror
  comm with no frame range. A clip PREVIEW is neither, and lm-clipper has two
  spawn sites that are exactly it (its preview window and "Test Dolphin").
  Without this, the first project due to migrate would have had to stop and
  ask for it.

  It keeps `--cout`, so playback stops on the same numeric end-frame rule
  `record()` uses rather than the 1-second no-frame timer the consumer was
  using to guess that a clip had finished. It passes no `-o` and no
  `--output-directory` — a preview that quietly dumped frames would fill a
  disk behind the operator — and that is pinned by a test.
- `playArgs()` exported, pure and tested, alongside `obsMirrorArgs`/`recordEnv`.

Proven by hand against a real Dolphin: frames 1000→1600 of a real replay,
stopped at the end frame, no dump written, no leaked processes.

## 0.5.0 — 2026-10-09

Closing the gaps between what the package offered and what its five consumers
actually do. Every item here replaces a workaround somebody was already
carrying; `MIGRATING.md` §8 names which project and which lines to delete.

**Added**

- **`RecordOptions.commPath`.** The comm file was always `<outDir>/comm.json`,
  a fixed name — and two consumers run N workers against one shared `outDir`,
  where that means worker B overwrites A's comm between the write and
  Dolphin's read and each silently records the other's replay.
- **A raw event-stream fallback in `lastFrameOf`**, plus `RecordOptions.lastFrame`,
  plus `endFrame` as a last resort. `record()` used to hard-fail on a replay
  whose metadata carried no `lastFrame` even when the caller supplied the
  range; a consumer worked around that by **rewriting the replay file** with a
  patched footer. Verified against 429 real replays: 428 identical to the
  footer, one 1 frame higher. `lastFrameFromFooter` / `lastFrameFromEvents`
  are exported for anyone who wants one specifically.
- **`RunOptions.hardTimeoutMs`** — an absolute wall-clock cap. The stall
  windows only catch *silence*, so a Dolphin that keeps printing frames but
  never reaches the end never tripped them, and two consumers each bolted
  their own timer on. It SIGTERMs (so the `.avi` finalises) and **resolves**
  with `stalled: true` and `diagnostic.reason === "hard-timeout"`.
- **`onFrame` can return `"stop"`** — end the dump here and keep the footage.
  A consumer wanting N frames around one moment had to abort instead, which
  SIGKILLs (no `.avi` index) and rejects, then rebuild the path by hand.
  `RecordResult.stoppedEarly` says it happened.
- **Placement can shape the window**: `geometry`, `undecorate` and `monitor`
  (an output name, or `"landscape"`). This is the only way to get a surface
  bigger than Dolphin will open — it clamps an oversize window to 640x480
  itself. Measured 2026-10-09: **1920x1080 on a 1920x1080 display, against a
  640x480 control**. Decorations are stripped before the resize; the other
  order leaves the client area a titlebar short, which is what a capture grabs.
  This was the last thing blocking MST from deleting its title-matching parker.
- **Profile options** `texturePacks` / `texturePackMode` / `hiresTextures` /
  `cacheHiresTextures` (two consumers hand-copied packs into
  `Load/Textures/<gameId>/` and rewrote the ini we had just written),
  `sram` / `copyFromProfile` (two consumers shelled out to `cp GC/SRAM.raw`),
  and `dumpFormat` / `dumpFramesAsImages`.
- **`dolphin-runner record`** — the CLI's second subcommand, profile build
  included, so a Python or shell consumer needs no Node shim. Events:
  `started`, `progress`, `warning`, `placed`, `result`, `error`.
- `StallDiagnostic.reason` distinguishes `"boot-stall"`, `"frame-stall"` and
  `"hard-timeout"`.

**Fixed**

- `EFBScale` is now written in **every** section. Ishiiruka keeps a second one
  under `[Hacks]`, and two consumers independently patched all occurrences
  after calling `buildProfile` because leaving them disagreeing dumps at the
  wrong internal resolution.
- Record mode pins `DumpFormat=avi` and `DumpFramesAsImages=False`. `record()`
  asserts a `<base>.avi`, so a source profile left on another container failed
  only *after* a full-length run, as "produced no video".
- The event-stream scan stops at the UBJSON metadata key instead of running to
  EOF. Walking into the footer read its bytes as a frame event — a fixture
  produced "frame 5572717", which as an `endFrame` is a Dolphin that never
  reaches it and hangs. Caught by its own test before it ever shipped.

**Corrected**

- Gotcha 20 was too pessimistic. The 640x480 clamp is real and is Dolphin's
  own, but it only governs what Dolphin *opens*; undecorating and
  moveresizing the managed window afterwards gets the full surface.
  `{ fullscreen: true }` is no longer the only 1:1 option on a 1080p display.

## 0.4.0 — 2026-10-09

Running Dolphin in the background: window parking, mute, codec and focus
options. Researched and measured 2026-10-08/09; the evidence for every claim is
`docs/background-and-mute.md`.

**Breaking**

- **`mirror()` is removed.** The batch-mode live-playback function. `obsMirror()`
  replaced it and nothing imported it. If you did: `obsMirror()` takes a
  `commPath` you own and returns a handle, instead of resolving on exit.
- **`obsMirror`'s default `emulationSpeed` is now `1` (was `0`).** At `0` a
  mirror pointed at a finished or partly-written replay fast-forwards on air
  with crackling audio. MST always passed `1` explicitly and is unaffected.
  Pass `emulationSpeed: 0` to keep the old behaviour.
- **`audioBackend` is now a checked enum** (`AudioBackend` / `AUDIO_BACKENDS`),
  not `string`. Dolphin silently falls back to *no audio* on any value it does
  not recognise, so a typo used to mute a run with no warning; it now throws.
- **`gfxBackend` narrowed** to `"OGL" | "Vulkan"`. Playback on Linux has no
  software or null renderer, so the other two were never real.

**Added**

- `placeWindows(pid, …)`, `checkPlacement()` and `RunOptions.placement` —
  park one process tree's windows on an EWMH workspace, found **by PID**. Every
  Playback window is WM_CLASS `AppRun.wrapped` with the same title, so the
  title-matching parkers copy-pasted around the other projects grabbed each
  other's Dolphins. Non-fatal by default: no X tools, no WM or not Linux gives
  an `onWarning` and a `"skipped"` report, and the run proceeds. `required: true`
  refuses to spawn instead.
- Profile options `silent`, `pauseOnFocusLost`, `keepWindowOnTop`,
  `detachHotkeys`, `dumpCodec`, and the `BACKGROUND_RECORD` preset.
- Run options `env`, `audioSink`, `appName`, `onWarning`.
- `recordEnv()`, `appNameProp()`, `AUDIO_BACKENDS`, `NULL_AUDIO_BACKEND`,
  and the `PlacementOptions` / `PlacementReport` / `RunnerWarning` types.
- `RecordResult.placement` and `ObsMirrorHandle.placement`.
- CLI: `--workspace`, `--placement-required`, `--detach-hotkeys`, `--app-name`,
  and the `warning` and `placed` events.

**Fixed**

- `killTree` on Windows attached no `error` handler to its `taskkill` spawn. A
  missing `taskkill` is an **async** event that `try/catch` never sees, and
  unhandled it would crash the host process.

**Corrected** (we had these wrong; `efbScale` and gotchas 19/20 changed meaning)

- `efbScale` is an **enum, not a multiplier**: 2 = 1x native, 7 = 4x.
- A blank `[Core] GFXBackend` resolves to **OGL**, not Vulkan. Still forced, so
  a profile someone left on Vulkan cannot win.
- The oversize-window 640x480 clamp is **Dolphin's own**
  (`DolphinWX/FrameTools.cpp:679-689`), not the window manager's — reproduced
  with no WM at all.
- Never change the dump codec behind the consumer's back (gotcha 5, rewritten).
  Dolphin encodes on one thread and that thread is the speed limit: FFV1 is
  0.77x realtime at native and **0.10x at EFB 6**; `utvideo` is ~bit-exact and
  0.81x at EFB 6 but needs an even width; `mpeg4` stops improving at ~141 Mb/s.
  `h264` is refused — it drops the last ~50 frames at SIGTERM.

## 0.3.0 — 2026-10-08

`obs-mirror` parity with MST's own launcher, so MST can delegate to the CLI.

- `freshProfile` — build the `--user` dir from empty inis instead of copying the
  real Playback profile, which is what MST's legacy launch did.
- `msaa` (and SSAA off), `gfxBackend`, `gameSettingsId`, and `--no-capture`
  (`OBS_VKCAPTURE=0`, no `LD_PRELOAD`).
- `RunOptions.onSpawn(pid)` — hands the pid out as soon as there is one, so a
  consumer can park the window without `pgrep`.

## 0.2.0 — 2026-09-19

- `obsMirror()` and the `dolphin-runner obs-mirror` CLI: a long-lived,
  OBS-capturable Dolphin for a stream tool, reproducing MST's spawn (env, ini
  keys, comm format, no `-b`). Config is written **only** into the throwaway
  `--user` dir; the shared profile is never touched.
- `buildMirrorComm()` / `writeMirrorComm()` — the caller re-points a running
  mirror by rewriting the comm file; nothing here watches anything.
- `buildProfile` gained the live-window tuning: `gfxBackend`, `audioLatencyMs`,
  `emulationSpeed`, `audioBackend`, `volume`, `window`, `vsync`,
  `shaderCompilationMode`, `shaderCacheDir`.
- `bin` + `prepare`, so a `file:`/git consumer gets a built `dist/` on install.

## 0.1.0 — 2026-09-18

The extraction: one tested implementation of a recipe that had been
copy-pasted across five projects, merged from `jungle_media`'s runtime half and
`lm-clipper`'s profile half. Each had bugs the other had already fixed; both
are fixed here, with regression tests named after the bug.

- `record()`, `buildProfile()`, `healRealProfile()`, `dolphinStatus()`,
  `lastFrameOf()`, `pidTree()`/`killTree()`, the comm, frames and ini helpers.
- `npm run smoke` — the only end-to-end test. First passing run 2026-09-18:
  4383-frame replay, AVI 75.07 s vs 75.10 s expected, nothing leaked, real
  profile byte-identical.
