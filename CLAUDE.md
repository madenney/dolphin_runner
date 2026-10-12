# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

One job: **given a `.slp` and a profile, spawn an isolated Slippi *Playback*
Dolphin and either frame-dump it or mirror it live — without hangs, leaked
processes, or mutating the user's real Dolphin profile.**

It exists because that recipe was copy-pasted across five projects — two VOD
recorders, a clip tool, an archiver and a stream tool — and every fork re-learned
the same OS-level gotchas, usually by shipping a bug first. The design doc that
started it lives with the clip tool, outside this repo; its §5 (the spawn
lifecycle) is the part to read before changing anything in `run.ts`.

**Status: standalone, and consumed.** This is its own repo again
(github `madenney/dolphin_runner`); it lived in a monorepo as
`packages/dolphin-runner` until 2026-10-08. It is not on npm — consumers install
it from a git tag (`npm i github:madenney/dolphin_runner#vX.Y.Z`) and pin it, so
changes here reach them only when they bump. Six projects spawn Dolphin: two VOD
recorders, a clip tool, a skins tool, an archiver (all migrated and pinned) and a
stream tool, which drives the `obs-mirror` CLI behind its own off-by-default flag
while its legacy launch is still the path its live events run on. Cut a tag for
anything a consumer needs; don't expect anyone to track `main`.

Background running and muting (hiding, focus, audio, codec speed) were researched
and tested 2026-10-08: `docs/background-and-mute.md`. Several gotchas below were
corrected by it (19, 20, and `efbScale` being an enum); read it before touching
window, audio or speed options.

## The extraction

This package is a MERGE of two implementations, and neither was complete:

| | from the VOD recorder | from the clip tool |
|---|---|---|
| runtime | AbortSignal, `pidTree` kill, bounded stderr tail, numeric `>=`, "a stall is a silence" | `readline` line handling, `[GAME_END_FRAME]`, two-tier stall, Windows `taskkill` |
| profile | (had none — a persistent hand-tuned dir) | throwaway `--user` builder, cross-OS resolution, heal, the tests |

**Each had bugs the other had already fixed.** The clip tool matched the end frame
by substring (`845` matches inside `8454` → truncated dumps) and killed only the
direct child on POSIX (an AppImage execs, so the emulator survives).
The VOD recorder had no `[GAME_END_FRAME]`, one coarse stall window, and no Windows
path at all. Both are fixed here, with regression tests named after the bug.

## Commands

- `npm test` — `node --test` over `test/**/*.test.ts`. **No jest, no vitest.**
  Node 22+ strips TypeScript natively, so tests run straight from source.
- One file: `node --test test/frames.test.ts`
- One test: `node --test --test-name-pattern="substring" test/frames.test.ts`
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — emits `dist/` (JS + `.d.ts`)
- `npm run check` — typecheck + test; run this before you call anything done
- `npm run smoke [replay.slp]` — the ONLY end-to-end test: records one real
  replay with a real Dolphin and checks the `.avi` length. Needs a GPU and
  `DISPLAY`; ~100 s for the default 75 s replay. See `scripts/smoke.ts` for
  env overrides. Run it after any change to `run.ts`, `kill.ts` or `profile.ts`.

## How the pieces fit

`src/index.ts` re-exports everything; there is no internal/public split, so
every helper is API. Two layers:

**Tested** (no spawn; `profile.ts` runs against a fixture profile):
- `paths.ts` — where the *real* profile lives per OS (`realProfileRoot`), and
  the ini layout of *any* profile root (`profileAt`). Takes `platform` as a
  parameter so the Windows branch is testable on Linux.
- `ini.ts` — line-level ini editing. `setInSection` creates the key if absent;
  `setEverywhere` rewrites an existing key in every section it appears.
- `frames.ts` — parses `--cout` lines (`[CURRENT_FRAME]`, `[PLAYBACK_END_FRAME]`,
  `[GAME_END_FRAME]`) and holds the end-of-replay rule (`reachedEnd`, `foldEnd`
  = earlier end wins).
