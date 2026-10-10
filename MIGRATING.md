# Adopting slippi-dolphin-runner

For the person (or agent) moving a project off its own Dolphin-spawning code.

The point of this package is **deletion**. If you adopt it and your project
still contains a stall watchdog, a `pgrep` loop, an ini writer or a window
parker, the migration is not done — those are the five copies that drifted and
each re-learned the same bugs by shipping them.

Read `README.md` for the API and `CHANGELOG.md` before you pin a version.

---

## 1. Decide how you load it

| your project | how |
|---|---|
| Node / TypeScript, ESM | `"slippi-dolphin-runner": "github:madenney/dolphin_runner#<tag>"` |
| Node, local dev loop | `"file:../dolphin_runner"` — npm symlinks it, `prepare` builds `dist/` |
| Bundled (webpack/vite/Electron main) | same as above; it is pure JS with zero deps, so it inlines. Nothing extra ships |
| Rust, Python, shell, anything else | the `dolphin-runner` CLI — see §6 |

**Do not vendor a copy into your repo.** That is the exact failure this package
exists to end, and it has already happened once (Lunar's `apps/media` carries a
fork that has silently drifted). If you need a change, change it here.

Pin a tag or a commit, not a branch. The minor version is the breaking digit
until 1.0.

## 2. Delete these

Search your project for each. Every one of them is already in the package,
tested, with the bug it used to have pinned by a regression test:

| what to delete | replaced by | the bug your copy probably has |
|---|---|---|
| `spawn(dolphinPath, …)` and its arg list | `record()` / `obsMirror()` | — |
| a stall/progress watchdog | built in, two-tier | one coarse window, or keyed on file size instead of frame progress |
| `[CURRENT_FRAME]` / end-frame matching | `parseFrameLine`, `reachedEnd` | substring match (`845` matches inside `8454` → dump truncated to a tenth) |
| stdout chunk handling | `readline`, inside | a line split across chunks → the end-frame kill never fires → hang |
| stderr handling | bounded tail, inside | not draining it at all: ~64 KB into an unread pipe and Dolphin **blocks** — the classic "random stall" |
| `kill(pid)` / `taskkill` | `killTree(pid, graceful?)` | killing only the direct child; an AppImage `exec`s, so the emulator survives |
| writing `Dolphin.ini` / `GFX.ini` | `buildProfile()` | writing the user's **real** profile, leaving them with a framedump rig |
| writing `comm.json` | `writeComm` / `writeMirrorComm` | a non-finite `endFrame` → Dolphin reports `INT_MAX` and idles forever |
| finding the profile dir per OS | `resolveRealProfile`, `profileAt` | conflating the Windows portable `User/` layout with the `--user` flag's |
| `xdotool search --name Dolphin` window parking | `placement: { workspace }` | matching by title: every Playback window has the same title, so you park **someone else's** Dolphin |
| reading `lastFrame` with slippi-js | `lastFrameOf(slp)` | pulling in a dependency for one int32 |

## 3. Keep these

Out of scope, on purpose. The package spawns Dolphin; it is not your pipeline.

ffmpeg mux / re-encode / concat · overlay compositing · uploads · progress UI ·
clip selection · which replays to record · **your duration guard** · any window
you did not spawn.

## 4. The minimum adoption

```ts
import { buildProfile, record, dolphinStatus } from "slippi-dolphin-runner";

const paths = { dolphinPath, isoPath };
const why = dolphinStatus(paths);
if (why) throw new Error(why);

// One throwaway profile PER CONCURRENT DOLPHIN. Not optional.
await buildProfile(userDir, {
  mode: "record",
  dolphinPath,
  efbScale: 6,          // ALWAYS pass it — see below
});

const res = await record(paths, slp, { outDir, userDir, signal, onFrame });

// Yours, still: the length check and the mux.
if (res.stalled) log(res.diagnostic);
const expectedSec = (res.lastFrame + 123) / 60;
```

Three things that bite every adopter:

1. **`userDir` is mandatory and per-instance.** The dump path is a property of
   the user dir, not the invocation, so two Dolphins sharing one overwrite each
   other's frames *silently* and you get footage from the wrong replay.
2. **Always pass `efbScale`.** Omit it and you inherit whatever the user last
   played at. It is an **enum**, not a multiplier: `2` = 1x native, `4` = 2x,
   `6` = 3x, `7` = 4x. One run that inherited `7` produced a 25 GB AVI at
   ~4 fps for a 75-second game.
3. **A stall is a silence, not a verdict.** `record()` resolves with
   `stalled: true` rather than throwing, because measured dumps at the moment
   of a stall have been 27%, 43%, 70% and **94%** complete. Judge the footage
   with your own duration guard — that is what `lastFrame` is returned for.
   Do not reinstate a "reject on watchdog" rule.

## 5. Verify the swap

The bar is **byte-identical output**, not "it ran".

