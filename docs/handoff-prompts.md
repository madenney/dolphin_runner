# Handoff prompts

One per consuming project, to paste into that project's own Claude session.
Written 2026-10-10 against `slippi-dolphin-runner` **v0.5.2**.

The migrations are the deliverable; the package is not. Do them in this order
(lowest risk first), and do not edit these projects from the dolphin_runner
repo — each project's own session owns its code.

Every prompt assumes the agent will read `MIGRATING.md` (the delete-this
checklist, with a §8 section for its project), `README.md` (the API reference)
and `CHANGELOG.md` in `~/Projects/dolphin_runner`.

---

## Shared caveats (already in each prompt; repeated here so you know them)

- **Openbox placement is untested.** The Jungle box runs Openbox; placement was
  only measured on GNOME/mutter. It degrades to an `onWarning` and a
  `"skipped"` report rather than failing, so adopting is safe — just don't
  promise a parked window there until someone measures it.
- **Windows is unverified at runtime.** Path resolution is unit-tested and the
  `taskkill` branch exists; nobody has run it. Matters for lm-clipper, which
  ships an NSIS build.
- **A growing `.slp` through `obsMirror` has never been tested.** Only finished
  replays were available. Matters for MST.
- **Pin a tag, never a branch, and never vendor a copy.** A vendored fork that
  drifts is the exact failure this package exists to end — it has already
  happened once.

## The speed opportunity, in one place

Dolphin encodes the dump on **one thread**, and that thread — not the GPU — is
the recording speed limit. It never tunes the encoder (`avcodec_open2(…,
nullptr)`: no threads, no slices, no qmin/qmax). So the codec choice *is* the
speed choice, and `EmulationSpeed = 0` only helps where the encoder is not
already the bottleneck.

Measured on an RTX 5080 against a 75.1 s replay (`docs/background-and-mute.md`
has the full tables; `EmulationSpeed=0` output is **bit-identical** to real
time):

| | EFB 6 (3×, 2816x1584) | EFB 4 (2×, 1878x1056) | EFB 2 (native, 939x528) |
|---|---|---|---|
| FFV1 | **0.10×** — 12 min/game | 0.34× | 0.77–0.95× |
| `utvideo` | **0.81×**, bit-exact, ~12 GB/game | **1.81×**, ~3.1 GB/min | fails (odd width) |
| mpeg4 60 Mb/s | 0.93×, **visible blocking** | — | — |
| mpeg4 ≥150 Mb/s | 0.74×, caps ~141 Mb/s | 1.66×, 42.3 dB | ~4× with speed 0, −6 dB |
| `h264` | **never** — drops the last ~52 frames at SIGTERM | never | never |