- `comm.ts` — the comm.json Dolphin reads; refuses a non-finite `endFrame`.
- `slp.ts` — `lastFrameOf`, a byte scan of the `.slp` UBJSON footer.
- `profile.ts` — `buildProfile(userDir, opts)`: copy every real `Config/*.ini`
  into `userDir`, then override via `ini.ts` (GFX dump geometry, Dolphin.ini dump
  flags in `[Movie]` + `[DSP]`, verbatim `GALE01.ini`, and in record mode a
  `Hotkeys.ini` that detaches input). `healRealProfile` is the only write to the
  real profile.
- `obs.ts` (pure half only) — `obsMirrorEnv()` and `obsMirrorArgs()` are
  tested in `test/obs.test.ts`: LD_PRELOAD order, no stray colon, no `-b`/
  `--cout`/dump flags. The spawn in `obsMirror()` is not.

**Untested by the suite** (needs a process or a real Dolphin):
- `status.ts` — `dolphinStatus(paths)` → human reason or `null`. Parameterised,
  never reads env at import.
- `kill.ts` — `pidTree` (POSIX `pgrep -P` walk) and `killTree` (children first;
  SIGTERM→SIGKILL escalation when `graceful`; `taskkill /T /F` on Windows).
- `run.ts` — `runDolphin()` is the frame-watched spawn loop behind `record()`
  and `play()` (a frame range on screen, no dump — the preview shape, added
  2026-10-10; the old batch-mode `mirror()` was removed 2026-10-09).
  `recordEnv()` builds its env: inherited → `env` → `display`/`audioSink`/`appName`. `record()` = validate → write
  comm.json into `outDir` → spawn with `-i comm -o base --output-directory -b
  -e iso --user userDir --hide-seekbar --cout` → readline stdout / drain stderr
  / two-tier watchdog → resolve `{ avi, wav, lastFrame, stalled, diagnostic }`.
  The bounded stdout/stderr tails (gotcha 10) are `tailBuffer()` in `tail.ts`;
  when the watchdog fires they are snapshotted into `diagnostic` (otherwise
  `null`).
- `obs.ts` (the spawn) — `obsMirror()`: a long-lived, OBS-capturable Dolphin for a stream
  tool. `buildProfile(mode: "play", …)` with the capture tuning forced (OGL,
  Pulse, Latency 60, fullscreen, VSync off), env from `obsMirrorEnv()`
  (LD_PRELOAD shim:existing:libobs_glcapture, OBS_VKCAPTURE*, PULSE_*), no
  `-b`, no watchdog — idling on "waiting for game" is healthy. Returns a
  handle; `stop()` SIGKILLs the tree. The caller re-points it by rewriting the
  comm file (`writeMirrorComm`); nothing here watches anything.
- `place.ts` — `placeWindows(pid, …)`: park ONE process tree's windows on an
  EWMH workspace, and optionally undecorate / moveresize / pick a monitor
  (xdotool/xprop/wmctrl/xrandr, optional system tools), plus `checkPlacement`
  preflight. Its logic is unit-tested against a fake X server (`X11` is
  injected); the real behaviour was measured on GNOME — see gotcha 21.
  `record()`/`obsMirror()` take `placement: { workspace, geometry?, undecorate?,
  monitor? }`; never fatal unless `required`.
- `cli.ts` — `dolphin-runner record …`, `play …` and `obs-mirror …`, the process boundary
  for non-Node consumers (the stream tool is Rust, the skins tool and the archiver drive it
  from Python). One JSON line per event on stdout (`started`, `progress`,
  `warning`, `placed`, `result`, `stopping`, `exited`, `error`); foreground
  until Dolphin exits; SIGINT/SIGTERM/SIGHUP forwarded to the whole tree.
  `record` builds the profile too, so a shell consumer needs no Node shim.

Only `types.ts` and the doc comments describe the contract; the JSDoc on
`RunOptions`/`RecordResult` is load-bearing and is what consumers will read.

## Tests

- Tests fake the real profile by pointing `XDG_CONFIG_HOME` at a `mkdtemp` dir
  so `resolveRealProfile`'s Linux branch reads fixtures. Restore env in
  `finally`/`afterEach` — tests share a process.
- Tests are named after the bug or rule they pin (`"THE REAL PROFILE IS NEVER
  TOUCHED"`, `"a profile that has never dumped still gets the dump keys created"`).
  A regression fix gets its own test with that kind of name; don't fold it into
  an existing one.
