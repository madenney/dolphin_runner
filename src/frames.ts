/**
 * Parsing Dolphin's `--cout` chatter.
 *
 * Pulled out of the spawn loop so the rule that has broken in two separate
 * projects — how you decide "we reached the end" — is a pure function with
 * tests, not a condition buried in a stream handler.
 */
export type FrameLine =
  | { kind: "current"; frame: number }
  | { kind: "playbackEnd"; frame: number }
  | { kind: "gameEnd"; frame: number }
  | { kind: "other" };

export function parseFrameLine(line: string): FrameLine {
  let m = /\[PLAYBACK_END_FRAME\] (-?[0-9]+)/.exec(line);
  if (m) return { kind: "playbackEnd", frame: parseInt(m[1]!, 10) };
  m = /\[GAME_END_FRAME\] (-?[0-9]+)/.exec(line);
  if (m) return { kind: "gameEnd", frame: parseInt(m[1]!, 10) };
  m = /\[CURRENT_FRAME\] (-?[0-9]+)/.exec(line);
  if (m) return { kind: "current", frame: parseInt(m[1]!, 10) };
  return { kind: "other" };
}

/**
 * Has playback reached the end?
 *
 * NUMERIC `>=`. Not `==`, and never a substring test. Both alternatives have
 * shipped and both hang or truncate:
 *   - substring: `[CURRENT_FRAME] 845` matches inside `8454`, so an 8454-frame
 *     game is killed at frame 845 and the dump is truncated to a tenth.
 *   - `==`: if Dolphin never prints that exact frame (it skips), the kill never
 *     fires and the process idles on "waiting for game" forever.
 */
export function reachedEnd(current: number, end: number): boolean {
  return Number.isFinite(end) && current >= end;
}

/**
 * Fold a newly reported end frame into the one we hold.
 *
 * The EARLIER wins: Dolphin reports both `[PLAYBACK_END_FRAME]` and
 * `[GAME_END_FRAME]` and they can disagree, and taking the later one lets a
 * clip range overrun into the rest of the game.
 */
export function foldEnd(currentEnd: number, reported: number): number {
  return Math.min(currentEnd, reported);
}
