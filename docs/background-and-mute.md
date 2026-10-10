# Running Dolphin in the background, and muting it

Research and tests from 2026-10-08, on belphy (RTX 5080, driver 580, GNOME/mutter on
Xorg, PipeWire 1.0.5) and Slippi Playback **3.5.2**. That build is Ishiiruka `slippi`
at `bffe989d0`.

The goal is to get Dolphin off the user's screen, stop it stealing focus or input, and
keep it quiet locally without losing audio the dump or OBS needs. It covers recording
(clipper, jungle_media, Lunar Studio, replay_archiver, melee_skins) and live OBS
mirrors (MST).

**Implementation status:** everything below, including window parking, is built on branch
`background-options` (see "What the runner offers"). Each claim carries a tag:
- **[measured]**: we ran it, and the evidence is described in place.
- **[code]**: read in the Playback source.
- **[doc]**: a third-party source.
- **[guess]**: inferred, not tested.

---

## TL;DR: the recipes

**Recording in the background (any recording consumer):**

| Setting | Why |
|---|---|
| `[Settings] InternalResolutionFrameDumps = True` (runner already forces it) | The dump becomes independent of the window. Parked, minimised and occluded windows gave dumps bit-identical to a visible one. [measured] |
| `[Interface] PauseOnFocusLost = False` | **Must** be forced. With True, losing focus after boot hung the run until the 90 s watchdog killed it. [measured] |
| `[DSP] Backend = No audio output` | The mute. The WAV is bit-identical to an ALSA or Pulse run, and nothing plays. [measured] |
| `DumpFramesSilent`/`DumpAudioSilent = True` (runner already sets them) | Without them, an existing file raises a modal dialog: a hang behind a hidden window. [code] |
| Window: park on another workspace by **our own pid**, ideally by setting `_NET_WM_DESKTOP` before it maps | Removes the flash on the user's workspace. Focus is still stolen for 40 to 330 ms. [measured] |
| Optional `[Core] EmulationSpeed = 0` | Output is identical [measured], but it **only helps when the encoder isn't the bottleneck**. See "Speed and codec". |
| Codec, which is the real speed lever | FFV1 is single-threaded: 0.77× at native, **0.10× at EFB 6**. `DumpCodec=utvideo` is about bit-exact and 0.81× at EFB 6. See "Speed and codec". |

**MST mirror in the background:**

| Setting | Why |
|---|---|
| Park on a workspace (pre-map or after) | vkcapture keeps capturing at full size with audio whether the window is parked, occluded or minimised. [measured] |
| Do not minimise | Capture survives it, but it's unreliable and restoring steals focus. Parking is enough. [measured] |
| `PULSE_SINK=gameN`, Pulse backend | The mute. OBS reads `gameN.monitor`. Never mute the stream, the app, or `gameN` itself: each of those silences OBS on this rig. [measured] |
| Listen locally via `module-loopback` from `gameN.monitor` to the headphones, and mute *that* | Mutes only the local path. [measured] |
| `PULSE_PROP_OVERRIDE="application.name='mst-gameN'"` | Gives each feed its own WirePlumber volume/mute/target key and its own name in OBS app capture. [measured] |
| `PauseOnFocusLost = False`; detach hotkeys in play mode too | A mirror that steals focus currently receives the operator's keystrokes. [code] + [guess] (see the freeze below) |
| `EmulationSpeed = 1` | Never 0 for a live mirror. |

---

## What cannot be done

- **No headless mode.** Playback is wxWidgets on GTK3 and GLX-only. The nogui target cannot
  be built: it needs `USE_X11 && ENABLE_HEADLESS`, and the two options exclude each other.
  GLX always maps a real child window. So every run needs an X server and a mapped
  window. [code]
- **Dolphin always steals focus at launch.** `Main.cpp:422` calls `Raise()` unconditionally,
  and `-b` only means "exit when emulation stops". [code] Measured:
  - unparked, it keeps focus for the whole run;
  - a 50 ms pid-scoped parker cuts that to 40 to 330 ms;
  - parked pre-map, it still takes `_NET_ACTIVE_WINDOW` in about 4 of 10 launches, but
    the user's workspace never switches. [measured]

  `gsettings focus-new-windows 'strict'` may help on GNOME. It is user-wide, so the runner
  must not set it. That is untested.