```sh
# before: on your current code
your-recorder one-replay.slp && mv out.avi /tmp/before.avi
# after: on the package
your-recorder one-replay.slp && mv out.avi /tmp/after.avi

ffprobe -v error -show_entries format=duration -of csv=p=0 /tmp/{before,after}.avi
cmp /tmp/before.avi /tmp/after.avi && echo IDENTICAL
```

If they differ, the usual cause is a profile key your old code set and
`buildProfile` left at the source profile's value — diff the two `--user`
`Config/Dolphin.ini` and `GFX.ini`. Check `UseFFV1`/`DumpCodec` first: the
package deliberately **inherits** the codec rather than choosing for you.

Then confirm the things your old code got wrong:

```sh
pgrep -a -x "AppRun.wrapped|dolphin-emu"   # nothing of yours survives
stat -c '%y' ~/.config/SlippiPlayback/Config/Dolphin.ini   # unchanged by the run
```

(The `Slippi_Playback` process that lingers a few seconds is the AppImage's
FUSE mount daemon, not the emulator. It cleans itself up. Not a leak.)

## 6. Non-Node consumers

Spawn the CLI and treat its lifetime as the feed's lifetime:

```sh
dolphin-runner obs-mirror --dolphin <bin> --iso <iso> \
  --user-dir <dir> --comm <path> --capture-name dolphin-1 --efb-scale 2
```

One JSON line per event on stdout (`started`, `warning`, `placed`, `stopping`,
`exited`, `error`); SIGTERM to it kills the whole Dolphin tree; exit code is
Dolphin's. Build it with `npm ci && npm run build` → `dist/cli.js`.

There is no `record` subcommand yet. If you need one, say so rather than
shelling out to something else.

## 7. Platform reality

- **Linux/X11 is the verified platform.** `record()` is proven by
  `npm run smoke`; placement is measured on GNOME/mutter only.
- **Openbox, KDE and Wayland placement are untested.** Placement degrades to a
  warning rather than a failure, so adopting is safe — but do not promise a
  parked window on those until someone measures it.
- **Windows is unverified at runtime.** The path resolution is unit-tested and
  the `taskkill` branch exists; nobody has run it. Do not claim Windows support
  on the strength of this package.

## 8. Per-project notes

Surveyed 2026-10-09. Line numbers were right then; check before trusting them.

### lm-clipper — not yet adopted

Three spawn sites: recording (`src/main/slpToVideo.ts:458`), clip preview
(`src/main/managers/VideoManager.ts:1065`) and "Test Dolphin" (`:1293`).

Delete: `killTree` (`slpToVideo.ts:219`) — it kills **only the direct child**,
so the AppImage's emulator survives every cancel; the end-frame match at
`slpToVideo.ts:312` and `VideoManager.ts:1157` — both `line.includes(...)`, the
**substring bug** (`845` matches inside `8454`); `VideoManager.ts:1137`'s
`chunk.split('\r\n')`, which never splits Linux output at all; the unbounded
`dolphinStderr +=` accumulators; `buildWorkerProfile` (`:1471`), which only
rewrites existing ini lines and so **silently dumps at window resolution** on a
profile that has never dumped; `setDolphinDumping` (`:1662`) → `healRealProfile`.

Keep: the 5-stage ffmpeg chain, the worker pool and retry logic, overlay
rendering, length-scaled ffmpeg timeouts.

Needs, now supported: `commPath` (N workers share one `outDir`),
`texturePacks` + `cacheHiresTextures: false` (`:167`), `-b` is always on —
its `config.fullscreen` toggle has no equivalent, raise it if that matters.
Its preview window and "Test Dolphin" are frame-range playback with `--cout`
watched — that is `play()`, added in 0.5.1 for exactly these two sites. Build
the profile with `mode: "play"`, then `play(paths, slp, { userDir, startFrame,
endFrame })`; it resolves when the end frame is reached. `--cout` is kept, so
the end is detected by the numeric frame rule rather than their 1-second
no-frame timer.

### Lunar (`/home/matt/Projects/lunar`) `apps/media` — vendored fork, delete it

`src/vendor/dolphin-runner/` is a verbatim copy of an older commit, imported by
`src/studio/steps/record.js:10`. Replace with a dependency on this repo. Its
own README already says not to edit it there.

What that fork is missing: all of `place.ts`, `onSpawn`, `recordEnv`,
`BACKGROUND_RECORD`, `AUDIO_BACKENDS`, `dumpCodec`, `silent`,
`pauseOnFocusLost`, `freshProfile`, `gameSettingsId`. It still carries the
removed `mirror()`, the `emulationSpeed ?? 0` default that fast-forwards a
mirror on air, and the `taskkill` spawn with no `error` handler that crashes
the host. Nothing in it is a local improvement worth keeping.

