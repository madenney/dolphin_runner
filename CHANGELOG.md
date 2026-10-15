# Changelog

Versions are what a consumer pins. Every entry says what BREAKS first, because
consumers load this package from disk and a silent behaviour change is the
failure mode this package exists to prevent.

Until 1.0 the minor is the breaking digit: `0.x.0` may break, `0.x.y` never does.

## 0.5.8 — 2026-10-15

Hidden recording. Measured on the Windows rig (Windows 11, NVIDIA, Playback 3.5.2)
and on Linux (X11, GNOME).

**May affect you**

- **Windows `hide: true` now runs Dolphin on a hidden desktop** through the
  bundled `lunar-hidden-launcher.exe`, the same as `"desktop"`. The plain hidden
  window (`windowsHide` + RenderToMain) is gone: taskkill's polite stop never
  reaches a hidden window, so every dump was force-killed unindexed. With no
  launcher the run records in a visible window and warns
  `hide-desktop-unavailable` (it used to fall back to the hidden window).
- **`hide` pins `GFXBackend=OGL` on Windows, not DX11.** DX11 dumps drop frames
  (3240 of 3600 at 0.78x, WAV 5.9 s longer than the video), visible or hidden.
- **The graceful stop waits 15 s on Windows before forcing** (`stopGraceMs`,
  default `defaultStopGraceMs()`; 5 s elsewhere, as before). With 4 Dolphins
  stopping at once, exit after a finalised dump took 8-14 s at times.
- **Record mode writes `Logger.ini`**: file log on, `[Logs] VIDEO`, verbosity
  3. Opt out with `dumpLog: false`.

**New**

- **`hide` option for record mode** (`true | "window" | "desktop"`, or spread
  `HIDDEN_RECORD` into both `buildProfile` and `record()`); `RecordResult.hide`
  reports what it achieved. Windows: a hidden desktop via the bundled
  `native/win/bin/lunar-hidden-launcher.exe` (`hideLauncherPath` to point at an
  unpacked copy). Linux: parks the windows by pid on the last workspace (EWMH),
  sway scratchpad or a Hyprland special workspace. macOS: an LSUIElement copy of
  the app hidden by pid (unverified, no Mac yet). `placement.workspace` takes `"last"`.
- "Produced no video" names the dump codec and quotes Dolphin's AVIDump log
  (`err.dumpCodec`, `err.dumpLog`); `dump-codec-fallback` warning when Dolphin
  swapped an unknown codec name for mpeg4.
- `RecordResult.forcedStop` (the grace ran out) and `wavRepaired` (the WAV's
  RIFF/data sizes, written only after the video backend shuts down, were
  rewritten from its length). `repairWavHeader()` is exported.

## 0.5.7 — 2026-10-13

Diagnosis and cross-platform fixes. Every new result field is additive; the
API and the CLI contract are otherwise unchanged.

**May affect you**

- **`dolphinStatus` now says no on Linux when neither `DISPLAY` nor
  `WAYLAND_DISPLAY` is set.** `record()`, `play()` and `obsMirror()` pass
  their own `display` and `env`, so they are fine. A consumer that preflights
  with `dolphinStatus(paths)` from a process with no DISPLAY, and only hands
  `display` to `record()`, must now pass it to the preflight as well:
  `dolphinStatus(paths, { display })`. It also now refuses a `dolphinPath`
  that is not executable or is a directory; both used to fail at spawn instead.
- **`[Interface] ConfirmStop = False` is written into every built profile**,
  record and play, fresh or copied. It was inherited before. A preview or
  mirror stopped by the runner never wanted the dialog.
- **`record()` and `play()` wait up to 500 ms after Dolphin exits** for the
  last of its stdout/stderr, so the tail includes the line that says why it
  died. They do not wait for the pipes to close, which the AppImage FUSE
  daemon can hold open for seconds (gotcha 18).

**Added**

- **How Dolphin exited, on every result.** `RecordResult` and `PlayResult` now
  extend `ExitInfo`: `exitCode`, `exitSignal`, `stdoutTail`, `stderrTail` (the
  last ~60 lines each, frame spam excluded). Both used to be discarded.
