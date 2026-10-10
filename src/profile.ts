import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getInSection, setEverywhere, setInSection } from "./ini.ts";
import { resolveRealProfile, realProfileExists } from "./paths.ts";
import type { AudioBackend, ProfileOptions, RealProfile } from "./types.ts";

/** Dump flags and the sections they live in. Both sections matter for audio. */
const MOVIE_KEYS = ["DumpFrames", "DumpFramesSilent", "DumpAudio", "DumpAudioSilent"] as const;
const DSP_KEYS = ["DumpAudio", "DumpAudioSilent"] as const;

/** Ishiiruka's null audio backend (`BACKEND_NULLSOUND`, ConfigManager.h). */
export const NULL_AUDIO_BACKEND = "No audio output";

/**
 * Every `[DSP] Backend` string Ishiiruka knows. Dolphin falls back to the null
 * backend on anything else — silently — so an unknown string is a mute nobody
 * asked for, and buildProfile refuses it.
 */
export const AUDIO_BACKENDS: readonly AudioBackend[] = [
  NULL_AUDIO_BACKEND,
  "ALSA",
  "Pulse",
  "Cubeb",
  "OpenAL",
  "AOSound",
  "CoreAudio",
  "Exclusive WASAPI",
  "Shared-mode WASAPI",
  "DSound",
  "XAudio2",
  "OpenSLES",
];

/**
 * What a recording that should stay out of the user's way wants, and nothing
 * that could break a consumer: no focus pause (a parked window loses focus and
 * would hang), not on top, no vsync gating, a small window (the dump is
 * internal-resolution, so window size doesn't matter to it). Deliberately NOT
 * included: `silent` (a consumer may want to hear it) and `emulationSpeed`
 * (frame_grabber's camera sync breaks at unlimited speed). Spread it in:
 * `buildProfile(dir, { ...BACKGROUND_RECORD, mode: "record", efbScale: 6 })`.
 */
export const BACKGROUND_RECORD = {
  pauseOnFocusLost: false,
  keepWindowOnTop: false,
  vsync: false,
  window: { width: 640, height: 360 },
} as const satisfies Partial<ProfileOptions>;

/**
 * Build a throwaway `--user` profile at `userDir` by COPYING the real one and
 * applying overrides to the copies.
 *
 * NEVER MUTATES THE REAL PROFILE. Previous in-place versions of this idea (in
 * more than one project) changed the user's own Dolphin settings every time a
 * clip was previewed or recorded — so opening Dolphin by hand afterwards
 * inherited a framedump rig, which on Windows also throws a blocking
 * "overwrite dtkdump.wav?" dialog.
 *
 * `Sys/` is NOT copied and does not need to be: Dolphin finds it relative to
 * the binary (it ships next to the AppImage/exe).
 *
 * Every ini is copied first, so anything we do not explicitly override —
 * window geometry, audio backend, and critically the dump codec (`UseFFV1` /
 * `DumpCodec`, the consumer's quality/speed choice) — survives untouched.
 */
