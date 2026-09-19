# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

One job: **given a `.slp` and a profile, spawn an isolated Slippi *Playback*
Dolphin and either frame-dump it or mirror it live — without hangs, leaked
processes, or mutating the user's real Dolphin profile.**

It exists because that recipe was copy-pasted across five projects
(`jungle_media`, `lm-clipper`, `replay_archiver`, `kotj`, `MST`) and every fork
re-learned the same OS-level gotchas, usually by shipping a bug first. The
design doc that started this is `/home/matt/Projects/lm-clipper/DOLPHIN_RUNNER_DESIGN.md`
— read §5 before changing anything in `run.ts`.

**Status: standalone and unconsumed.** Nothing imports it yet. No existing
project has been modified. Getting it correct here comes before migrating
anyone onto it.

## The extraction

This package is a MERGE of two implementations, and neither was complete:

| | from `jungle_media` | from `lm-clipper` |
|---|---|---|
| runtime | AbortSignal, `pidTree` kill, bounded stderr tail, numeric `>=`, "a stall is a silence" | `readline` line handling, `[GAME_END_FRAME]`, two-tier stall, Windows `taskkill` |
| profile | (had none — a persistent hand-tuned dir) | throwaway `--user` builder, cross-OS resolution, heal, the tests |

**Each had bugs the other had already fixed.** lm-clipper matched the end frame
by substring (`845` matches inside `8454` → truncated dumps) and killed only the
direct child on POSIX (an AppImage execs, so the emulator survives).
jungle_media had no `[GAME_END_FRAME]`, one coarse stall window, and no Windows
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

**Untested by the suite** (needs a process or a real Dolphin):
- `status.ts` — `dolphinStatus(paths)` → human reason or `null`. Parameterised,
  never reads env at import.
- `kill.ts` — `pidTree` (POSIX `pgrep -P` walk) and `killTree` (children first;
  SIGTERM→SIGKILL escalation when `graceful`; `taskkill /T /F` on Windows).
- `run.ts` — `runDolphin()` is the single spawn loop; `record()` and `mirror()`
  differ only in args and in what they return. `record()` = validate → write
  comm.json into `outDir` → spawn with `-i comm -o base --output-directory -b
  -e iso --user userDir --hide-seekbar --cout` → readline stdout / drain stderr
  / two-tier watchdog → resolve `{ avi, wav, lastFrame, stalled, diagnostic }`.
- `obs.ts` — `obsMirror()`: a long-lived, OBS-capturable Dolphin for a stream
  tool. `buildProfile(mode: "play", …)` with the capture tuning forced (OGL,
  Pulse, Latency 60, fullscreen, VSync off), env from `obsMirrorEnv()`
  (LD_PRELOAD shim:existing:libobs_glcapture, OBS_VKCAPTURE*, PULSE_*), no
  `-b`, no watchdog — idling on "waiting for game" is healthy. Returns a
  handle; `stop()` SIGKILLs the tree. The caller re-points it by rewriting the
  comm file (`writeMirrorComm`); nothing here watches anything.
- `cli.ts` — `dolphin-runner obs-mirror …`, the process boundary for non-Node
  consumers (MST is Rust). One JSON line per event on stdout; foreground until
  Dolphin exits; SIGINT/SIGTERM/SIGHUP forwarded to the whole tree.

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
real replays: identical to jungle_media's implementation on every one.

**No Electron import, ever.** `appDataPath()` resolves config dirs by platform.
An Electron host that disagrees passes `sourceProfile` explicitly. A hard
Electron dep would lock out every non-Electron consumer.

**Scope is the spawn, not the pipeline.** IN: profile builder, comm.json, spawn,
frame-watch, stall watchdog, kill-tree, AbortSignal, cross-OS paths. **OUT:**
ffmpeg mux/re-encode/concat, overlay compositing, X11 workspace parking, uploads,
progress UI, clip selection. Those stay in each app. If you find yourself
importing ffmpeg here, stop.

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
5. **Preserve `UseFFV1`.** Copy-then-override means we never touch it. Dropping
   it silently degrades the lossless intermediate feeding the consumer's encode.
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
16. **`InternalResolutionFrameDumps` must be CREATED if absent.** A profile that
    has never dumped has no such key; only rewriting existing lines gives you a
    window-resolution dump and nothing downstream can tell.
