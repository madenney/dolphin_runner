import { readFileSync } from "node:fs";

/** Slippi event command bytes we care about. Both carry the frame at offset 1. */
const EVENT_PAYLOADS = 0x35;
const POST_FRAME_UPDATE = 0x38;
const FRAME_BOOKEND = 0x3c;

/**
 * Last frame index from a `.slp`, or null.
 *
 * Deliberately a byte scan rather than slippi-js: this is the ONLY thing the
 * runner needs out of a replay, and pulling a parser in for one int32 would
 * make the package heavy for every consumer.
 *
 * Tries the UBJSON metadata footer first (one read, no parsing) and falls back
 * to walking the raw event stream. The fallback is not theoretical: anonymised
 * ranked replays carry metadata with no `lastFrame` at all, and before it
 * existed a consumer worked around the hard failure by REWRITING the replay
 * file with a patched footer (Lunar Studio, `record.js`). Verified against 356
 * real replays: the footer path is identical to jungle_media's implementation
 * on every one.
 */
export function lastFrameOf(slpPath: string): number | null {
  let buf: Buffer;
  try {
    buf = readFileSync(slpPath);
  } catch {
    return null;
  }
  return lastFrameFromFooter(buf) ?? lastFrameFromEvents(buf);
}

/** `…"lastFrame"l<int32be>…` — find the key, read the four bytes after the marker. */
export function lastFrameFromFooter(buf: Buffer): number | null {
  const i = buf.lastIndexOf(Buffer.from("lastFrame"));
  if (i < 0) return null;
  // 'l' is UBJSON's int32 marker. Anything else means we matched the string
  // somewhere that isn't the metadata field.
  if (buf.subarray(i + 9, i + 10).toString() !== "l") return null;
  if (i + 14 > buf.length) return null;
  return buf.readInt32BE(i + 10);
}

/**
 * Walk the raw event stream and return the highest frame any frame event
 * reports, or null if the stream can't be walked.
 *
 * This works on a replay with no metadata footer at all — including one still
 * being written — because it reads the frames themselves rather than a summary
 * someone else was supposed to write.
 */
export function lastFrameFromEvents(buf: Buffer): number | null {
  // The file opens `{U\x03raw[$U#l<int32 length>` and the event stream follows.
  const marker = buf.indexOf(Buffer.from("raw[$U#l"));
  if (marker < 0) return null;
  const start = marker + 12;
  const declared = buf.readInt32BE(marker + 8);
  // A zero length means the writer never came back to fill it in (an
  // unfinished or truncated replay), so we scan instead of trusting it — but
  // NOT to EOF. The UBJSON metadata follows the stream, and walking into it
  // reads its bytes as a frame event: a test fixture produced "frame 5572717"
  // that way, which as an endFrame is a Dolphin that never reaches it and
  // hangs. Stop at the metadata key if there is one.
  const meta = buf.indexOf(Buffer.from("U\x08metadata"), start);
  const end =
    declared > 0 ? Math.min(start + declared, buf.length) : meta > start ? meta : buf.length;
  if (start >= end) return null;

  // The first event declares every other event's size: 0x35, then a payload
  // size that counts itself, then (command, uint16 size) triples.
  if (buf[start] !== EVENT_PAYLOADS) return null;
  const payloadsSize = buf[start + 1];
  if (payloadsSize == null || payloadsSize < 1) return null;
  const sizes = new Map<number, number>();
  for (let p = start + 2; p + 2 < start + 1 + payloadsSize; p += 3) {
    const cmd = buf[p];
    if (cmd == null || p + 3 > end) return null;
    sizes.set(cmd, buf.readUInt16BE(p + 1));
  }
  sizes.set(EVENT_PAYLOADS, payloadsSize);

  let last: number | null = null;
  let pos = start;
  while (pos < end) {
    const cmd = buf[pos];
    if (cmd == null) break;
    const size = sizes.get(cmd);
    if (size == null) break; // an event we were never told the size of: stop, don't guess
    const next = pos + 1 + size;
    if (next > end) break; // a truncated final event — keep what we already have
    if (cmd === POST_FRAME_UPDATE || cmd === FRAME_BOOKEND) {
      const frame = buf.readInt32BE(pos + 1);
      if (last == null || frame > last) last = frame;
    }
    pos = next;
  }
  return last;
}
