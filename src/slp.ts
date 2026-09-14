import { readFileSync } from "node:fs";

/**
 * Last frame index from a `.slp`'s UBJSON metadata footer, or null.
 *
 * Deliberately a byte scan rather than slippi-js: this is the ONLY thing the
 * runner needs out of a replay, and pulling a parser in for one int32 would
 * make the package heavy for every consumer. The footer ends with
 * `…"lastFrame"l<int32be>…`, so find the key and read the four bytes after the
 * 'l' type marker.
 */
export function lastFrameOf(slpPath: string): number | null {
  let buf: Buffer;
  try {
    buf = readFileSync(slpPath);
  } catch {
    return null;
  }
  const i = buf.lastIndexOf(Buffer.from("lastFrame"));
  if (i < 0) return null;
  // 'l' is UBJSON's int32 marker. Anything else means we matched the string
  // somewhere that isn't the metadata field.
  if (buf.subarray(i + 9, i + 10).toString() !== "l") return null;
  if (i + 14 > buf.length) return null;
  return buf.readInt32BE(i + 10);
}