- **`diagnostic.reason: "early-exit"`.** Dolphin exited by itself before
  printing a single frame — a startup crash or refusal. It used to resolve
  `{ stalled: false, diagnostic: null }`, exactly like success. `stalled`
  stays false; `StallDiagnostic` gains optional `exitCode`/`exitSignal`.
  A Dolphin that exits by itself after printing frames is not flagged (a batch
  Dolphin may stop a frame short of the end we compare against).
- **"Dolphin produced no video" says why.** The rejection is a
  `DolphinRunError`: the message starts exactly as before, then adds the exit
  and the last 8 stderr lines; `code: "no-video"`, `replay`, `exitCode`,
  `exitSignal`, `stdoutTail`, `stderrTail` and `diagnostic` are properties.
  The CLI's `error` event carries the same fields, and its `result` event the
  new `ExitInfo` fields. This is the case gotcha 16 says cannot tell
  contention from a bad profile — it now has evidence attached.
- **`dolphinStatus` catches startup failures without launching**: not
  executable (with the `chmod +x`), a directory or an `.app` with nothing to
  run, and a Linux AppImage with no `libfuse.so.2` (install libfuse2, or set
  `APPIMAGE_EXTRACT_AND_RUN=1`). Takes `{ platform?, env?, display? }`.
  `isAppImage`, `hasLibfuse2` and `LIBFUSE2_PATHS` are exported.
- **macOS app bundles.** `resolveDolphinExecutable(dolphinPath)` turns
  `Slippi Dolphin.app` into `Contents/MacOS/<CFBundleExecutable>` (falling
  back to the only file there); every spawn and `dolphinStatus` use it.
  `realProfileRoot(dolphinPath, "Darwin")` reads the bundle's
  `Contents/Resources/User`, where Slippi's mac Playback keeps its profile, and
  falls back to `~/Library/Application Support/SlippiPlayback` only when that
  folder is absent. `appBundleOf` is exported. **Unverified on a real Mac.**
- **Spawn env hygiene.** A consumer that itself runs as an AppImage handed
  Dolphin its `APPDIR`/`APPIMAGE`/`ARGV0`/`OWD`, and a `PATH`/`LD_LIBRARY_PATH`
  led by its own bundle. `stripAppImageEnv` drops those variables and only the
  `$APPDIR` entries of the two lists; `recordEnv` and `obsMirrorEnv` apply it
  to the inherited env, before the caller's `env`.

**Fixed (Windows, unverified at runtime)**

- **A graceful kill was a hard kill.** `killTree(pid, true)` ran
  `taskkill /T /F` on Windows, so a recording that reached its end frame was
  terminated mid-write and AVIDump never finalised the file. Graceful is now
  `taskkill /T` (WM_CLOSE), escalating to `/T /F` after `escalateMs` if the
  process is still there; with `ConfirmStop = False` (above) Dolphin closes
  instead of asking. taskkill is spawned with `windowsHide`. `killTree` takes
  an optional 4th argument, `KillDeps`, to inject the platform;
  `taskkillArgs` is exported.
- **`shaderCacheDir` was ignored on Windows.** It is now a directory junction
  there, as texture packs already were, and still best-effort. The "is the
  link current?" check tolerates the `\\?\` prefix Windows reads junctions
  back with (`sameLinkTarget`, exported). The link target is now always
  absolute on every platform.

## 0.5.6 — 2026-10-11

No code changed. Finishes 0.5.5: that pass left two private commit hashes in the
0.5.2 entry and a garbled phrase in two places. **Pin this instead of 0.5.5** —
there is no reason to install 0.5.5, which is identical in behaviour and worse
in content.

## 0.5.5 — 2026-10-11

No code changed — `src/` behaviour, the CLI contract and the API are identical
to 0.5.4. Tagged because `docs/` and the doc comments ship in the package, and
until this tag every published version carried things a public repo should not:

- A tracked `undefined/play/user/Config/` — a verbatim copy of a real Dolphin
  profile, committed by a broad `git add -A` when a hand-run with an unset env
  var built a profile under the literal string. It is removed, and `undefined/`
  is gitignored with a comment naming the mistake.
- Machine paths in `scripts/smoke.ts`. The ISO and the replay are now required
  env/argv with a usage message instead of hardcoded paths, so the harness is
  runnable by anyone rather than only on one box.