EFB 6 and EFB 2 were measured on an RTX 5080; EFB 4 and the native figures on
an RTX 3060 (Lunar's rig). The encoder is CPU-bound, so these track the CPU,
not the GPU. **Dumps are not frame-count stable across codec and speed**
(3504–3534 frames of an expected 3600), so a byte-comparison must hold both
fixed, and a duration guard should use a ratio rather than an exact count.

Three in parallel: FFV1 0.32× aggregate, utvideo 2.07×, mpeg4 2.13×.

Rules of thumb: **never FFV1 at EFB ≥ 4 for a batch**; archival at high EFB
wants `utvideo`; native-resolution clips should keep FFV1 unless the output is
a draft; a **live mirror must stay at `emulationSpeed: 1`** — 0 fast-forwards
on air with crackling audio.

**Whatever you expose, expose it in the UI.** These are user-facing trade-offs
— quality against time against disk — and a codec choice that lives only in an
undocumented config key gets forgotten, then rediscovered as a mystery
performance difference between two machines. Every prompt below says where
that app's settings surface is. If an app genuinely has no UI, it goes in that
app's README and its example config, not nowhere.

---

## 1. Lunar — the whole repo ✅ DONE 2026-10-10

_Both apps migrated and verified byte-identical (`apps/media` dc5711c,
`apps/clipper` 775c5d8). Kept for reference; nothing to send._

<details><summary>original prompt</summary>

> You're working in `~/Projects/lunar`. **Two** apps here spawn Slippi Playback
> Dolphin, and both should end up on `slippi-dolphin-runner`
> (`madenney/dolphin_runner`, pin **`#v0.5.2`**):
>
> - **`apps/media`** (`lunar_media`) — already uses the package, but through a
>   **vendored copy** that has drifted.
> - **`apps/clipper`** (`lm-clipper`) — does not use it at all, and still
>   carries two bugs the package exists to fix.
>
> There are no npm workspaces here, so each app takes the dependency in its own
> `package.json`. **Do not vendor it again** — a vendored fork that drifts is
> the exact failure this package exists to end, and `apps/media` is the proof.
> Pin the tag, not a branch.
>
> Read `MIGRATING.md` in `~/Projects/dolphin_runner` first: §2 is the
> delete-this checklist, §5 is how to verify, and §8 has sections for both
> Lunar and lm-clipper. `README.md` is the API reference; `CHANGELOG.md` covers
> what broke between versions.
>
> Do `apps/media` first — it is smaller and half-done already — then
> `apps/clipper`.
>
> ### Part A — `apps/media`: delete the vendored fork
>
> `apps/media/src/vendor/dolphin-runner/` is a verbatim copy of an old commit,
> imported by `src/studio/steps/record.js:10`. Replace it with a real
> dependency. Its own README already says not to edit it in place.
>
> What that fork is missing: all of `place.ts` (so no window parking at all),
> `onSpawn`, `recordEnv`, `BACKGROUND_RECORD`, `dumpCodec`, `silent`,
> `pauseOnFocusLost`, `freshProfile`, `gameSettingsId`. It still carries the
> removed `mirror()`, the `emulationSpeed ?? 0` default that fast-forwards a
> mirror on air, and a `taskkill` spawn with no `error` handler that would
> crash the host process. Nothing in it is a local improvement worth keeping.
>
> Then delete these workarounds, which the current version makes unnecessary:
> - `scanLastFrame`/`withLastFrame` (`src/studio/steps/record.js:97-132`). You
>   **rewrite the replay file** because `lastFrameOf` returned null on
>   anonymised ranked replays. That fallback is now built in — it walks the raw
>   event stream, verified against 429 real replays (428 identical to the
>   footer, one 1 frame higher) — and `record()` also accepts `lastFrame`, or
>   just `endFrame`.
> - The GFX re-patching at `record.js:189-195`. `DumpFormat`,
>   `DumpFramesAsImages`, `HiresTextures` and `EFBScale`-in-every-section are
>   all `buildProfile` options now; the package writes `[Hacks]` EFBScale too,
>   so `setEverywhere('EFBScale', …)` at `:194` can go.
> - The hard-timeout AbortController (`:149`) → `hardTimeoutMs`, which SIGTERMs
>   and **resolves** with `stalled: true` instead of rejecting and throwing the
>   partial dump away.
>
> Keep your ffprobe duration guard (`:270`) — it is the model for what every
> consumer should do with `stalled`, and the other apps should copy it. Your
> `nice`/`ionice` wrapper script (`media.js:40`) still has no option in the
> package; keep generating it, or raise it upstream.
>
> ### Part B — `apps/clipper`: a full migration
>
> This is lm-clipper's codebase. Three spawn sites, mapping to **two different
> functions**:
> - recording (`src/main/slpToVideo.ts:480`) → `buildProfile({mode:"record"})`
>   + `record()`
> - clip preview (`src/main/managers/VideoManager.ts:1091`) and "Test Dolphin"
>   (`:1293`) → `buildProfile({mode:"play"})` + **`play()`**, a frame range on
>   screen with no dump. It keeps `--cout`, so you can delete the 1-second
>   no-frame stale timer (`VideoManager.ts:1131`) you use to guess a clip has
>   finished — the end is detected numerically.
>
> Delete, don't port:
> - The end-frame match at `slpToVideo.ts:314` and `VideoManager.ts:1159`:
>   `line.includes(\`[CURRENT_FRAME] ${endFrame}\`)` is a **substring** test, so
>   `845` matches inside `8454` and truncates the dump to a tenth. The package
>   compares numerically with `>=`.
> - `VideoManager.ts:1138`'s `chunk.split('\r\n')` — Dolphin on Linux emits
>   `\n`, so that never splits at all. (`slpToVideo.ts:301` already uses
>   `readline`, which is right; the package does the same.)
> - `killTree` (`slpToVideo.ts:~215-240`): on POSIX it only reaches the direct
>   child, and the AppImage `exec`s, so the real emulator survives every
>   cancel, holding the GPU and the user dir. `killTree()` walks `pgrep -P`
>   children-first. Its `taskkill` spawn also has no `error` handler.
> - `buildWorkerProfile` (`:1471`) and `buildPlaybackProfile` (`:1590`) →
>   `buildProfile`. Yours only rewrites ini lines that already exist (see
>   `:1504`), so a profile that has never dumped has no
>   `InternalResolutionFrameDumps` line and silently records at **window**
>   resolution, with nothing downstream able to tell.
> - The unbounded `dolphinStderr += chunk` (`slpToVideo.ts:486`,
>   `VideoManager.ts:1097`) → a bounded tail, inside.
> - `setDolphinDumping(config, false)` (`:1662`) → `healRealProfile()`.
>
> Keep: the ffmpeg chain, the worker pool and retries, overlay rendering,
> length-scaled ffmpeg timeouts, filename resolution, all IPC/progress.
>
> Two options to pass that you don't today:
> - **`commPath`** — your N workers share one `outputDir` and the package's
>   default comm filename is fixed, so they would overwrite each other's comm
>   between the write and Dolphin's read, and each would record the other's
>   replay with no error anywhere.
> - **`texturePacks`** + `cacheHiresTextures: false`, instead of symlinking
>   packs into `Load/Textures/GALE01/` yourself.
>
> One thing you lose: `record()` always passes `-b`, so the `config.fullscreen`
> toggle has no equivalent on the record path. Raise it rather than working
> around it.
>
> ### Speed — different answer per app
>
> Dolphin encodes the dump on **one thread** and never tunes the encoder, so
> the codec choice *is* the speed choice, and `EmulationSpeed = 0` only helps
> where the encoder is not already the bottleneck (its output is
> bit-identical). Measurements were taken at **EFB 6 and EFB 2**; read across
> carefully. Never `dumpCodec: "h264"` in either app — it drops the last ~52
> frames at SIGTERM.
>
> **`apps/media`** runs `DEFAULT_EFB_SCALE = 4` (2×, 1878x1056) with
> `UseFFV1 = False` and `bitrateKbps: 60000`. **EFB 4 was not measured**, so
> treat these as directional: at EFB 6, mpeg4 at 60 Mb/s ran 0.93× realtime but
> showed **visible blocking on fast frames**, and mpeg4 caps out near 141 Mb/s
> — so if you keep mpeg4, raise it to 150000; 60000 is the one value measured
> to look bad. `dumpCodec: "utvideo"` is near-lossless (bit-exact after 4:2:0
> at EFB 6) and ~8× faster than FFV1 there; it needs an **even dump width** and
> yours is 1878, so it should work, but nobody has measured it at EFB 4. Try
> it, compare against an FFV1 dump of the same replay, budget scratch disk
> (~12 GB/game at EFB 6, so several GB at EFB 4), and **report the ratio back**
> — that number doesn't exist yet.
>
> **`apps/clipper`** records at native (EFB 2, 939x528) with FFV1 at 0.77×
> realtime. utvideo and h264 **fail there** — odd width. So: keep FFV1 for
> final clips. For draft/preview renders, `dumpCodec: "mpeg4"` plus
> `emulationSpeed: 0` measured **3.0–3.6×** (about −6 dB, mild softening),
> which is worth exposing as a "fast draft" option rather than as the default.
> Three parallel FFV1 workers give 2.2× aggregate, so parallelism stays your
> main lever at final quality. utvideo at EFB 4 (even width) would also work
> for clipper if you ever raise its resolution — same unmeasured caveat.
>
> ### Every speed option needs a UI control
>
> These are user-facing trade-offs — quality against time against disk — so
> they do not belong in a config file only you know about. Whatever you expose,
> expose it in the interface, with a tooltip that states the trade-off in the
> terms above.
>
> `apps/clipper` already has the pattern: `src/constants/config.ts` registers
> each setting with a label, tooltip and description, and
> `src/renderer/components/SettingsModal.tsx` / `StudioSettings.tsx` render
> them. `resolution` (`config.ts:1720`, *"Higher = sharper but slower"*) and the
> keep-the-FFV1-master toggle (`:1826`) are exactly the right precedent. Add
> the codec/draft-mode controls beside them — e.g. a **"Fast draft"** toggle
> that sets `dumpCodec: "mpeg4"` + `emulationSpeed: 0`, with a tooltip saying
> roughly *"3–4× faster, slightly softer — for review copies, not finals"*, and
> leave the default on FFV1 so nobody ships a draft by accident.
>
> `apps/media` takes its settings through `config.record.*`
> (`src/studio/steps/record.js:169`). Find where that object is authored — if
> it is the website or the orchestrator rather than media itself, add the
> control there. A codec choice that only exists as an undocumented key will be
> forgotten and then rediscovered as a mystery performance difference between
> two machines.
>
> ### Verify, and two caveats
>
> The bar is **byte-identical output**, not "it ran" — `MIGRATING.md` §5 has
> the recipe. Do it once per app on a single clip/render. If the dumps differ,
> diff the two `--user` `Config/Dolphin.ini` and `GFX.ini`: the usual cause is
> a key your old builder set that the package inherits from the source profile
> instead. Also confirm nothing survives (`pgrep -a -x "AppRun.wrapped|dolphin-emu"`)
> and that `~/.config/SlippiPlayback/Config/Dolphin.ini` is untouched by a run.
>
> - **Windows is unverified at runtime** in this package. Path resolution is
>   unit-tested and the `taskkill` branch exists, but nobody has run it.
>   `apps/clipper` ships an NSIS build, so test there before releasing it.
> - `~/Projects/lm-clipper` is a **stale standalone checkout of this same
>   codebase. Ignore it.** `apps/clipper` is the live one; do not migrate or
>   sync the other.

</details>

## 2. jungle — the whole repo (`apps/media` **and** `apps/mst`)

> You're working in `~/Projects/jungle`. Two apps here drive Slippi Playback
> Dolphin and both should end up fully on `slippi-dolphin-runner`
> (`madenney/dolphin_runner`, pin **`#v0.5.2`**):
>
> - **`apps/media`** — the VOD recorder. Already uses the package, but loads it
>   from a loose checkout and still hand-rolls a lot it now owns.
> - **`apps/mst`** — the stream tool (Rust/Tauri). Already shells out to the
>   CLI, but only behind a flag, with the legacy path still live.
>
> `apps/kotj` does **not** spawn Dolphin — its `dolphins_up` is a status field
> relayed from the machine agent. Nothing to do there; don't go looking.
>
> Read `MIGRATING.md` in `~/Projects/dolphin_runner` (§2 is the delete-this
> checklist, §5 is how to verify, §8 has a section for each of these apps),
> plus `README.md` for the API and `CHANGELOG.md` for what changed.
>
> Do `apps/media` first — it is pure deletion — then `apps/mst`, which has a
> sequencing problem to untangle.
>
> ### Part A — `apps/media`
>
> You're working in `~/Projects/jungle`, app `apps/media`. It already uses
> `slippi-dolphin-runner` via `DOLPHIN_RUNNER_DIR` but still hand-rolls a lot
> the package now owns. Read `MIGRATING.md` §8 in `~/Projects/dolphin_runner`
> for the jungle `apps/media` section.
>
> First, a hazard: `src/lib/render/dolphinRunner.js:40` loads `dist/index.js`
> in preference to `src/`, and `dist/` is a gitignored build artifact. **A
> `npm run build` in the dolphin_runner checkout silently changes this app's
> behaviour.** Point it at a pinned checkout or a real dependency (**v0.5.2**).
>
> Delete and replace:
> - your `xdotool` parking loop (`dolphinShared.js:75`) → `placement: { workspace }`.
>   Yours has no focus restore, so it leaves focus in a window the operator
>   can't see; the package hands focus back (and only to a window on their
>   current workspace, so it can't switch workspaces on them).
> - `pgrep -f` pid discovery (`dolphinRunner.js:175`) → `onSpawn`. The comment
>   there saying "record() does not hand out the pid" is stale.
> - your `pidTree`, `lastFrameOf` and `dolphinStatus` (`dolphinShared.js`) — all exported.
> - the hard-timeout AbortController (`:149`) → `hardTimeoutMs`.
> - the `cp GC/SRAM.raw` (`:165`, duplicated in `isoStageShots.js:382`) —
>   record mode copies it by default now.
> - `src/lib/render/dolphinLegacy.js` — dead behind `MEDIA_DOLPHIN_LEGACY=1`.
>
> `isoStageShots.js` aborts mid-dump to grab N frames around a moment, which
> SIGKILLs (leaving an `.avi` with no index) and rejects, then rebuilds the
> path by hand (`:402-414`). Return **`"stop"` from `onFrame`** instead:
> Dolphin is SIGTERMed and `record()` resolves normally with
> `stoppedEarly: true`.
>
> **Speed — this is your big one.** You render at EFB 6. If anything in your
> path still uses FFV1 there it is running at **0.10× realtime, about 12
> minutes per game**, because Dolphin encodes on a single thread and never
> tunes the encoder. `dumpCodec: "utvideo"` is **0.81×** — roughly 8× faster —
> and bit-exact after 4:2:0, within 0.07 dB on the final encode. Budget ~12 GB
> of scratch per game per worker and delete the dump after your mux. If you're
> on mpeg4 60 Mb/s today, that blocks visibly on fast frames; go `utvideo`, or
> mpeg4 at ≥150 Mb/s. Three workers in parallel give 2.07× aggregate on
> utvideo. `emulationSpeed: 0` won't help at EFB 6 (encoder-bound) and is
> bit-identical when it does apply. Never `h264` — it drops the last ~52 frames.
>
> **Surface the codec choice in the UI.** This is a quality/time/disk
> trade-off the operator should be able to make per job, not a constant buried
> in the render step — and if two machines end up on different codecs by
> accident, the difference will show up as an unexplained speed gap. Put it
> wherever `apps/media`'s render settings are authored, with a tooltip stating
> the trade-off (utvideo: near-lossless, ~8× faster than FFV1, ~12 GB/game of
> scratch; mpeg4 150 Mb/s: much smaller, slightly lossy; mpeg4 60 Mb/s: don't).
>
> Caveat: **the Jungle box runs Openbox and placement was only measured on
> GNOME/mutter.** It degrades to an `onWarning` plus a `"skipped"` report
> rather than failing, so adopting is safe — but verify parking actually
> happens there before relying on it, and report back what you find.
>
> ### Part B — `apps/mst`
>
> You're working in `~/Projects/jungle`, app `apps/mst` (Rust/Tauri). It
> already spawns `dolphin-runner obs-mirror` but only behind a flag. Read
> `MIGRATING.md` §8 in `~/Projects/dolphin_runner` for the MST section.
>
> The thing that was blocking full adoption is now fixed. Your parker exists
> because you must strip decorations and moveresize onto a landscape output
> (your primary is a rotated portrait panel), which the profile's `window`
> option cannot do — Dolphin clamps an oversize window to 640x480 itself. The
> CLI now takes `--workspace N --undecorate --geometry 1920x1080 --monitor
> landscape`, applied after the WM takes the window. Measured upstream:
> **1920x1080 against a 640x480 control** on a 1080p display, decorations
> stripped before the resize (the other order leaves the client area a titlebar
> short, and the capture takes the client area).
>
> Once that's wired and verified on a real feed, delete your title-matching
> parker at `slippi.rs:92-240`. It matches on
> `["dolphin","faster melee","playback","slippi"]` and so **grabs other
> projects' Dolphins** — that cross-project bug is why the package finds
> windows by pid only.
>
> Two more things before the legacy body can go:
> - The fallback at `dolphin.rs:802` is a `tracing::warn!`, not an error, so a
>   missing CLI silently runs the legacy path. The flag alone does not prove
>   adoption. Make it fail loudly.
> - `launch_dolphin_playback_for_setup_internal` (`dolphin.rs:681`) is **not**
>   behind the flag and shares `ini_set`, `write_dolphin_config`,
>   `write_gfx_config` and `setup_user_dir` with the legacy mirror path. Those
>   can't be deleted while it lives. It uses `queue`-mode comm, which the
>   package does not support — either port it, drop it, or keep it and say so.
>
> Keep in MST (deliberately out of scope upstream): `pactl load-module
> module-null-sink` (the runner takes a sink name but won't create one),
> `queue`-mode comm, `DOLPHIN_EXEC_FLAG`, and scraping `obs-gamecapture` for
> the glcapture lib path.
>
> **Speed: not for you.** A mirror must stay at `emulationSpeed: 1`. The
> package's default changed from 0 to 1 in 0.4.0 for exactly this reason — at 0
> a mirror pointed at a finished or partly-written replay fast-forwards on air
> with crackling audio. You already pass `1` explicitly; keep doing that.
>
> Caveat: **a growing `.slp` through `obsMirror` has never been tested
> upstream** — only finished replays were available. That's your live case, so
> test it deliberately and report back.

## 3. replay_archiver

> You're working in `~/Projects/replay_archiver`. Migrate its Dolphin launching
> onto `slippi-dolphin-runner` (`madenney/dolphin_runner`, pin **`#v0.5.2`**).
> It's Node ESM, so import it directly. Read `MIGRATING.md` in that repo — §2
> is the checklist, §8 has a replay_archiver section.
>
> **Start with the serious one:** `media.js:135` spawns Dolphin with **no
> `--user` at all**, so every worker runs on the operator's real Slippi profile
> and `media.js:25-110` rewrites it in place. That means the operator's own
> Dolphin inherits a framedump rig, and `NUM_WORKERS` concurrent Dolphins share
> one profile — where the dump path is a property of the user dir, so they
> overwrite each other's frames silently and you get footage from the wrong
> replay. `buildProfile()` into a per-worker throwaway dir fixes both. Run
> `healRealProfile(dolphinPath)` once to undo the damage already done.
>
> Delete: the comm writer (`media.js:112`); the end-frame match and stdout
> handling in `childProc.js:77-101` — it's `line.includes(...)` (the substring
> bug: `845` matches inside `8454`) and splits on `\r\n` only; the
> process-group kill (`childProc.js:8`); the wall-clock watchdog
> (`childProc.js:54`) → `hardTimeoutMs`, which SIGTERMs and **resolves** with
> `stalled: true` rather than discarding the partial dump.
>
> Two options you specifically need: `commPath` (your workers share one
> `workingGamesDir`, and the default comm filename is fixed — they'd clobber
> each other), and `lastFrame` (you take the range from your database and never
> read the footer; `record()` no longer insists on reading it).
>
> Keep your ffprobe verification and your avi+wav mux.
>
> **Speed:** you're archiving in bulk, so this is worth real attention. Dolphin
> encodes on one thread and that thread is the limit. At high EFB, FFV1 is
> **0.10× realtime** (12 min/game) while `dumpCodec: "utvideo"` is 0.81× and
> bit-exact — about 8× faster. At native resolution utvideo fails (odd width,
> 939 px) so FFV1's 0.77× stands, unless you accept mpeg4 + `emulationSpeed: 0`
> at 3.0–3.6× for about −6 dB. `emulationSpeed: 0` is bit-identical output
> where it applies, and only helps when the encoder isn't the bottleneck.
> Parallelism is the other lever: three utvideo workers give 2.07× aggregate.
> Never `h264` — it drops the last ~52 frames at SIGTERM.
>
> **Make the codec a documented, operator-visible setting**, not a constant in
> `media.js`. If replay_archiver has no UI, put it in its config schema with a
> comment stating the trade-off and mention it in the README — a bulk archiver
> running 8× slower than it needs to, because nobody knew there was a knob, is
> the failure mode here.

---

## 4. melee_skins

> You're working in `~/Projects/melee_skins`. It **already uses**
> `slippi-dolphin-runner` — this is a small catch-up, not a migration.
>
> Two things to do, plus one to consider.
>
> **1. Bump the pin.** `package.json` is on `#v0.4.0`; current is **`#v0.5.2`**.
> Nothing between those is a breaking change (see `CHANGELOG.md` — 0.4.0 was
> the breaking one), but record mode now pins `DumpFormat = avi` /
> `DumpFramesAsImages = False` and writes `EFBScale` under `[Hacks]` as well as
> `[Settings]`. Both are fixes, and both can change a dump if your source
> profile disagreed with them, so byte-compare one render before and after
> (`MIGRATING.md` §5).
>
> **2. Delete the texture-pack handling.** `tools/rec.mjs:27-33` copies each
> pack into `<userDir>/Load/Textures/GALE01/` and then re-opens the `GFX.ini`
> that `buildProfile` just wrote to set `HiresTextures`. That is now a
> `buildProfile` option:
>
> ```js
> await buildProfile(userDir, { mode: "record", efbScale, texturePacks: [args.pack], … });
> ```
>
> It symlinks rather than copies by default (a pack is hundreds of MB and a
> per-clip copy fills a disk), follows `gameSettingsId` instead of hardcoding
> `GALE01`, and sets `HiresTextures` for you. Consider
> `cacheHiresTextures: false` too — lazy-loading beats prefetching a
> multi-hundred-MB pack per run. While you're there, `rec.mjs:14-25` hardcodes
> `~/.config/SlippiPlayback/GameSettings/GALE01.ini` to read the gecko ini;
> `resolveRealProfile(dolphinPath).gameSettingsIni` is exported and handles the
> per-OS layout.
>
> **3. Consider dropping the shim entirely.** `tools/rec.mjs` exists only
> because the package had no CLI — your real driver is Python
> (`mskins/iterate.py:263` and friends, under `xvfb-run`). There is now a
> `record` subcommand that builds the profile too:
>
> ```sh
> dolphin-runner record --dolphin <bin> --iso <iso> --slp <replay.slp> \
>   --out <dir> --user-dir <dir> --efb-scale 3 --display :N \
>   [--start-frame N] [--end-frame N] [--texture-pack <dir>] [--gecko-ini <file>]
> ```
>
> It emits one JSON line per event on stdout (`started`, `progress`, `warning`,
> `result`), which is easier to consume from Python than parsing your own
> output. Your call whether that is worth the churn — the shim works.
>
> **Speed.** You run many dumps for skin iteration, so this is worth a look.
> Dolphin encodes on one thread and that thread is the limit, so the codec is
> the speed choice (`dumpCodec`), and `emulationSpeed: 0` is bit-identical
> output that only helps when the encoder is not already the bottleneck.
> Caveat for you specifically: `rec.mjs` defaults to `efbScale: 3`, which is
> between the measured points (EFB 2, 4 and 6 have numbers; 3 does not), and
> `utvideo` requires an **even dump width** — it fails at native's 939 px, but
> works at EFB 4's 1878. Check your actual dump dimensions first. utvideo is
> 1.81× realtime at EFB 4 against FFV1's 0.34×, and bit-identical after 4:2:0;
> at native, mpeg4 plus `emulationSpeed: 0` reached ~4×. Never `h264` — it
> drops the last ~52 frames at SIGTERM. If you measure a ratio at EFB 3,
> report it back; nobody has that one.
>
> Since this is a tool rather than an app with a settings screen, a codec
> choice belongs in the `rec.mjs` flags (or the `record` CLI call) **and** in
> whatever README or docstring the Python side reads — not as a silent
> constant. A pipeline running several times slower than it needs to because
> nobody knew there was a knob is the thing to avoid.

## Not a consumer

**kotj** (which lives inside the jungle repo, `apps/kotj`) does not spawn
Dolphin. Its `dolphins_up` is a status field relayed from the machine agent.
Nothing to do — it is called out in the jungle prompt so nobody goes looking.