- **Fast software GL is impossible.**
  - Xvfb runs on llvmpipe (confirmed by `glxinfo` and mapped libs): 0.3 to 0.9× real time at
    native resolution, using 8 to 9 cores per Dolphin, and 0.11× at "auto" scale. [measured]
  - Xephyr has the same problem. [doc]
  - Software GL is fine for **correctness** tests, because dumps are deterministic and timed
    from emulated ticks.
- **No second X server on a desktop box.** NVIDIA allows one active X server per GPU, so a
  second one VT-switches and blanks the user's screen. [doc]
- **gamescope headless on NVIDIA renders nothing** (gamescope#1984). [doc]
- **Off-screen ini coordinates do nothing.** Dolphin clamps `RenderWindowXPos/YPos` back onto
  the work area. [code]

---

## Findings in detail

### Frame dumps vs. window state
Smoke replay, 4383 frames, efb 2, null audio. [measured]
- **InternalResolutionFrameDumps=True.** Dumps bit-identical to the visible baseline when:
  - parked on workspace 9 (before or after map);
  - minimised;
  - occluded by a fullscreen window;
  - the window is 640x480, 960x540 or fullscreen;
  - `RenderToMain=True`.
- **InternalResolutionFrameDumps=False.**
  - Dumps at the *client* size: 892x500 for a 960x540 request.
  - Parked: fine.
  - **Minimised: 960x540 with a black band at the bottom and the HUD cropped.** Never turn
    IR dumps off.
- **Determinism.**
  - Every FFV1 dump is one of two variants, 4502 or 4503 frames. They differ only by one
    startup frame at index 2.
  - The WAV is bit-identical across all runs on the GPU.
  - AVI 75.067 s vs WAV 75.080 s; expected 75.10 s.
- **WAV start truncation under heavy load.** In 3 of 15 Xvfb runs the WAV lost exactly its
  first 160 stereo samples (5 ms). This was load-related, not backend-related. Expect it if
  you compare WAV hashes.

### Audio
Live-mirror tests used `parecord` on sink monitors. [measured]
- **`[DSP] Volume` does nothing on Linux.**
  - Pulse and ALSA never implement `SetVolume` [code].
  - Volume 0 vs 100 gave the same monitor RMS [measured].
  - It never affects the WAV, which is written in `CMixer::PushSamples` before any
    backend. [code]
- **Muting the stream or app** (`set-sink-input-mute`, or volume 0) zeroes the monitor, so
  OBS goes silent.
- **Muting the sink** (`set-sink-mute gameN`, or sink volume 0) **also zeroes the monitor on
  this rig.** pipewire-pulse null sinks, and the rig's own `50-kotj-buses.conf`, set
  `monitor.channel-volumes=true`. Never mute `gameN`.
- **The loopback pattern works.** Loop `A.monitor` to headphones, then mute the loopback's
  sink-input: the headphones go silent and `A.monitor` is untouched.
- **`No audio output`** creates no stream at all.
  - The exact string is `No audio output`.
  - **An unknown backend string also silently falls back to null.** A typo mutes too,
    with no visible warning.
- **ALSA ignores `PULSE_SINK`** and goes to the default sink: on belphy, the user's headset.
  `PIPEWIRE_NODE=<sink>` does route ALSA.
- **Two Dolphins on two sinks** stay separate.
- **WirePlumber keys volume, mute and target by `application.name`, and every Pulse Dolphin is
  `dolphin-emu`.**
  - Muting one Dolphin by hand mutes all future ones.
  - A manual `pactl move-sink-input` writes a shared `target=` that the
    `restore-target=false` guard does **not** prevent.
  - Use `PULSE_PROP_OVERRIDE`, and never move Dolphin streams by hand.
  - Repair: `~/Projects/audio/bin/audio-forget-targets --apply` (restarts WirePlumber).

### OBS capture vs. window state
Isolated OBS 32.0.2 with vkcapture 1.5.3, read through websocket screenshots. [measured]

| State | Result |
|---|---|
| Visible fullscreen | live, 1920x1080, audio |
| Fullscreen parked, pre-map or post-map | live, 1920x1080, audio (200 s sampled) |
| Windowed 1280x720, parked | live, but captured at **1280x683** (decorations ate the height) |
| Minimised (fullscreen or windowed) | live for 20 to 30 s, audio |
| Occluded | live |
| Two mirrors, both parked | both live, separate |
| Re-point while parked with a **normal-mode** comm | new game within about 3 s, same capture client |
| Re-point with **mirror-mode** comm on a *finished* .slp | "Waiting for game" forever. A growing .slp is still untested. |

- No cursor is ever captured.
- **One unexplained freeze:** minimise, `windowmap`, then `windowactivate` froze Dolphin on one
  frame within 3 s. The capture stayed connected. The same sequence did not reproduce it.
  Best guess: it had focus while the user typed, and a default play-mode hotkey paused it.
  This is a reason to detach hotkeys for mirrors.

### Window geometry
Xvfb with no WM, plus i3 as a stand-in WM. Openbox is not installed here. [measured]
- **The 640x480 fallback is Dolphin's own clamp** (`FrameTools.cpp:679-689`), not mutter's.
  It was reproduced with no WM: a window wider than the work area by 1 px, including
  decorations, becomes 640x480. With no WM, or an undecorated window, exactly 1920x1080 fits
  1080p.
- **Four 1920x1080 windowed Dolphins at tile offsets on a 3840x2160 screen kept their exact
  geometry.** But Dolphin (via GTK) clamps to RandR monitors **tied to an output**:
  - A 1920x1080 output-tied monitor on a larger framebuffer pulls every tile to `+0+0`.
  - Monitors with output `none` are ignored.

  The Jungle box's `xrandr --setmonitor jungle-virtual …` must be checked (read-only, after an
  event) before anyone tries tiles there.
