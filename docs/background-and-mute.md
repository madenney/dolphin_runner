# Running Dolphin in the background, and muting it

Research and tests from 2026-10-08, on the dev box (RTX 5080, driver 580, GNOME/mutter on
Xorg, PipeWire 1.0.5) and Slippi Playback **3.5.2**. That build is Ishiiruka `slippi`
at `bffe989d0`.

The goal is to get Dolphin off the user's screen, stop it stealing focus or input, and
keep it quiet locally without losing audio the dump or OBS needs. It covers recording
(clipper, the VOD recorder, one consumer, the archiver, the skins tool) and live OBS
mirrors (the stream tool).

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

**the stream tool mirror in the background:**

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
  this rig.** pipewire-pulse null sinks, and the rig's own `50-a bracket tool-buses.conf`, set
  `monitor.channel-volumes=true`. Never mute `gameN`.
- **The loopback pattern works.** Loop `A.monitor` to headphones, then mute the loopback's
  sink-input: the headphones go silent and `A.monitor` is untouched.
- **`No audio output`** creates no stream at all.
  - The exact string is `No audio output`.
  - **An unknown backend string also silently falls back to null.** A typo mutes too,
    with no visible warning.
- **ALSA ignores `PULSE_SINK`** and goes to the default sink: on the dev box, the user's headset.
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

  The event box's `xrandr --setmonitor <name> …` must be checked (read-only, after an
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

**EFB 6 (3×, 2816x1584)**: The VOD recorder's resolution. Its final is lanczos to 1080p, x264 crf 14.