export async function buildProfile(userDir: string, opts: ProfileOptions & { dolphinPath?: string }): Promise<void> {
  if (opts.silent && opts.audioBackend != null && opts.audioBackend !== NULL_AUDIO_BACKEND) {
    throw new Error(`silent and audioBackend ${JSON.stringify(opts.audioBackend)} contradict each other`);
  }
  if (opts.audioBackend != null && !AUDIO_BACKENDS.includes(opts.audioBackend)) {
    throw new Error(
      `unknown audioBackend ${JSON.stringify(opts.audioBackend)} — Dolphin would silently fall back to ` +
        `no audio. One of: ${AUDIO_BACKENDS.join(", ")}`,
    );
  }
  const src: RealProfile =
    opts.sourceProfile ??
    resolveRealProfile(opts.dolphinPath ?? "");
  const fresh = opts.freshProfile === true;
  if (!fresh && !realProfileExists(src)) {
    throw new Error(
      `no Slippi Playback profile to copy from at ${src.configDir} — ` +
        `open Playback Dolphin once, or pass sourceProfile`,
    );
  }

  const destConfig = path.join(userDir, "Config");
  const destGameSettings = path.join(userDir, "GameSettings");
  await fsp.mkdir(destConfig, { recursive: true });
  await fsp.mkdir(destGameSettings, { recursive: true });

  // 1. Copy every real Config/*.ini as the base — or, fresh, start from
  //    nothing: the overrides below CREATE their keys, Dolphin defaults the rest.
  if (fresh) {
    for (const n of ["Dolphin.ini", "GFX.ini"]) await fsp.writeFile(path.join(destConfig, n), "");
  } else {
    const entries = await fsp.readdir(src.configDir).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((n) => n.toLowerCase().endsWith(".ini"))
        .map((n) => fsp.copyFile(path.join(src.configDir, n), path.join(destConfig, n)).catch(() => {})),
    );
  }

  const recording = opts.mode === "record";

  // 2. GFX.ini — dump geometry.
  let gfx = await fsp.readFile(path.join(destConfig, "GFX.ini"), "utf8").catch(() => "");
  if (gfx || fresh) {
    if (recording) {
      // Created if absent: a profile that has never dumped has no such key, and
      // without it the dump comes out at WINDOW resolution, silently.
      gfx = setInSection(gfx, "Settings", "InternalResolutionFrameDumps", "True");
      if (opts.bitrateKbps != null) gfx = setInSection(gfx, "Settings", "BitrateKbps", String(opts.bitrateKbps));
      if (opts.aspectRatio != null) gfx = setInSection(gfx, "Settings", "AspectRatio", String(opts.aspectRatio));
    }
    if (opts.efbScale != null) {
      gfx = setInSection(gfx, "Settings", "EFBScale", String(opts.efbScale));
      // Ishiiruka keeps a SECOND EFBScale under [Hacks], and leaving the two
      // disagreeing gives a dump at the wrong internal resolution. Two
      // consumers independently discovered this and patched every occurrence
      // after calling us; do it here instead. setEverywhere only rewrites keys
      // that exist, so this is a no-op on a profile that has just the one.
      gfx = setEverywhere(gfx, "EFBScale", String(opts.efbScale));
    }
    if (recording && opts.dumpCodec != null) gfx = setDumpCodec(gfx, opts.dumpCodec);
    if (recording) {
      // PIN THE CONTAINER. record() asserts a `<base>.avi` exists afterwards,
      // so a source profile left on another DumpFormat — or on frame-by-frame
      // PNGs — fails only AFTER a full-length run, with "produced no video".
      // Both are overridable for a consumer that genuinely wants something else.
      gfx = setInSection(gfx, "Settings", "DumpFormat", opts.dumpFormat ?? "avi");
      gfx = setInSection(
        gfx,
        "Settings",
        "DumpFramesAsImages",
        opts.dumpFramesAsImages ? "True" : "False",
      );
    }
    if (opts.hiresTextures != null || opts.texturePacks?.length) {
      gfx = setInSection(gfx, "Settings", "HiresTextures", opts.hiresTextures === false ? "False" : "True");
    }
    if (opts.cacheHiresTextures != null) {
      gfx = setInSection(gfx, "Settings", "CacheHiresTextures", opts.cacheHiresTextures ? "True" : "False");
    }
    if (opts.msaa != null) {
      gfx = setInSection(gfx, "Settings", "MSAA", String(msaaSamples(opts.msaa)));
      gfx = setInSection(gfx, "Settings", "SSAA", "False");
    }
    if (opts.vsync != null) gfx = setInSection(gfx, "Hardware", "VSync", opts.vsync ? "True" : "False");
    if (opts.shaderCompilationMode != null) {
      gfx = setInSection(gfx, "Settings", "ShaderCompilationMode", String(opts.shaderCompilationMode));
    }
    await fsp.writeFile(path.join(destConfig, "GFX.ini"), gfx);
  }

  // 3. Dolphin.ini — the dump flags themselves, in BOTH sections that carry them.
  let dol = await fsp.readFile(path.join(destConfig, "Dolphin.ini"), "utf8").catch(() => "");
  if (dol || fresh) {
    const value = recording ? "True" : "False";
    for (const k of MOVIE_KEYS) {
      // A fresh play profile has no dump keys at all, which already means off.
      if (recording) dol = setInSection(dol, "Movie", k, value);
      else if (!fresh) dol = setEverywhere(dol, k, value);
    }
    if (recording) for (const k of DSP_KEYS) dol = setInSection(dol, "DSP", k, value);

    // Live-window tuning. Every one of these is CREATED if absent — a real
    // profile that has never been captured has no GFXBackend line to rewrite,
    // and one left on Vulkan captures black.
    if (opts.gfxBackend != null) dol = setInSection(dol, "Core", "GFXBackend", opts.gfxBackend);
    if (opts.audioLatencyMs != null) dol = setInSection(dol, "Core", "Latency", String(opts.audioLatencyMs));
    if (opts.emulationSpeed != null) dol = setInSection(dol, "Core", "EmulationSpeed", String(opts.emulationSpeed));
    const backend = opts.silent ? NULL_AUDIO_BACKEND : opts.audioBackend;
    if (backend != null) dol = setInSection(dol, "DSP", "Backend", backend);
    if (opts.volume != null) dol = setInSection(dol, "DSP", "Volume", String(opts.volume));
    // A hidden or parked recording loses focus by design; with this True it
    // pauses and the run dies to the watchdog (measured). Record mode forces it
    // off unless the caller says otherwise.
    const pauseOnFocusLost = opts.pauseOnFocusLost ?? (recording ? false : undefined);
    if (pauseOnFocusLost != null) {
      dol = setInSection(dol, "Interface", "PauseOnFocusLost", pauseOnFocusLost ? "True" : "False");
    }
    if (opts.keepWindowOnTop != null) {
      dol = setInSection(dol, "Display", "KeepWindowOnTop", opts.keepWindowOnTop ? "True" : "False");
    }
    if (opts.window?.fullscreen) {
      dol = setInSection(dol, "Display", "Fullscreen", "True");
    } else if (opts.window) {
      const w = opts.window;
      dol = setInSection(dol, "Display", "Fullscreen", "False");
      dol = setInSection(dol, "Display", "RenderWindowAutoSize", "False");
      dol = setInSection(dol, "Display", "RenderWindowWidth", String(w.width));
      dol = setInSection(dol, "Display", "RenderWindowHeight", String(w.height));
      if (w.x != null) dol = setInSection(dol, "Display", "RenderWindowXPos", String(w.x));
      if (w.y != null) dol = setInSection(dol, "Display", "RenderWindowYPos", String(w.y));
    }
    await fsp.writeFile(path.join(destConfig, "Dolphin.ini"), dol);
  }

  // 4. Gecko codes, verbatim from the consumer.
  const settingsId = opts.gameSettingsId?.trim() || "GALE01";
  if (!/^[A-Za-z0-9_.-]+$/.test(settingsId)) throw new Error(`bad gameSettingsId: ${settingsId}`);
  if (opts.geckoIni != null) {
    await fsp.writeFile(path.join(destGameSettings, `${settingsId}.ini`), opts.geckoIni);
  } else if (!fresh) {
    // Copy the real one if there is one, so a consumer that does not manage
    // gecko still gets whatever the profile already had.
    await fsp
      .copyFile(src.gameSettingsIni, path.join(destGameSettings, "GALE01.ini"))
      .catch(() => {});
  }

  // 5. Record mode isolates input. A headless worker must not grab the
  //    operator's real controllers or hotkeys mid-batch. Play mode can opt in:
  //    a mirror steals focus at launch and would take the operator's keystrokes.
  if (recording || opts.detachHotkeys) {
    await fsp.writeFile(path.join(destConfig, "Hotkeys.ini"), "[Hotkeys1]\nDevice = /0/\n");
  }

  // 6. HD texture packs. Dolphin looks in `<userDir>/Load/Textures/<gameId>/`,
  //    a layout each consumer had to learn and reproduce by hand after we had
  //    already built the profile.
  if (opts.texturePacks?.length) {
    await linkTexturePacks(userDir, settingsId, opts.texturePacks, opts.texturePackMode ?? "symlink");
  }

  // 7. Non-ini profile assets. `GC/SRAM.raw` is the memory card carrying the
  //    console's language and sound settings: without it a throwaway profile
  //    boots with different settings than the operator's real one, so two
  //    consumers independently shelled out to `cp` after calling us.
  for (const rel of assetsToCopy(opts)) {
    const from = path.join(src.root, rel);
    const to = path.join(userDir, rel);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, to).catch(() => {}); // absent is normal, never fatal
  }

  // 8. Persistent shader cache, best-effort. A stale real dir or a wrong
  //    symlink from a previous run is replaced; anything else is left alone.
  if (opts.shaderCacheDir && os.type() !== "Windows_NT") {
    await linkShaderCache(userDir, opts.shaderCacheDir);
  }
}

