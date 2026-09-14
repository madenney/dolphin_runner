import { promises as fsp } from "node:fs";
import path from "node:path";
import { setEverywhere, setInSection } from "./ini.ts";
import { resolveRealProfile, realProfileExists } from "./paths.ts";
import type { ProfileOptions, RealProfile } from "./types.ts";

/** Dump flags and the sections they live in. Both sections matter for audio. */
const MOVIE_KEYS = ["DumpFrames", "DumpFramesSilent", "DumpAudio", "DumpAudioSilent"] as const;
const DSP_KEYS = ["DumpAudio", "DumpAudioSilent"] as const;

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
 * window geometry, audio backend, and critically GFX `UseFFV1`, which keeps the
 * lossless intermediate feeding the consumer's re-encode — survives untouched.
 */
export async function buildProfile(userDir: string, opts: ProfileOptions & { dolphinPath?: string }): Promise<void> {
  const src: RealProfile =
    opts.sourceProfile ??
    resolveRealProfile(opts.dolphinPath ?? "");
  if (!realProfileExists(src)) {
    throw new Error(
      `no Slippi Playback profile to copy from at ${src.configDir} — ` +
        `open Playback Dolphin once, or pass sourceProfile`,
    );
  }

  const destConfig = path.join(userDir, "Config");
  const destGameSettings = path.join(userDir, "GameSettings");
  await fsp.mkdir(destConfig, { recursive: true });
  await fsp.mkdir(destGameSettings, { recursive: true });

  // 1. Copy every real Config/*.ini as the base.
  const entries = await fsp.readdir(src.configDir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((n) => n.toLowerCase().endsWith(".ini"))
      .map((n) => fsp.copyFile(path.join(src.configDir, n), path.join(destConfig, n)).catch(() => {})),
  );

  const recording = opts.mode === "record";

  // 2. GFX.ini — dump geometry.
  let gfx = await fsp.readFile(path.join(destConfig, "GFX.ini"), "utf8").catch(() => "");
  if (gfx) {
    if (recording) {
      // Created if absent: a profile that has never dumped has no such key, and
      // without it the dump comes out at WINDOW resolution, silently.
      gfx = setInSection(gfx, "Settings", "InternalResolutionFrameDumps", "True");
      if (opts.bitrateKbps != null) gfx = setInSection(gfx, "Settings", "BitrateKbps", String(opts.bitrateKbps));
      if (opts.aspectRatio != null) gfx = setInSection(gfx, "Settings", "AspectRatio", String(opts.aspectRatio));
    }
    if (opts.efbScale != null) gfx = setInSection(gfx, "Settings", "EFBScale", String(opts.efbScale));
    await fsp.writeFile(path.join(destConfig, "GFX.ini"), gfx);
  }

  // 3. Dolphin.ini — the dump flags themselves, in BOTH sections that carry them.
  let dol = await fsp.readFile(path.join(destConfig, "Dolphin.ini"), "utf8").catch(() => "");
  if (dol) {
    const value = recording ? "True" : "False";
    for (const k of MOVIE_KEYS) {
      dol = recording ? setInSection(dol, "Movie", k, value) : setEverywhere(dol, k, value);
    }
    if (recording) for (const k of DSP_KEYS) dol = setInSection(dol, "DSP", k, value);
    await fsp.writeFile(path.join(destConfig, "Dolphin.ini"), dol);
  }

  // 4. Gecko codes, verbatim from the consumer.
  if (opts.geckoIni != null) {
    await fsp.writeFile(path.join(destGameSettings, "GALE01.ini"), opts.geckoIni);
  } else {
    // Copy the real one if there is one, so a consumer that does not manage
    // gecko still gets whatever the profile already had.
    await fsp
      .copyFile(src.gameSettingsIni, path.join(destGameSettings, "GALE01.ini"))
      .catch(() => {});
  }

  // 5. Record mode isolates input. A headless worker must not grab the
  //    operator's real controllers or hotkeys mid-batch.
  if (recording) {
    await fsp.writeFile(path.join(destConfig, "Hotkeys.ini"), "[Hotkeys1]\nDevice = /0/\n");
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