17. **Consumers must pass `efbScale`.** Omitting it inherits the real profile's
    value, which is whatever the user last played at. The first smoke run
    inherited `EFBScale = 7` and produced a 25 GB lossless AVI at ~4 fps for a
    75 s game. lm-clipper sets it from its own config; jungle_media must too.
18. **The orphaned `Slippi_Playback` process is the AppImage FUSE daemon, not
    the emulator.** The runtime `exec`s into `AppRun.wrapped` (= `dolphin-emu`),
    so the emulator IS our direct child and `killTree` reaches it. The daemon
    `setsid()`s, holds the `/tmp/.mount_Slippi*` mount, and exits on its own a
    few seconds after the emulator. Don't count it as a leak and don't kill it.
19. **`[Core] GFXBackend` must be `OGL` for OBS capture, and CREATED if
    absent.** obs-vkcapture's GL path preloads `libobs_glcapture.so`, which
    hooks `glXSwapBuffers`; a Vulkan Dolphin makes no GL swaps and OBS shows
    black. A blank value is Vulkan on this box, and a never-captured profile
    has no line to rewrite. Slippi's stock ini also carries `GFXBackend` and
    `EmulationSpeed` under `[Movie]` — those are movie metadata, ignore them;
    `[Core]` is the live one.
20. **A windowed render larger than the display's work area becomes 640x480.**
    GNOME/mutter refuses the oversize initial map and Dolphin falls back to its
    default. 1920x1080 windowed on a 1920x1080 display captured at 640x443;
    1280x720 landed exactly. For a 1:1 1080p capture on a 1080p display,
    `{ fullscreen: true }` is the only option — which is why MST's mirror path
    was fullscreen all along.

## Known unfinished

- **`obsMirror()` is the real mirror; `mirror()` is a leftover.** MST's spawn
  (`melee_stream_tool/src-tauri/src/dolphin.rs`) was read 2026-09-19 and
  `obsMirror` reproduces it: same env, same ini keys, same comm format, no
  `-b`. Differences on purpose: profile is copy-then-override (MST wrote into a
  bare dir), LD_PRELOAD is composed directly instead of via the
  `obs-gamecapture` wrapper, and it never writes the shared profile. Proven by
  hand 2026-09-19: OBS "Dolphin 2" vkcapture source rendered the instance at
  1920x1080 via GL (no libvulkan mapped), Pulse routed to `game2` under the
  shim's name. NOT yet proven: a live, growing `.slp` (only a finished one was
  available); that path is MST's comm-rewrite loop, unchanged. `mirror()` in
  `run.ts` can go once nothing wants a batch-mode window.
- **Windows is UNVERIFIED at runtime.** Path *resolution* is unit-tested; nobody
  has confirmed a Windows Playback Dolphin honours `--user` with Sys-relative-to-
  binary. Do not claim Windows support until someone runs it on a Windows box.
- **`record()` is verified on Linux only by `npm run smoke`, by hand.** First
  passing run 2026-09-18: 4383-frame replay, AVI 75.07 s vs 75.10 s expected,
  no stall, no leaked processes, real profile byte-identical.

## Migration order, when it is time

Dogfood first, lowest risk first. **None of this has started.**

1. `lm-clipper` — it has the tested profile half already; byte-compare output
   before/after.
2. `jungle_media` — the main event. It keeps its ffmpeg mux, duration guard,
   workspace parking and upload; only the spawn is replaced. Note it currently
   uses a persistent `data/dolphin-user`; moving to throwaway profiles is the
   upgrade, but keep `userDir` as the escape hatch.
3. `replay_archiver`, then MST's `mirror()`.
4. `slp2mp4` is Python — keep it aligned via this file, not code.