- Nothing in `test/` spawns Dolphin. If a change touches `run.ts`, the suite
  cannot tell you it works — run `npm run smoke` and say whether you did.
- The Config inis on this machine contain a non-UTF-8 byte, so `grep` treats
  them as binary and silently prints nothing. Use `strings -e S file | grep`.

## Rules that are not negotiable

**Zero runtime dependencies.** `dependencies` is `{}` and must stay `{}`. In
particular **no slippi-js** — `lastFrameOf` is a byte scan of the UBJSON footer
because one int32 is all this package needs from a replay. Verified against 356
real replays: identical to the VOD recorder's implementation on every one.

**No Electron import, ever.** `appDataPath()` resolves config dirs by platform.
An Electron host that disagrees passes `sourceProfile` explicitly. A hard
Electron dep would lock out every non-Electron consumer.

**Scope is the spawn, not the pipeline.** IN: profile builder, comm.json, spawn,
frame-watch, stall watchdog, kill-tree, AbortSignal, cross-OS paths, and (since
2026-10-09) parking the windows of a Dolphin WE spawned — the spawner is the
only code that knows the pid tree, and the copy-pasted parkers that matched by
title grabbed other projects' Dolphins. **OUT:** ffmpeg mux/re-encode/concat,
overlay compositing, uploads, progress UI, clip selection, and touching any
window we didn't spawn. Those stay in each app. If you find yourself importing
ffmpeg here, stop.

**`record()` returns raw dump paths, never a muxed file.** It also returns
`lastFrame` so the caller can length-check the dump without re-reading the `.slp`
— that guard is the consumer's, and it needs the number.

**Imports use `.ts` extensions.** That is what Node's type stripping requires;
`tsc` rewrites them to `.js` on emit via `rewriteRelativeImportExtensions`.
Don't "fix" them to extensionless.

## The gotchas, and where they live

Each of these cost somebody an event. The comments in the code say so; keep them.

1. **Playback build, not netplay.** Different binary.
2. **`Sys/` is found relative to the binary** — a `--user` profile does not seed it.
3. **`--user` root has `Config/` and `GameSettings/` DIRECTLY.** The `User/`
   segment in a Windows *real* profile is the portable install's layout, not the
   flag's. Conflating them builds a profile Dolphin silently ignores. (`paths.ts`)
4. **Dump flags live in TWO sections** — `[Movie]` and `[DSP]` both carry audio
   dump keys. `ini.ts` has `setInSection` vs `setEverywhere` for exactly this.
5. **Never change the dump codec behind the consumer's back.** Copy-then-override
   means we inherit `UseFFV1`/`DumpCodec`/`BitrateKbps` from the source profile;
   the codec is the consumer's choice, not ours. It is a big one (measured
   2026-10-08): FFV1 is single-threaded and caps recording at 0.77× realtime at
   native and 0.10× at EFB 6; `DumpCodec = utvideo` is ~bit-exact and 8× faster
   at EFB 6 but needs an even width (fails at native 939x528); mpeg4 tops out
   ~141 Mb/s and visibly blocks at 60 Mb/s. Numbers: docs/background-and-mute.md.
6. **comm needs a FINITE `endFrame`**, or Dolphin reports `INT_MAX` and idles on
   "waiting for game" forever. `buildComm` throws rather than allow it.
7. **Numeric `>=` for the end frame.** Not `==` (a skipped frame → never kills →
   hang), never substring (`845` inside `8454` → truncation). See `frames.ts`.
8. **SIGTERM at end-of-replay** so the `.avi`/`.wav` finalise; **SIGKILL** for
   stalls and aborts.
9. **Buffer partial stdout lines.** `readline` does this; don't hand-roll it.
10. **DRAIN STDERR.** ~64KB into an unread pipe and the write BLOCKS — high CPU,
    no frames, never exits. *The* classic "random stall", random only because it
    depends on how chatty Dolphin is for a given replay. Keep the tail BOUNDED;
    accumulating the whole stream leaks across a long batch.
11. **Watchdog keys on frame progress**, not file size, and is two-tier: boot
    grace must exceed Dolphin start + ISO load (~90s), frame-stale is short (30s).
    It measures the GAP between frames, so it is length-independent.
