import crypto from "node:crypto";
import { writeFileSync } from "node:fs";

export interface CommOptions {
  replay: string;
  startFrame: number;
  /**
   * MUST BE FINITE.
   *
   * Without an explicit endFrame Dolphin reports `[PLAYBACK_END_FRAME] INT_MAX`
   * and, having played the game, idles on "waiting for game" forever. The whole
   * batch then hangs on a replay that finished minutes ago.
   */
  endFrame: number;
  /** true = live mirror (window stays up, no dump); false = frame dump. */
  isRealTimeMode: boolean;
}

export interface CommFile {
  mode: "normal";
  replay: string;
  startFrame: number;
  endFrame: number;
  isRealTimeMode: boolean;
  commandId: string;
}

/** The comm file Dolphin is handed with `-i`. Exported for tests. */
export function buildComm(o: CommOptions): CommFile {
  if (!Number.isFinite(o.endFrame)) {
    throw new Error("comm endFrame must be finite — see the INT_MAX hang");
  }
  return {
    mode: "normal",
    replay: o.replay,
    startFrame: o.startFrame,
    endFrame: o.endFrame,
    isRealTimeMode: o.isRealTimeMode,
    // Dolphin ignores a comm file whose commandId it has already seen, so a
    // fresh one per invocation is what makes back-to-back replays work.
    commandId: crypto.randomBytes(12).toString("hex"),
  };
}

export function writeComm(commPath: string, o: CommOptions): CommFile {
  const comm = buildComm(o);
  writeFileSync(commPath, JSON.stringify(comm));
  return comm;
}

/** The comm file for a LIVE mirror. No frame range: Dolphin follows the file. */
export interface MirrorCommFile {
  mode: "mirror";
  replay: string;
  isRealTimeMode: boolean;
  commandId: string;
}

export function buildMirrorComm(replay: string, isRealTimeMode = false): MirrorCommFile {
  return {
    mode: "mirror",
    replay,
    isRealTimeMode,
    commandId: crypto.randomBytes(12).toString("hex"),
  };
}

/**
 * Write a mirror comm. The caller re-points a running Dolphin by calling this
 * again on the same path with the next replay — the fresh commandId is what
 * makes Dolphin notice.
 */
export function writeMirrorComm(commPath: string, replay: string, isRealTimeMode = false): MirrorCommFile {
  const comm = buildMirrorComm(replay, isRealTimeMode);
  writeFileSync(commPath, JSON.stringify(comm));
  return comm;
}
