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
exists to end, and it has already happened once (a consumer's `apps/media` carries a
fork that has silently drifted). If you need a change, change it here.

Pin a tag or a commit, not a branch. The minor version is the breaking digit
until 1.0.

**Bumping a pin needs an explicit install.** Editing the tag in `package.json`
and running `npm install` does **not** move a git dependency — the lockfile
still satisfies it, so you keep the old commit (reproduced 2026-10-10: edited
to `#v0.5.2`, `npm install`, still on 0.5.1). This matters because the
byte-identical check in §5 would then pass without the upgrade ever happening.
Do this instead, and verify:

```sh
npm install "github:madenney/dolphin_runner#v0.5.2"
node -p "require('./node_modules/slippi-dolphin-runner/package.json').version"
```

**The `allow-scripts` warning on install is harmless.** Newer npm prints
`slippi-dolphin-runner@x (prepare: npm run build)` and tells you to approve
scripts. You do not need to: `dist/` is **not** committed, but npm runs
`prepare` while it packs the git ref, so the build has already happened and
`dist/` is present in `node_modules`. Confirm with `ls
node_modules/slippi-dolphin-runner/dist` if you want to be sure. (Do not
"fix" this by removing `prepare` from the package — that script is what
produces `dist/` for git installs.)

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

The bar is **byte-identical output**, not "it ran" — but hold the codec and
`emulationSpeed` FIXED across the two runs. Dumps are not frame-count stable
across those (3504–3534 frames of an expected 3600 for one range, measured
2026-10-10), so changing them while you compare will show a difference that is
not your migration. For the same reason, a duration guard should use a ratio,
never an exact frame count.

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

There are three subcommands. `record` builds the profile too, so a Python or
shell consumer needs no Node shim:

```sh
dolphin-runner record --dolphin <bin> --iso <iso> --slp <game.slp> \
  --out <dir> --user-dir <dir> --efb-scale 3 [--texture-pack <dir>] [--gecko-ini <f>]

dolphin-runner play   --dolphin <bin> --iso <iso> --slp <game.slp> \
  --user-dir <dir> [--start-frame N] [--end-frame N]      # on screen, no dump
```

One JSON line per event on stdout (`started`, `progress`, `warning`, `placed`,
`result`, `stopping`, `exited`, `error`); SIGTERM to it kills the whole Dolphin
tree; exit code is Dolphin's. Build it with `npm ci && npm run build` →
`dist/cli.js`.

If your driver does not consume the progress events, keeping a small Node shim
that imports the package directly is a perfectly good choice — one consumer did
exactly that, deliberately.

## 7. Platform reality

- **Linux/X11 is the verified platform.** `record()` is proven by
  `npm run smoke`; placement is measured on GNOME/mutter only.
- **Openbox, KDE and Wayland placement are untested.** Placement degrades to a
  warning rather than a failure, so adopting is safe — but do not promise a
  parked window on those until someone measures it.
- **Windows is unverified at runtime.** The path resolution is unit-tested and
  the `taskkill` branch exists; nobody has run it. Do not claim Windows support
  on the strength of this package.

