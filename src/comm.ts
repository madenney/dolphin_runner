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