- Per-project migration notes and handoff prompts that mapped private consumer
  repos by file and line (`MIGRATING.md` §8 and `docs/handoff-prompts.md`).
  Both now live outside the repo; `MIGRATING.md` keeps §1-§7, which is the part
  an adopter needs.
- Hostnames, and the names of the consuming projects, throughout the docs and
  the code comments. They read as roles now — a VOD recorder, a clip tool, a
  skins tool, an archiver, a stream tool. The reasoning in those comments was
  always the point, not whose repo shipped the bug.
- `files` shipped all of `docs`; it now names the one document meant to be
  published, so nothing local can escape through a future `.npmignore`.

`test/mst-parity.test.ts` is now `test/stream-tool-parity.test.ts`. Nothing
imports it, so this affects only someone running a single test file by name.

## 0.5.4 — 2026-10-11

**Fixed**

- **`obs-mirror` did not accept `--undecorate`, `--geometry` or `--monitor`.**
  They were added to `record` and `play` in 0.5.0 and missed on `obs-mirror` —
  the one subcommand the window-shaping work existed for, since the stream tool needs an
  undecorated 1080p surface on a landscape output and its primary is a rotated
  portrait panel. The CLI exited with `Unknown option`, so the documented
  recipe in the handoff prompt could not work. Caught by the stream tool's own test, which
  had pinned the broken behaviour as expected (2026-10-11).

  Verified against a real Dolphin after the fix: `obs-mirror … --workspace 0
  --undecorate --geometry 1920x1080 --monitor landscape` produced a
  **1920x1080** render surface and reported `placed`.

  `test/cli-flags.test.ts` now asserts every subcommand that can park a window
  also accepts the flags that shape it, and that the shaping flags are refused
  rather than ignored without `--workspace`.

## 0.5.3 — 2026-10-10

Documentation only — no code changed. Tagged so consumers pinning a version
get the corrected guidance, since `docs/` ships in the package. All of it came
from the skins tool's v0.4.0 → v0.5.1 upgrade (verified
byte-identical, audio and video).

**Measurements** (`docs/background-and-mute.md`), RTX 5080 + i9-12900K:

- **EFB 3 (1408x792)**, the gap between the measured points: FFV1 0.50× at
  either emulation speed (encoder-bound), utvideo 0.99× → **1.27×** with
  `emulationSpeed 0`, mpeg4 0.99× → **1.28×** and the same at 20 and 60 Mb/s.
- **At EFB 3 the ceiling is emulation, not the encoder.** Both non-FFV1
  codecs stop at ~1.27×, so lossy buys nothing over lossless at that size:
  **mpeg4's speed advantage is a native/low-resolution thing.**

**Corrections**

- "`emulationSpeed 0` only helps when the encoder is not the bottleneck" was
  about *throughput*. It also shortens **boot**, whatever the codec: first
  frame 3.8 s → 1.1 s, and a 20-frame dump 6.0 s → 3.6 s. That dominates short
  dumps — stills, desync checks, stage shots.
- "utvideo is bit-exact to FFV1 after 4:2:0" holds only if you do **not scale
  first**. FFV1 dumps are bgra, so a consumer upscaling before encode
  subsamples chroma after scaling while utvideo was subsampled at dump size;
  the finals differ by ~44 dB. "Bit-exact" describes the dump, not your output.
- `MIGRATING.md` §6 still said there was no `record` subcommand. It shipped in
  0.5.0; §6 now shows `record` and `play`, and says that keeping a thin Node
  shim is a fine end state when your driver ignores the progress events.

**Install traps**, both reproduced here and now in `MIGRATING.md` §1 and the
README:

- **Bumping a pin needs an explicit `npm install "github:…#vX.Y.Z"`.** Editing
  the tag in `package.json` and running `npm install` keeps the old commit,
  because the lockfile still satisfies it — so §5's byte-identical check would
  pass without the upgrade ever happening.
- **npm's `allow-scripts` warning about `prepare` is harmless.** The reported
  reason was wrong — `dist/` is *not* committed — but the outcome is right:
  npm runs the build while packing the git ref, so `dist/` is already in
  `node_modules`. Do not remove `prepare` to silence it; that script is what
  produces `dist/` for git installs.

