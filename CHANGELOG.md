# Changelog

Versions are what a consumer pins. Every entry says what BREAKS first, because
consumers load this package from disk and a silent behaviour change is the
failure mode this package exists to prevent.

Until 1.0 the minor is the breaking digit: `0.x.0` may break, `0.x.y` never does.

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