/**
 * Set the dump codec in GFX `[Settings]`. `UseFFV1` overrides `DumpCodec` in
 * Dolphin, so both are always written. utvideo needs an even dump width and
 * native (EFBScale 2) dumps 939 wide — Dolphin then writes no video at all,
 * which only shows up as "produced no video" after a full-length run.
 */
function setDumpCodec(gfx: string, codec: string): string {
  if (codec !== "ffv1" && codec !== "utvideo" && codec !== "mpeg4") {
    throw new Error(`unknown dumpCodec ${JSON.stringify(codec)} — ffv1, utvideo or mpeg4`);
  }
  if (codec === "utvideo" && getInSection(gfx, "Settings", "EFBScale")?.trim() === "2") {
    throw new Error("dumpCodec utvideo needs an even dump width; EFBScale 2 (native) dumps 939 wide — use ffv1 or mpeg4");
  }
  if (codec === "ffv1") return setInSection(gfx, "Settings", "UseFFV1", "True");
  gfx = setInSection(gfx, "Settings", "UseFFV1", "False");
  return setInSection(gfx, "Settings", "DumpCodec", codec);
}

/** Dolphin's valid MSAA sample counts; anything else is off (1). */
export function msaaSamples(n: number): number {
  return n === 2 || n === 4 || n === 8 ? n : 1;
}