## 0.5.2 — 2026-10-10

Everything here was reported by the first consumer to go end to end on this
package, after migrating both of its apps.

**Added**

- **`RecordOptions.batch`** (default true). `record()` always passed `-b`, so
  a consumer whose "fullscreen" toggle meant "leave the window up" had no
  equivalent on the record path — `play()` had one, `record()` didn't.
- **`dumpCodec: "default"`** — force `UseFFV1 = False` and leave `DumpCodec`
  EMPTY, which is Dolphin's per-container default. Previously there was no way
  to reproduce a profile that never had a `DumpCodec` line, and a consumer's
  byte-for-byte verification needed a manual blanking step to pass.
- **`texturePacks` accepts `{ path, name }`**, and bare paths whose basenames
  collide are now disambiguated with a `-2` suffix instead of silently
  replacing each other. `GALE01` is a common pack folder name, so this
  happened in practice. Dolphin searches the tree recursively, so the folder
  name is organisational and a suffix is safe.
- A top-level `"types"` field in `package.json`, so a consumer on
  `moduleResolution: node10` does not need a hand-written `.d.ts` re-export.
- `recordArgs()` exported, pure and tested, alongside `playArgs`.

**Measurements** folded into `docs/background-and-mute.md`, from a consumer's rig
(RTX 3060) — these settle the EFB 4 caveat the handoff prompts carried:

- EFB 4: FFV1 0.34× realtime, **utvideo 1.81×** (5.3× faster, bit-identical
  after 4:2:0 on 3465/3504 frames), mpeg4 150 Mb/s 1.66× at 42.3 dB. utvideo
  works at EFB 4 (1878 is even) and is the clear choice there.
- Native: FFV1 ~0.95×, mpeg4 40 Mb/s ~4×. The native FFV1 figure is higher
  than the 0.77× measured here on a 5080 — the encoder is CPU-bound, so it
  tracks the CPU rather than the GPU.
- **Dumps are not frame-count stable across codec and speed**: 3504–3534
  frames of an expected 3600 for the same range. The "dumps are
  deterministic" assumption holds *within* a configuration, not across them,
  so a byte-comparison must hold codec and speed fixed and a duration guard
  should use a ratio rather than an exact frame count.

## 0.5.1 — 2026-10-10

**Added**

- **`play()` and `dolphin-runner play`** — a frame range on screen with no
  dump. The package had two launch shapes and needed three: `record()` dumps
  and runs hidden in batch, `obsMirror()` wants OBS capture env and a mirror
  comm with no frame range. A clip PREVIEW is neither, and the clip tool has two
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
carrying; the per-project notes (which project, which lines to delete) are kept
outside this repo.

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
  This was the last thing blocking the stream tool from deleting its title-matching parker.
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
  with crackling audio. The stream tool always passed `1` explicitly and is unaffected.
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

`obs-mirror` parity with the stream tool's own launcher, so the stream tool can delegate to the CLI.

- `freshProfile` — build the `--user` dir from empty inis instead of copying the
  real Playback profile, which is what the stream tool's legacy launch did.
- `msaa` (and SSAA off), `gfxBackend`, `gameSettingsId`, and `--no-capture`
  (`OBS_VKCAPTURE=0`, no `LD_PRELOAD`).
- `RunOptions.onSpawn(pid)` — hands the pid out as soon as there is one, so a
  consumer can park the window without `pgrep`.

## 0.2.0 — 2026-09-19

- `obsMirror()` and the `dolphin-runner obs-mirror` CLI: a long-lived,
  OBS-capturable Dolphin for a stream tool, reproducing the stream tool's spawn (env, ini
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
copy-pasted across five projects, merged from the VOD recorder's runtime half and
the clip tool's profile half. Each had bugs the other had already fixed; both
are fixed here, with regression tests named after the bug.

- `record()`, `buildProfile()`, `healRealProfile()`, `dolphinStatus()`,
  `lastFrameOf()`, `pidTree()`/`killTree()`, the comm, frames and ini helpers.
- `npm run smoke` — the only end-to-end test. First passing run 2026-09-18:
  4383-frame replay, AVI 75.07 s vs 75.10 s expected, nothing leaked, real
  profile byte-identical.