12. **A stall is a silence, not a verdict.** Measured dumps at stall: 27%, 43%,
    70%, 94% complete. `record()` resolves with `stalled: true` and lets the
    caller's duration guard judge. Never reject on the watchdog alone.
13. **Kill the whole tree.** An AppImage execs. POSIX walks `pgrep -P`, children
    first (killing the parent first reparents the tree to init and orphans the
    process you wanted). Windows: `taskkill /T /F`.
14. **Never mutate the real profile.** Build a throwaway from a copy.
    `healRealProfile()` is the one deliberate write, forcing dump flags off to
    undo damage from older in-place versions.
15. **Per-instance `userDir` is mandatory.** The dump path is a property of the
    user dir, not the invocation — two Dolphins on one profile overwrite each
    other's frames SILENTLY, and you get footage from the wrong replay.
16. **Pin what the consumer's dump depends on, and nothing else.**
    `InternalResolutionFrameDumps` must be CREATED if absent, and record mode
    also pins `DumpFormat=avi` and `DumpFramesAsImages=False` — `record()`
    asserts a `<base>.avi`, so a source profile left on another container fails
    only AFTER a full-length run, as "produced no video". `EFBScale` must be
    written in EVERY section: Ishiiruka keeps a second one under `[Hacks]`, and
    two consumers independently patched all occurrences after calling us. The
    CODEC stays inherited (gotcha 5) — that one is the consumer's choice.
    A profile that has never dumped has none of these keys, so only CREATING
    them works; rewriting existing lines silently gives a window-resolution
    dump and nothing downstream can tell. But "produced no video" is a SYMPTOM,
    not a diagnosis: a consumer hit it three times purely from running three
    Dolphins on one box (2026-10-11), with the same profile that worked before
    and after. Rule out contention before rewriting a profile that is fine.
17. **Consumers must pass `efbScale`.** Omitting it inherits the real profile's
    value, which is whatever the user last played at. The first smoke run
    inherited `EFBScale = 7` and produced a 25 GB lossless AVI at ~4 fps for a
    75 s game. The clip tool sets it from its own config; the VOD recorder must too.
18. **The orphaned `Slippi_Playback` process is the AppImage FUSE daemon, not
    the emulator.** The runtime `exec`s into `AppRun.wrapped` (= `dolphin-emu`),
    so the emulator IS our direct child and `killTree` reaches it. The daemon
    `setsid()`s, holds the `/tmp/.mount_Slippi*` mount, and exits on its own a
    few seconds after the emulator. Don't count it as a leak and don't kill it.
19. **`[Core] GFXBackend` must be `OGL` for OBS capture, and CREATED if
    absent.** obs-vkcapture's GL path preloads `libobs_glcapture.so`, which
    hooks `glXSwapBuffers`; a Vulkan Dolphin makes no GL swaps and OBS shows
    black. Force it anyway: a blank value resolves to OGL in this build
    (measured 2026-10-08 by mapped libs; the old "blank is Vulkan" note was
    wrong), but a profile someone set to Vulkan stays Vulkan. Slippi's stock ini also carries `GFXBackend` and
    `EmulationSpeed` under `[Movie]` — those are movie metadata, ignore them;
    `[Core]` is the live one.
20. **A windowed render larger than the display's work area becomes 640x480 —
    but placement can undo it.** The clamp is Dolphin's OWN
    (`DolphinWX/FrameTools.cpp:679-689`, size + WM decoration vs the work area
    of the output-tied RandR monitor), not mutter's — reproduced with no WM at
    all. The ini route therefore cannot give you a 1:1 1080p surface on a 1080p
    display. Going around it AFTER the WM takes the window does:
    `placement: { undecorate: true, geometry: { width: 1920, height: 1080 } }`
    measured **1920x1080** on a 1920x1080 GNOME display, against a **640x480**
    control in the same session (2026-10-09). Decorations must be stripped
    BEFORE the resize or the client area is a titlebar short (1920x1043), which
    is what a capture grabs. `monitor: "landscape"` picks the output, for a rig
    whose primary is a rotated portrait panel.