Then delete these workarounds, which this version makes unnecessary:
`scanLastFrame`/`withLastFrame` (`record.js:97-132`) — it **rewrote the replay
file** because `lastFrameOf` returned null; that fallback is now built in, and
`lastFrame`/`endFrame` are accepted directly. The GFX re-patching at
`record.js:189-195` — `DumpFormat`, `DumpFramesAsImages`, `HiresTextures` and
`EFBScale`-everywhere are all `buildProfile` options now. The hard-timeout
AbortController (`:149`) → `hardTimeoutMs`.

Keep: the ffprobe duration guard (`:270`) — it is the model for what every
consumer should do with `stalled`. The `nice`/`ionice` wrapper script
(`media.js:40`) still has no option; keep generating it or raise it.

### jungle `apps/media` — adopted, but still hand-rolling

Loads via `DOLPHIN_RUNNER_DIR` and `import()` (`src/lib/render/dolphinRunner.js:40`),
preferring `dist/` over `src/`. **So `npm run build` in this repo changes its
behaviour** — build deliberately, or point it at a pinned checkout.

Uses only `buildProfile`, `profileAt`, `record`. Still hand-rolls, all now
available: its own `xdotool` parking loop (`dolphinShared.js:75`) → `placement`
(and it has no focus restore, so it leaves focus in a parked window); `pgrep -f`
pid discovery (`dolphinRunner.js:175`, whose comment "record() does not hand
out the pid" is stale) → `onSpawn`; its own `pidTree`, `lastFrameOf`,
`dolphinStatus`; the hard-timeout AbortController (`:149`) → `hardTimeoutMs`;
the `cp GC/SRAM.raw` (`:165`) → now copied by default in record mode.

`isoStageShots.js` aborts mid-dump to grab N frames around a moment, which
SIGKILLs and rejects, then rebuilds the path by hand (`:402-414`). Return
`"stop"` from `onFrame` instead: SIGTERM, and `record()` resolves with
`stoppedEarly: true`.

`dolphinLegacy.js` is dead behind `MEDIA_DOLPHIN_LEGACY=1`. Delete it.

### jungle `apps/mst` — on the CLI behind a flag

Spawns `dolphin-runner obs-mirror` when `MST_DOLPHIN_RUNNER=1` or
`useDolphinRunner` (`dolphin.rs:876`). **The fallback at `dolphin.rs:802` is a
warning, not an error** — if the CLI is missing it silently runs the legacy
path, so the flag alone does not prove adoption.

The blocker is now fixed: MST's parker exists because it must strip decorations
and moveresize onto a landscape output (its primary is a rotated portrait
panel), which `ProfileOptions.window` cannot do. Use
`--workspace N --undecorate --geometry 1920x1080 --monitor landscape`. Measured
here: **1920x1080 vs a 640x480 control**. Then delete the title-matching parker
at `slippi.rs:92-240` — it matches on `["dolphin","faster melee","playback","slippi"]`
and **grabs other projects' Dolphins**, which is the bug `place.ts` exists for.

Still not covered, keep in MST: `pactl load-module module-null-sink` (the
runner takes a sink name but will not create one), `queue`-mode comm for
back-to-back playback, `DOLPHIN_EXEC_FLAG`, and scraping `obs-gamecapture` for
the glcapture lib path.

Before deleting the legacy body: `launch_dolphin_playback_for_setup_internal`
(`dolphin.rs:681`) is **not** behind the flag and shares `ini_set`,
`write_dolphin_config`, `write_gfx_config` and `setup_user_dir` with it — they
cannot be deleted while it lives.

Note MST uses `DOLPHIN_RUNNER` (a CLI path) while jungle media uses
`DOLPHIN_RUNNER_DIR` (a checkout). Two names, one checkout.

### replay_archiver — not yet adopted, and mutating the real profile

`media.js:135` spawns with **no `--user` at all**, so every worker runs on the
operator's real profile and `media.js:25-110` rewrites it in place. That is
gotcha 14, and `NUM_WORKERS` concurrent Dolphins sharing one profile is
gotcha 15. Adopting fixes both; run `healRealProfile()` once to undo the damage.

Delete: the comm writer (`media.js:112`), the `line.includes` substring match
and CRLF-only split (`childProc.js:77-101`), the process-group kill
(`childProc.js:8`), the wall-clock watchdog (`childProc.js:54`) →
`hardTimeoutMs`.

It takes its frame range from its database and never reads the footer, so pass
`lastFrame` (or just `endFrame`) — `record()` no longer insists on reading it.
Its shared `workingGamesDir` needs `commPath` per worker.

### melee_skins — adopted

`tools/rec.mjs` imports the package properly and is pinned to a tag. Its
remaining hand-rolled bit is the texture-pack copy and `HiresTextures` write
(`rec.mjs:27-33`) — now `texturePacks: [dir]` on `buildProfile`. Since it is
driven from Python under `xvfb-run`, the shim itself can go: call
`dolphin-runner record` directly.

### kotj — nothing to do

Does not spawn Dolphin. Its `dolphins_up` is a status field relayed from the
machine agent.