| Dump | Realtime | Size per game | Dump vs FFV1 | Final vs final-from-FFV1 |
|---|---|---|---|---|
| FFV1 | **0.10×** (12 min/game) | 16.2 GB | ref | ref |
| `DumpCodec=utvideo`, `UseFFV1=False` | 0.81× | 11.9 GB | **bit-exact** (after 4:2:0) | 44.1 dB (within 0.07 dB of FFV1's own final) |
| mpeg4 60 Mb/s (**the VOD recorder today**: its template has `UseFFV1=False`, `BitrateKbps=60000`) | 0.93× | 563 MB | 41.9 dB; worst 34.8 | 41.9 dB; **visible blocking on fast frames** |
| mpeg4 200 Mb/s and above | 0.74× | 1.3 GB (**caps at about 141 Mb/s**) | 46.0 dB | 43.4 dB |
| `DumpCodec=h264` | 0.71×, 13.5 cores | | | **drops the last ~52 frames** (lookahead not flushed at SIGTERM). Never use it. |

- Three in parallel: FFV1 0.32× aggregate, utvideo 2.07×, mpeg4 2.13×. No stalls in any run.

**EFB 2 (native, 939x528)**: The clip tool's default. Its real profile has `UseFFV1=True`, and its
final is x264 at 50 Mb/s.

| Dump | Realtime | Final vs final-from-FFV1 |
|---|---|---|
| FFV1 | 0.77× | ref (49.2 dB to source) |
| mpeg4, any bitrate | 3.0–3.6× (with speed 0) | **−6 dB**, mild softening. Caps at about 37 Mb/s. |
| utvideo / h264 | fail: odd width | |

**EFB 4 (2×, 1878x1056) and native, from a consumer's rig** — RTX 3060, Linux/X11, 60 s of
footage, `emulationSpeed 0`. [measured 2026-10-10, reported by a consumer after
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

**The software-GL path costs about 40%, and the encoder tracks system load, not
the GPU.** [measured 2026-10-11, reported by a VOD recorder consumer on the
v0.5.3 → v0.5.6 bump; not reproduced here] One 85.9 s game at EFB 6, utvideo,
16:9, null audio backend, on an i9-12900K:

| Where | Realtime |
|---|---|
| Xorg, discrete GPU | **0.96×** |
| Xvfb, software GL, box otherwise idle | ~0.6× |
| Xvfb, software GL, box under load ~13 | 0.33× |

Same build, same settings, same replay — so the spread is the renderer and the
competition for CPU, not the dump. Treat a loaded-box figure as a floor rather
than a measurement: this consumer's 0.33× is the same configuration as its own
0.6×. It also confirms utvideo at EFB 6 on a second rig, and that `record()`'s
end-frame stop lands where it should (5154 of 5157 frames, A/V lengths matched,
picture clean) with the frame count and look unchanged from 0.5.3.

**EFB 4 + utvideo with three Dolphins on one box** — i9-12900K + RTX 5080,
1080p h264_nvenc output, 709-frame (11.82 s) ranges, two other Dolphin instances
running throughout. [measured 2026-10-11, reported by a recording service; not
reproduced here]

| | |
|---|---|
| Dump itself | **0.80x** realtime (16.7-19.2 s per clip) |
| Including boot | ~0.70x (1.9-2.4 s to first frame) |
| h264_nvenc encode of the result | 3.3 s |

Useful as the *contended* case: 0.80x at EFB 4 with two competing emulators,
against 1.81x at EFB 4 on an idle RTX 3060 above. Boot is a fixed ~2 s cost, so
it dominates the ratio on short clips and vanishes on long ones — which is why
the two figures differ by 0.10x on an 11.82 s range.

**"Dolphin produced no video" can be contention, not configuration.**
[observed 2026-10-11, a recording service] Three runs failed that way while two
other Dolphins were running on the same box; later runs in the same session, and
every run after the bump, succeeded with nothing changed. The error means
`record()` found no `<base>.avi` after a full run, and gotcha 16 is the usual
cause (a profile left on another container, or dump keys that were never
created) — but it is a *symptom*, not a diagnosis. Before chasing the profile,
check whether the box was simply oversubscribed, and retry. The run that
produces no AVI produces no diagnostic either, so there is nothing in the
result to tell the two apart.

**Dumps are NOT frame-count stable across codec and speed.** [measured 2026-10-10, a consumer]
The same frame range produced 3504–3534 frames of an expected 3600 depending on codec and
`emulationSpeed`, and utvideo-vs-FFV1 differed on isolated single frames where Dolphin
dumped a different frame — not an encoder difference. The "dumps are deterministic"
assumption under which the quality tables above were frame-aligned holds **within** a
configuration, not across them. A consumer byte-comparing two runs must hold codec and
speed fixed; a duration guard with a ratio (not an exact frame count) is the right check.

**They are not byte-stable run to run either, on the SAME version.**
[measured 2026-10-11, reported by a clip tool and a recording service on the
v0.5.1 -> v0.5.6 bump; not reproduced here] Comparing a 709-frame range recorded
repeatedly: pairs of runs on the *same* version differed by 33-40 dB average
PSNR, with single frames as low as ~17 dB, while one pair *across* the two
versions came out byte-identical in video. So a byte or PSNR comparison between
two runs cannot tell a version change from ordinary run-to-run variation, and a
single byte-identical pair is not evidence that two versions agree. Judge an
upgrade on length, frame count, resolution and audio length — all four of which
did hold exactly across the bump here — not on pixels.

**EFB 3 (1.5×, 1408x792), from the skins tool's rig** — RTX 5080 + i9-12900K, xvfb-run, OGL,
1800 frames, two runs each within 1%. Speed = frames/sec ÷ 60, first frame to last.
[measured 2026-10-10, reported by the skins tool consumer; not reproduced here]

| Dump | speed 1 | speed 0 | notes |
|---|---|---|---|
| FFV1 | 0.50× | 0.50× | encoder-bound; `emulationSpeed 0` does not help |
| `utvideo` | 0.99× | **1.27×** | ~0.5 GB/min, bit-exact to FFV1 after 4:2:0 |
| mpeg4 | 0.99× | **1.28×** | same at 20 and 60 Mb/s; 38.9 dB and 45.4 dB vs FFV1 |

**At EFB 3 the ceiling is emulation, not the encoder.** utvideo and mpeg4 both stop at
~1.27×, so lossy buys nothing over lossless at this size — **mpeg4's speed advantage is a
native/low-resolution thing.** `emulationSpeed 0` gave identical decoded frames (ffmpeg
framemd5) for all three codecs.

**`emulationSpeed 0` also shortens BOOT, whatever the codec.** Time to the first frame went
3.8 s → 1.1 s (EFB 3, start frame 0), and a 20-frame dump went 6.0 s → 3.6 s total on FFV1.
So the rule "speed 0 only helps when the encoder is not the bottleneck" is about THROUGHPUT;
boot is a flat win, and it dominates short dumps — stills, desync checks, stage shots.
[measured 2026-10-10, the skins tool]

**"utvideo is bit-exact to FFV1 after 4:2:0" holds only if you do not SCALE first.**
[measured 2026-10-10, the skins tool] FFV1 dumps are bgra, so a consumer that upscales before
encoding (1408 → 1920 for x264 yuv420p) subsamples chroma *after* scaling, while utvideo was
already subsampled at the dump size. The two finals differ by ~44 dB PSNR — not visible at
2× zoom, but not identical. If your pipeline scales, "bit-exact" describes the dump, not
your output.

**Recommendations:**
- **Archival VOD (the VOD recorder): `DumpCodec=utvideo`.** It is about 8× faster than FFV1,
  near-identical in quality, and clearly better than today's mpeg4 60M. Budget about 12 GB of
  temporary disk per game per worker, and delete the dump after the mux. If disk is tight,
  use mpeg4 at `BitrateKbps≥150000`, never 60000.
- **Clips at native: keep FFV1.** mpeg4 at native is a preview-quality fast mode only.
  utvideo at EFB 4 (2×, even width) should work, but is unmeasured.
- **Do not use FFV1 at EFB ≥ 4 for batches.**
- **Gotcha 5 ("preserve UseFFV1") assumed every consumer used FFV1.** The VOD recorder does
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

  - The VOD recorder's 6 is 3×.
  - **the stream tool's `spectate_efb_scale: 3` is 1.5× (about 1408x792), not the "1920x1584" its comment
    claims.** The ~4-feeds load-test ceiling was measured at that setting.
  - The real GFX.ini also carries a second `EFBScale = 7` under `[Hacks]`. Dolphin reads
    `[Settings]`, as the dump sizes confirm.

---

## Per consumer: what to adopt and what would break

| Consumer | Today | Adopt | Don't |
|---|---|---|---|
| **the VOD recorder** (runner, VOD batches) | Template is ALSA (audible), `Fullscreen=True`; 500 ms xdotool parker by pid; pids from `pgrep -f`; EFB 6 FFV1 | Null audio, `PauseOnFocusLost=False`, small window, pre-map pid parker (use `onSpawn`) | Speed 0 alongside `VOD_WORKERS` without measuring CPU; its duration guard checks only the **minimum** |
| **one consumer** (vendored runner) | Already speed 0, 640x360, VSync off | Null audio; re-vendor for `onSpawn`; throttle `onProgress` (at speed 0 it fires hundreds of times per second) | |
| **the clip tool** (Electron, Win/mac/Linux; not on the runner) | Inherits ALSA and fullscreen from the real profile; its "Fullscreen" option only toggles `-b`; a new focus steal per clip | Migrate to `record()` first (fixes substring end-frame and unbounded stderr). Then "Show Dolphin while recording" (off = background) and "Mute recordings" | X11 placement on Windows/mac/Wayland must be a quiet no-op. Never background `playClipAsync` (the user is watching). |
| **the skins tool** (runner under xvfb-run) | Plays ALSA audio to the **user's headset** | Null audio | Placement is pointless on Xvfb |
| **the archiver** | Mutates the real profile, no `--user`, substring end-frame | Migrate to `record()` first | |
| **frame_grabber** (Python) | Parker grabs **any** Slippi/Dolphin window; the real profile is shared by 2 workers | Pid-scoped parking, per-worker `--user` | **Speed 0 breaks it**: camera writes are locked to `[CURRENT_FRAME]` |
| **slp2mp4** | `RenderToMain=True`, ALSA, applies volume in ffmpeg | Null audio is its mute | `RenderWindow*` keys don't apply under `RenderToMain` |
| **the stream tool** | Title-based parker grabs **every** "dolphin/playback/slippi/faster melee" window and resizes it to 1080p, including other projects' recordings and, on the event box, another user's netplay windows | Park by pid (the CLI's `started` event carries it); per-feed `application.name`; detach hotkeys | Null audio or volume tricks (OBS needs the stream); speed 0; minimise |

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
- obsMirror `emulationSpeed` **0 → 1**. The stream tool always passed 1.
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
- **Untested:** Openbox (the event box), KDE, and XWayland under a Wayland session.

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
- The stream tool's title-based parker.
- The stream tool `spectate_efb_scale: 3` is 1.5×.
- The VOD recorder records mpeg4 60M (consider utvideo).
- The clip tool's "Fullscreen" label.
- frame_grabber's parker.
- a consumer's stale vendored copy.

---

## Still untested

- Openbox: rules, `focusNew`, and whether the stream tool's `query_tree` parker even sees reparented
  windows.
- The event box's virtual-monitor definition (read-only check, not during event
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

---

## Hiding a recording on every OS: the `hide` option (built 2026-10-14)

`placement` only parks an X11 window. `hide` is the cross-OS version — no window
on screen, no focus steal, no taskbar/Dock — set on both `buildProfile` (ini
half) and `record()` (runtime half), reported on `RecordResult.hide`. Dumps are
unchanged because `InternalResolutionFrameDumps=True` reads from an off-screen
FBO (measured on Linux; the same code path on Windows/macOS). `hide: true` is the
default per-OS method; `hide: "desktop"` selects the experimental Windows
separate-desktop launcher.

### Linux — implemented AND verified here (X11/GNOME)

- EWMH window parking by pid, defaulting to workspace `"last"` (the trailing
  workspace, so GNOME's dynamic workspaces always have a target; a fixed number
  can fail with `placement-no-workspace`).
- Session-aware dispatch (`detectSession`): GNOME/KDE on X11 or XWayland →
  EWMH parking; **sway** → `swaymsg '[pid=N] move scratchpad'`; **Hyprland** →
  `hyprctl dispatch movetoworkspacesilent special:lunar,pid:N`; wlroots/other
  Wayland with no known IPC → a `hide-session-unsupported` warning (honest, not
  a silent fail). Everything is by pid, never by title (the project rule).
- Verified end to end on this box: see "Verified here" below.

### Windows — measured on the Windows rig (2026-10-14/15)

What the rig found (Windows 11, NVIDIA, Slippi Playback 3.5.2; the section
below is the original pre-rig plan, kept for the reasoning):

- **Hidden desktop wins.** Through `lunar-hidden-launcher.exe`: 0 ms visible, 0
  taskbar buttons, no flashes, focus kept with 4 in parallel (a visible Dolphin
  stole it), dumps frame-identical to visible, and a 20-clip and a 4x5 batch
  left no processes or desktops behind. `hide: true` now means this.
- **The plain hidden window could not be stopped.** `windowsHide` + RenderToMain
  never received taskkill's WM_CLOSE (Dolphin logged no stop at all), so the
  dump was force-killed without its index every time, x1 and x4, OGL/DX11/
  Vulkan. The rig's own shim, which PostMessages WM_CLOSE to every window of
  the pid, finalised the same configuration. Dropped.
- **DX11 drops frames**: 3240 of 3600 at 0.78x even visible, WAV 5.9 s longer
  than the video. OGL and Vulkan are frame-exact. `hide` pins OGL.
- **Speed.** Visible recordings copied Slippi's `VSync = True` and ran at
  exactly 1.00x; with VSync off (BACKGROUND_RECORD) visible and hidden match.
  Hidden, the encoder is the limit: ffv1 1.19x at EFB 2, 0.34x at EFB 4, 0.16x
  at EFB 6; mpeg4 (150 Mb/s) 3.99x / 1.26x / 0.62x. x4 per Dolphin: ffv1
  1.03x / 0.32x / 0.15x, mpeg4 2.87x / 1.04x / 0.55x.
- **Only ffv1 and mpeg4 encode** (see the README's codec section): utvideo,
  ffvhuff, huffyuv, magicyuv, zmbv write no video; libx264 / h264_nvenc fall
  back to mpeg4 with "Invalid codec" in the log.
- **Hidden Dolphins exit with 0xC0000409** after finalising (both files fine),
  ~2 s after the end frame; visible ones exit 0 in ~0.6-1 s.
- **Slow exits at x4.** Sometimes all four Dolphins sat in "Shutting down HW"
  for 8-14 s and left it at the same millisecond (cause not found; it did not
  reproduce on a later run with the same settings). AVIDump is finalised
  before that, the WAV only after it, so a forced stop leaves the WAV sizes
  unwritten: the grace is 15 s on Windows and `record()` repairs the header.

### Windows — the original plan (pre-rig)

Ship-first recipe (A in the research), all written, none run on Windows:

- `buildProfile` writes, in record mode, for win32: `[Display] RenderToMain=True`,
  `Fullscreen=False`, `DisableScreenSaver=False`; `[Interface] MainWindow{Width,
  Height,PosX,PosY}` small; `[Core] GFXBackend=DX11` (unless the caller set a
  backend). RenderToMain is the Windows/macOS Playback default and is what makes
  one hidden window cover everything; the `MainWindow*` keys (not `RenderWindow*`)
  are the backbuffer size under it. The `GetName()` backend strings are exactly
  `DX11`/`D3D12`/`DX9`/`OGL`/`Vulkan` (read in Ishiiruka `slippi`); the
  `gfxBackend` type was widened to include them.
- `record()` spawns with `windowsHide: true`, so the first `ShowWindow` on
  `CFrame` is `SW_HIDE`: no window, no taskbar button.
- Optional native opt-outs (`win-native.ts`), loaded lazily and only if the host
  app installs `koffi` (this package keeps `dependencies = {}`): HighQoS
  (`SetProcessInformation` / `ProcessPowerThrottling`, so a hidden+muted Dolphin
  isn't dropped to E-cores) and `LockSetForegroundWindow` around the spawn (so a
  hidden Dolphin can't take keyboard focus while the parent app is foreground).
  Without koffi they are clean no-ops with a `hide-native-unavailable` warning;
  hiding still works.
- The graceful stop is unchanged: `taskkill /T` without `/F` posts WM_CLOSE and
  AVIDump finalises the `.avi` (relies on `ConfirmStop=False`, already forced).
- `hide: "desktop"` is the experimental separate-desktop launcher
  (`native/win/hidden_launcher.c`: CreateDesktop + `STARTUPINFO.lpDesktop`,
  stdio passthrough, a Job object with KILL_ON_JOB_CLOSE, HighQoS, and a `CLOSE`
  stdin command that posts WM_CLOSE to its windows on that desktop). No
  cross-compiler was available here, so it is **not built**; build with
  `native/win/build.sh` (mingw-w64) or `build.bat` (MSVC), sign it with the
  installer's certificate, and keep the hash stable (AV reputation). The runner
  marks the method `windows-desktop` and `verified:false`; spawning *through* the
  launcher is the remaining wiring for the Windows rig.
- **For the Windows rig:** confirm no visible window from t=0 (the SW_HIDE hits
  `CFrame`), focus never moves (with and without the LSFW lock), 0 taskbar
  buttons, every `.avi` indexed with **0** `/F` escalations, and speed within ~5%
  of visible with HighQoS (grid: A vs B, with/without HighQoS, DX11, 1 and 4
  parallel). The VirtualBox Win10 VM covers functional checks; GPU/speed needs
  real NVIDIA/AMD/Intel incl. a 12th-gen hybrid on battery.

### macOS — implemented, UNVERIFIED (needs a Mac)

- `buildProfile` forces `GFXBackend=OGL` in record mode (occluded
  Vulkan/MoltenVK drops to ~1 FPS; OpenGL does not and dumps from the FBO).
- `record()` hides the process by pid with `NSRunningApplication(pid).hide()`
  via `osascript -l JavaScript` (no TCC prompt; by pid, never by name).
- `prepareMacRecorderApp()` builds a cached **accessory** copy of the Playback
  app (ditto/clone, strip quarantine, `LSUIElement=YES`, own `CFBundleIdentifier`,
  ad-hoc re-sign with the original entitlements), keyed on the source app's
  version + mtime (rebuilt on a Slippi update). An accessory app has no Dock
  tile, no menu bar, no Cmd-Tab and is not activated at launch. The consumer
  passes `result.app` as `dolphinPath`; on any failure it returns the original
  app and the recording still runs (visible). The build steps, cache key and
  hide argv are unit-tested; nothing ran on a Mac.
- **For a Mac:** verify a copied+re-signed accessory bundle honours `--user` and
  `--cout`, that `hide()` on a direct-spawned instance hides its window, that
  dumps stay byte-identical (OGL, occluded/minimised), and the focus/Dock/visible
  checks (`CGWindowListCopyWindowInfo`, `lsappinfo`, `NSWorkspace.frontmost`).

### Verified here (Linux, this box)

See the run under "Smoke / E2E" in this repo's test notes: `hide: true` produced
a correct dump with **no Dolphin window on the current workspace** and **focus
kept**, parked on the trailing workspace by pid. All 209 unit tests pass,
including 29 new `hide` tests (per-OS ini, session detection, the controller with
injected platform/env/exec/native, the compositor/mac/win argv, and the report)
plus a placement "last" test.