- **Window class** is `"AppRun.wrapped","Apprun"`.
  - Render window title: `Dolphin`.
  - Main window title: `Faster Melee - Slippi (3.5.2) - Playback`.
  - Every instance is identical, so per-instance placement must come from each instance's own
    `RenderWindowXPos/YPos`, not WM rules.
- **The clamp can be undone AFTER the map, on mutter.** [measured 2026-10-09]
  Stripping `_MOTIF_WM_HINTS` decorations and then sending EWMH
  `_NET_MOVERESIZE_WINDOW` (`wmctrl -i -r <id> -e 0,x,y,w,h`) to the managed window gave a
  **1920x1080** render surface on the 1920x1080 GNOME display, against a **640x480** control
  run in the same session with everything else identical. Both runs asked for 1920x1080 in
  the ini; only the one that reshaped the window got it.
  - Order matters: undecorate **first**. Resizing before stripping leaves the client area a
    titlebar short (1920x1043 was measured earlier), and the capture takes the client area.
  - This is now `placement: { undecorate, geometry, monitor }` in the runner, so
    `{ fullscreen: true }` is no longer the only 1:1 option on a 1080p display.
- **Openbox rules are untested.** From the source: with `<decor>no</decor>` openbox should
  report a zero border, so 1920x1080 wouldn't trip the clamp. [code]
- **`RenderToMain=True` works on Linux.** It gives one window instead of two and an identical
  dump. The size comes from `[Interface] MainWindow*`, and `RenderWindow*` is ignored.
- **Blank `[Core] GFXBackend` is OGL.** Measured by mapped libs: blank or missing loaded Mesa
  GLX, explicit Vulkan loaded libvulkan. **Gotcha 19's "blank is Vulkan" is wrong.**
  Forcing OGL is still harmless.
- **Dolphin rewrites `<userDir>/Config/Dolphin.ini` at startup.** Inspect it before launch,
  not after.

### Speed and codec
Smoke replay (75.1 s) on the RTX 5080, parked, null audio. Load was 2 to 12 while recording.
Quality is PSNR/SSIM against the FFV1 dump of the same run, frame-aligned (dumps are
deterministic). "Final" means each consumer's real final encode, compared with the same
final made from FFV1. [measured]

**The encoder is the bottleneck, and Dolphin never tunes it.**
- `avcodec_open2(…, nullptr)` sets no threads, no slices, and no qmin/qmax. [code `AVIDump.cpp`]
- One `FrameDumping` thread does `sws_scale`, then the encode, then the mux. The GPU
  thread waits for it every frame.
