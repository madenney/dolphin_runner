# CLAUDE.md

Guidance for Claude Code working in `slippi-dolphin-runner`.

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
- `npm run typecheck` — `tsc --noEmit`
- `npm run build` — emits `dist/` (JS + `.d.ts`)
- `npm run check` — typecheck + test; run this before you call anything done

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

## Known unfinished

- **`mirror()` is PROVISIONAL.** The signature is not locked. MST's real mirror
  spawn has not been read. Do not migrate MST onto it without reading that first.
- **Windows is UNVERIFIED at runtime.** Path *resolution* is unit-tested; nobody
  has confirmed a Windows Playback Dolphin honours `--user` with Sys-relative-to-
  binary. Do not claim Windows support until someone runs it on a Windows box.
- **No end-to-end spawn test.** Everything here is tested pure; `record()` itself
  has never been exercised by the suite (it needs a real Dolphin, ISO and GPU).
  The next useful step is a smoke harness that records one short replay and
  checks the `.avi` length against `lastFrame`.

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