/** `GC/SRAM.raw` unless told otherwise, plus whatever else the caller names. */
function assetsToCopy(opts: ProfileOptions): string[] {
  if (opts.copyFromProfile) return opts.copyFromProfile;
  return opts.mode === "record" || opts.sram ? ["GC/SRAM.raw"] : [];
}

/**
 * Put each pack under `<userDir>/Load/Textures/<gameId>/<packName>`.
 *
 * Symlinks by default: a pack is hundreds of MB and a per-clip copy is the
 * difference between a batch that runs and one that fills the disk. Copy mode
 * exists for Windows, where a symlink needs a privilege a user may not have.
 */
async function linkTexturePacks(
  userDir: string,
  gameId: string,
  packs: string[],
  mode: "symlink" | "copy",
): Promise<void> {
  const root = path.join(userDir, "Load", "Textures", gameId);
  await fsp.mkdir(root, { recursive: true });
  for (const pack of packs) {
    const dest = path.join(root, path.basename(pack));
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
    if (mode === "copy") {
      await fsp.cp(pack, dest, { recursive: true });
      continue;
    }
    try {
      await fsp.symlink(path.resolve(pack), dest, "junction");
    } catch {
      // No symlink privilege (Windows) — a copy is slower but correct.
      await fsp.cp(pack, dest, { recursive: true });
    }
  }
}

async function linkShaderCache(userDir: string, target: string): Promise<void> {
  const link = path.join(userDir, "Cache");
  try {
    await fsp.mkdir(target, { recursive: true });
    const st = await fsp.lstat(link).catch(() => null);
    if (st?.isSymbolicLink()) {
      if ((await fsp.readlink(link)) === target) return;
      await fsp.unlink(link);
    } else if (st) {
      await fsp.rm(link, { recursive: true, force: true });
    }
    await fsp.symlink(target, link);
  } catch {
    /* the old behaviour (a cold cache in userDir), never a failed build */
  }
}

/**
 * Force the REAL profile's dump flags off, once.
 *
 * Nothing here writes the real profile any more, so this exists purely to HEAL
 * a profile damaged by an older in-place version — after which opening Dolphin
 * to just watch a replay never inherits a framedump rig. Only rewrites keys
 * that already exist; a missing Dolphin.ini is a no-op.
 */
export async function healRealProfile(dolphinPath: string, source?: RealProfile): Promise<void> {
  const src = source ?? resolveRealProfile(dolphinPath);
  let contents: string;
  try {
    contents = await fsp.readFile(src.dolphinIni, "utf8");
  } catch {
    return;
  }
  let out = contents;
  for (const k of MOVIE_KEYS) out = setEverywhere(out, k, "False");
  if (out !== contents) await fsp.writeFile(src.dolphinIni, out);
}