- FFV1 is therefore single-threaded, with no ini knob to change that.
- **Speed 0 only helps where the encoder is not the limit** (mpeg4 at native resolution).

**What the ini can select** (GFX.ini `[Settings]`):
- `UseFFV1` overrides `DumpCodec`.
- `DumpCodec` takes a codec *descriptor* name: `utvideo`, `h264` (= libx264), `ffvhuff`,
  `magicyuv` and so on. NVENC can't be selected.
- Non-FFV1 codecs always get yuv420p, so **codecs that need an even width fail at native**
  (939x528 is odd). EFB 6 (2816x1584) is fine.
- `DumpFormat` also sets the file extension. Leave it `avi`.

**EFB 6 (3×, 2816x1584)**: jungle_media's resolution. Its final is lanczos to 1080p, x264 crf 14.

| Dump | Realtime | Size per game | Dump vs FFV1 | Final vs final-from-FFV1 |
|---|---|---|---|---|
| FFV1 | **0.10×** (12 min/game) | 16.2 GB | ref | ref |
| `DumpCodec=utvideo`, `UseFFV1=False` | 0.81× | 11.9 GB | **bit-exact** (after 4:2:0) | 44.1 dB (within 0.07 dB of FFV1's own final) |
| mpeg4 60 Mb/s (**jungle_media today**: its template has `UseFFV1=False`, `BitrateKbps=60000`) | 0.93× | 563 MB | 41.9 dB; worst 34.8 | 41.9 dB; **visible blocking on fast frames** |
| mpeg4 200 Mb/s and above | 0.74× | 1.3 GB (**caps at about 141 Mb/s**) | 46.0 dB | 43.4 dB |
| `DumpCodec=h264` | 0.71×, 13.5 cores | | | **drops the last ~52 frames** (lookahead not flushed at SIGTERM). Never use it. |

- Three in parallel: FFV1 0.32× aggregate, utvideo 2.07×, mpeg4 2.13×. No stalls in any run.

**EFB 2 (native, 939x528)**: lm-clipper's default. Its real profile has `UseFFV1=True`, and its
final is x264 at 50 Mb/s.

| Dump | Realtime | Final vs final-from-FFV1 |
|---|---|---|
| FFV1 | 0.77× | ref (49.2 dB to source) |
| mpeg4, any bitrate | 3.0–3.6× (with speed 0) | **−6 dB**, mild softening. Caps at about 37 Mb/s. |
| utvideo / h264 | fail: odd width | |

**EFB 4 (2×, 1878x1056) and native, from Lunar's rig** — RTX 3060, Linux/X11, 60 s of
footage, `emulationSpeed 0`. [measured 2026-10-10, reported by the Lunar consumer after
migrating both its apps; not reproduced here]

| Dump | Realtime | Size | vs FFV1 |
|---|---|---|---|
| FFV1 at EFB 4 | 0.34× | 3.8 GB/min | ref |
| `utvideo` at EFB 4 | **1.81×** (5.3× faster) | 3.1 GB/min | bit-identical after 4:2:0 on 3465/3504 frames |
| mpeg4 150 Mb/s at EFB 4 | 1.66× | 0.57 GB/min | 42.3 dB |
| FFV1 at native | ~0.95× (65 s incl. boot) | | ref |
| mpeg4 40 Mb/s at native | ~4× (4.3× faster) | | 44.8 dB |

This settles the "utvideo at EFB 4 is unmeasured" caveat: it works (1878 is even) and is
the clear choice there. Note the native FFV1 figure (0.95×) is higher than the 0.77×
measured here on a 5080 — the encoder is CPU-bound, so it tracks the CPU, not the GPU.

**Dumps are NOT frame-count stable across codec and speed.** [measured 2026-10-10, Lunar]
The same frame range produced 3504–3534 frames of an expected 3600 depending on codec and
`emulationSpeed`, and utvideo-vs-FFV1 differed on isolated single frames where Dolphin
dumped a different frame — not an encoder difference. The "dumps are deterministic"
assumption under which the quality tables above were frame-aligned holds **within** a
configuration, not across them. A consumer byte-comparing two runs must hold codec and
speed fixed; a duration guard with a ratio (not an exact frame count) is the right check.

**Recommendations:**
- **Archival VOD (jungle_media): `DumpCodec=utvideo`.** It is about 8× faster than FFV1,
  near-identical in quality, and clearly better than today's mpeg4 60M. Budget about 12 GB of
  temporary disk per game per worker, and delete the dump after the mux. If disk is tight,
  use mpeg4 at `BitrateKbps≥150000`, never 60000.
- **Clips at native: keep FFV1.** mpeg4 at native is a preview-quality fast mode only.
  utvideo at EFB 4 (2×, even width) should work, but is unmeasured.
- **Do not use FFV1 at EFB ≥ 4 for batches.**
- **Gotcha 5 ("preserve UseFFV1") assumed every consumer used FFV1.** jungle_media does
  not. The runner needs a `dumpCodec` option, so the choice is the consumer's.

- `EmulationSpeed=0` gives **bit-identical** video and audio, with the same durations,
  across Xvfb and GPU, short and long replays. [measured]
- At native: FFV1 is capped at 0.77× by the encoder. mpeg4 with speed 0 reaches 3.68×
  alone, and 6.8× aggregate for three in parallel (GPU about 95%). Three parallel FFV1
  runs give 2.2× aggregate. [measured]
- **`EFBScale` is an enum, not a multiplier** [code `VideoConfig.h:42`]:

  | Value | Meaning |
  |---|---|
  | 0 | auto |
  | 1 | auto-integral (window-sized) |
  | 2 | **1×** native (939x528 dump at 16:9) |
  | 3 | 1.5× |
  | 4 | 2× |
  | 5 | 2.5× |
  | 6 | 3× |
  | 7 | 4× |
  | 8 | 5× and so on |

  - jungle_media's 6 is 3×.
  - **MST's `spectate_efb_scale: 3` is 1.5× (about 1408x792), not the "1920x1584" its comment
    claims.** The ~4-feeds load-test ceiling was measured at that setting.
  - The real GFX.ini also carries a second `EFBScale = 7` under `[Hacks]`. Dolphin reads
    `[Settings]`, as the dump sizes confirm.

---

## Per consumer: what to adopt and what would break

| Consumer | Today | Adopt | Don't |
|---|---|---|---|
| **jungle_media** (runner, VOD batches) | Template is ALSA (audible), `Fullscreen=True`; 500 ms xdotool parker by pid; pids from `pgrep -f`; EFB 6 FFV1 | Null audio, `PauseOnFocusLost=False`, small window, pre-map pid parker (use `onSpawn`) | Speed 0 alongside `VOD_WORKERS` without measuring CPU; its duration guard checks only the **minimum** |
| **Lunar Studio** (vendored runner) | Already speed 0, 640x360, VSync off | Null audio; re-vendor for `onSpawn`; throttle `onProgress` (at speed 0 it fires hundreds of times per second) | |
| **lm-clipper** (Electron, Win/mac/Linux; not on the runner) | Inherits ALSA and fullscreen from the real profile; its "Fullscreen" option only toggles `-b`; a new focus steal per clip | Migrate to `record()` first (fixes substring end-frame and unbounded stderr). Then "Show Dolphin while recording" (off = background) and "Mute recordings" | X11 placement on Windows/mac/Wayland must be a quiet no-op. Never background `playClipAsync` (the user is watching). |
| **melee_skins** (runner under xvfb-run) | Plays ALSA audio to the **user's headset** | Null audio | Placement is pointless on Xvfb |
| **replay_archiver** | Mutates the real profile, no `--user`, substring end-frame | Migrate to `record()` first | |
| **frame_grabber** (Python) | Parker grabs **any** Slippi/Dolphin window; the real profile is shared by 2 workers | Pid-scoped parking, per-worker `--user` | **Speed 0 breaks it**: camera writes are locked to `[CURRENT_FRAME]` |
| **slp2mp4** | `RenderToMain=True`, ALSA, applies volume in ffmpeg | Null audio is its mute | `RenderWindow*` keys don't apply under `RenderToMain` |
| **MST** | Title-based parker (`slippi.rs:92-280`) grabs **every** "dolphin/playback/slippi/faster melee" window and resizes it to 1080p, including other projects' recordings and, on the Jungle box, monkeys' netplay windows | Park by pid (the CLI's `started` event carries it); per-feed `application.name`; detach hotkeys | Null audio or volume tricks (OBS needs the stream); speed 0; minimise |

**Rule: exactly one owner per window, by pid.** Title and class matching grabs other
projects' Dolphins. Four projects reimplemented parking, and two of them do it that way.

---

## What the runner offers (built 2026-10-09, branch `background-options`)

Every option is opt-in; omitting it keeps the old behaviour. Two defaults did change,
both measured hazards (listed under "Defaults that changed" below).

**`ProfileOptions` (ini; every OS):**

| Option | Writes | Notes |
|---|---|---|
| `silent: true` | `[DSP] Backend = No audio output` | The recording mute. Conflicts with `audioBackend` (throws). |
| `audioBackend` | `[DSP] Backend` | Now validated against `AUDIO_BACKENDS`, because an unknown string silently mutes. |
| `pauseOnFocusLost` | `[Interface] PauseOnFocusLost` | **Record mode forces False** unless set. |
| `keepWindowOnTop` | `[Display] KeepWindowOnTop` | |
| `detachHotkeys` | `Hotkeys.ini` bound to no device | Record mode always did this; now opt-in for play. |
| `dumpCodec: "ffv1" \| "utvideo" \| "mpeg4"` | `[Settings] UseFFV1` + `DumpCodec` | Record mode only. utvideo is refused at EFBScale 2 (odd width). |
| `gfxBackend` | `[Core] GFXBackend` | Type narrowed to `"OGL" \| "Vulkan"`. |

**`BACKGROUND_RECORD` preset:** `{ pauseOnFocusLost: false, keepWindowOnTop: false,
vsync: false, window: 640x360 }`. Spread it into `buildProfile`. It deliberately leaves
out mute and speed: mute breaks OBS, and speed breaks frame_grabber and mirrors.

**`record()` (`RunOptions`):**
- `env`: extra environment variables for Dolphin.
- `audioSink`: sets `PULSE_SINK` + `PIPEWIRE_NODE`, so both Pulse and ALSA route.
- `appName`: sets `PULSE_PROP_OVERRIDE` `application.name`.
- `recordEnv()` is the pure builder for all of the above.

**`obsMirror()` / CLI:**
- `appName` / `--app-name`.
- `detachHotkeys` / `--detach-hotkeys`.
- `env`, applied *before* the capture variables, so it can't clobber them.

**Defaults that changed:**
- obsMirror `emulationSpeed` **0 → 1**. MST always passed 1.
- obsMirror profile always sets `PauseOnFocusLost=False`.
- Record mode forces `PauseOnFocusLost=False`.

**Removed:**
- `mirror()`: broken leftover, unused.
- `gfxBackend: "Null"` and `"Software Renderer"`: neither exists in this build.

**Verified 2026-10-09:**
- 76 unit tests pass, 22 of them new.
- `npm run smoke` passed: 75.07 s against 75.10 s expected.
- A smoke with `BACKGROUND_RECORD` + `silent` + `utvideo` at EFB 4: 1878x1056 utvideo,
  75.07 s, WAV 75.08 s, 80 s wall, 5.8 GB. No audio client ever connected. The real
  profile was unchanged.
- The CLI was checked with a fake Dolphin: env, ini and Hotkeys.ini all landed.

**Window parking (built 2026-10-09):** `placement: { workspace }` on `record()` and
`obsMirror()`, `--workspace N` on the CLI, and a standalone `placeWindows(pid, …)`. It
finds windows by pid tree only. Measured on GNOME with `WM_STATE` as ground truth (3
recordings + 1 mirror):

| | Result |
|---|---|
| Visible on the user's workspace | ~0.35 s → ~0.7–1.0 s after spawn, then Iconic on the target. Without placement: visible all run. |
| Keyboard focus | Dolphin takes it at ~0.35 s; `restoreFocus` hands it back by ~1 s. Without restore it kept focus 18 s of 36 s. |
| User's workspace | never changed |
| Xvfb (no WM) | skipped with `placement-no-wm`, recording unaffected |
| Xvfb + `required` | refused before spawning |

- **Why the flash can't go to zero on GNOME:** Dolphin's windows are already managed when
  first found, so the pre-map trick rarely wins. mutter also lands the EWMH move about
  0.4 s late, whether it is sent once or re-sent every 100 ms.
- **First version's bug:** it wrote `_NET_WM_DESKTOP` onto mapped windows, read its own
  write back, and reported "placed" while the windows stayed on screen. Fixed, and pinned by
  a test ("NEVER TRUST A PROPERTY YOU WROTE").
- **Untested:** Openbox (the Jungle box), KDE, and XWayland under a Wayland session.

**Seen once, unexplained:** two boot hangs (no frame in 90 s) during branch smoke runs at
00:08 and 00:10 on 2026-10-09. They happened while another session was reworking the audio
stack, and WirePlumber restarted at 00:12. The profiles were byte-identical to `main`'s,
`main` passed at 00:12, and the branch passed at 00:15. Probable cause: the ALSA backend
blocked on the audio server during startup. `silent` never opens an audio backend.

---

## Runner bugs and doc errors this turned up

Items 1–8, 10, 11 and 12 are fixed on the branch. Item 9 is now documented.

1. `gfxBackend: "Null"` does not exist in Ishiiruka and silently did nothing.
2. Gotcha 19 ("blank = Vulkan") was wrong: blank is OGL.
3. Gotcha 20 blamed mutter for the 640x480 fallback; it is Dolphin's own clamp — and
   (2026-10-09) it is only about what Dolphin *opens*: reshaping the window afterwards
   gets the full surface, so the gotcha's "fullscreen is the only option" was wrong too.
4. `efbScale` JSDoc said "multiplier". It is an enum, and 2 = native.
5. `obsMirror` defaulted to `emulationSpeed: 0`, which would fast-forward on air.
6. Record mode didn't force `PauseOnFocusLost=False`, a proven hang.
7. Play mode couldn't detach hotkeys.
8. `RunOptions` had no env passthrough.
9. `record()` rejects on a boot hang that produced no .avi. That is correct; the JSDoc now
   says so.
10. `mirror()` was a broken leftover.
11. `kill.ts`: a failed `spawn("taskkill")` emitted an unhandled async `'error'` on Windows.
12. README and CLAUDE.md said "unconsumed".

Still open, outside the runner:
- MST's title-based parker.
- MST `spectate_efb_scale: 3` is 1.5×.
- jungle_media records mpeg4 60M (consider utvideo).
- lm-clipper's "Fullscreen" label.
- frame_grabber's parker.
- Lunar's stale vendored copy.

---

## Still untested

- Openbox: rules, `focusNew`, and whether MST's `query_tree` parker even sees reparented
  windows.
- The Jungle box's `jungle-virtual` monitor definition (read-only check, not during event
  week).
- A mirror-mode comm on a **growing** .slp while parked.
- `focus-new-windows 'strict'` on GNOME.
- Wayland sessions (XWayland).
- Windows and macOS at runtime.
- The VirtualGL EGL back end (not installed).

## How the tests were run (reuse these methods)

- **Xvfb correctness:** start your own `Xvfb :N -noreset`. `-noreset` matters: Xvfb wipes
  `setmonitor` monitors when its last client disconnects. Then `record()`, `ffmpeg -f framemd5`
  on the video, and an md5 of the WAV PCM. llvmpipe output is deterministic.
- **GPU tests on a desktop:** use a pid-scoped parker only. Act only on windows whose
  `_NET_WM_PID` is in your own tree. Pre-map `_NET_WM_DESKTOP` keeps the user's workspace
  clean.
- **Audio:** use your own `drtest_*` null sinks, with a guard that kills Dolphin if its stream
  lands anywhere else. Match the client's `pipewire.sec.pid`: ALSA streams don't carry
  `application.process.id`. Never `move-sink-input`. Set `PULSE_PROP_OVERRIDE` so no shared
  `dolphin-emu` key is written.
- **Isolated OBS (Flatpak):** `--env=XDG_CONFIG_HOME` is **overridden by Flatpak**. It opened
  the real config once. Set it inside the sandbox instead:
  `flatpak run --command=sh --filesystem=$S com.obsproject.Studio -c "export
  XDG_CONFIG_HOME=$S/obscfg XDG_CACHE_HOME=$S/obscache; exec obs --multi
  --disable-shutdown-check --collection drtest --profile drtest"`. Pre-seed `global.ini`
  `[Locations]`, because the real one hardcodes absolute paths. Put the websocket on a
  non-4455 port. Back up and checksum the real config first.