21. **Park by PID, and never trust a property you wrote.** Every Playback
    window is WM_CLASS `AppRun.wrapped` with the same title, so only the pid
    tells instances apart — title matching grabbed other projects' Dolphins.
    On mutter, Dolphin's windows are already managed when first found (~330 ms
    after spawn), so the pre-map `_NET_WM_DESKTOP` trick rarely wins. Writing
    that property onto a MANAGED window does nothing, but reading it back
    returns your own write: the first parker reported "placed" while the
    windows sat on the user's screen for a whole run (2026-10-09). And
    `IsViewable` is no ground truth either — mutter keeps windows on other
    workspaces mapped; `WM_STATE` Iconic is what "hidden" looks like. Measured
    on GNOME: ~0.6 s visible, then hidden; mutter lands the move ~0.4 s late
    whatever you send. A parked Dolphin KEEPS keyboard focus until something
    else takes it — `restoreFocus` hands it back (~1 s), only to a window on
    the user's current workspace so it can't switch workspaces on them.
    Openbox (the event box) is untested.

## Known unfinished

- **`obsMirror()` is the mirror.** The stream tool's spawn
  (a Rust/Tauri app, outside this repo) was read 2026-09-19 and
  `obsMirror` reproduces it: same env, same ini keys, same comm format, no
  `-b`. Differences on purpose: profile is copy-then-override (the stream tool wrote into a
  bare dir), LD_PRELOAD is composed directly instead of via the
  `obs-gamecapture` wrapper, and it never writes the shared profile. Proven by
  hand 2026-09-19: OBS "Dolphin 2" vkcapture source rendered the instance at
  1920x1080 via GL (no libvulkan mapped), Pulse routed to `game2` under the
  shim's name. NOT yet proven: a live, growing `.slp` (only a finished one was
  available); that path is the stream tool's comm-rewrite loop, unchanged. Re-pointing a
  PARKED mirror with a normal-mode comm was proven 2026-10-08 (new game in ~3 s,
  same capture client); a mirror-mode comm on a FINISHED .slp idles forever.
- **Windows is UNVERIFIED at runtime.** Path *resolution* is unit-tested; nobody
  has confirmed a Windows Playback Dolphin honours `--user` with Sys-relative-to-
  binary. Do not claim Windows support until someone runs it on a Windows box.
- **`record()` is verified on Linux only by `npm run smoke`, by hand.** First
  passing run 2026-09-18: 4383-frame replay, AVI 75.07 s vs 75.10 s expected,
  no stall, no leaked processes, real profile byte-identical. Re-run 2026-10-09
  twice — after the background/placement changes and again after the 0.5.0
  consumer-gap work — same numbers both times (98.6 s wall, ratio 1.000). The
  `dolphin-runner record` CLI path was proven by hand the same day (75.07 s,
  custom `--comm` honoured). The smoke path does NOT exercise
  placement, `silent`, `audioSink`, `appName` or a non-default `dumpCodec` —
  those were verified by hand (docs/background-and-mute.md).

## Migration order

**The migrations were the deliverable; this package was not.** The plan was to
finish and document the runner here, then hand each consuming project's agent a
prompt pointing at `MIGRATING.md` — never to edit those projects from this repo.
That is done: the prompts were written and handed over on 2026-10-11.

Where it landed, as of 2026-10-11: five of the six consumers import or shell out
to this package, pinned to a tag, with their copy-pasted launchers deleted. The
sixth (the stream tool) has its cut-over on a branch and is pinned there, but the
machine that runs its live events is still on the older pin and the legacy launch
until that branch merges after the next event. Its CLI side is proven — 165 tests
pass and `obs-mirror` takes its full argument list plus `--workspace`,
`--undecorate`, `--geometry` and `--monitor` — but a real capture feed through it
has NOT been run yet. A bracket tool in the same family never spawned Dolphin,
and a Python converter is kept aligned through this file rather than code.

The per-project notes and the handoff prompts are NOT in this repo: they map
private consumer repos by file and line, so they live in `docs/local/`, which is
gitignored. `MIGRATING.md` keeps only the parts that are useful to any adopter.

Consumers report measurements back; fold them into
`docs/background-and-mute.md` with the rig and who measured them. The encoder
is CPU-bound, so numbers do not transfer between machines, and EFB 3/4 came
from consumers rather than this box.
