/**
 * Why a frame dump came out empty, in Dolphin's own words.
 *
 * Dolphin's AVIDump reports a refused encoder ONLY in its log — never on
 * stdout/stderr, never as an exit code. Measured on Windows (Playback 3.5.2,
 * FFmpeg 3.2.4 linked in): `dumpCodec: "utvideo"` ran the whole replay, exited
 * 0 (or crashed with 0xC0000409 on a hidden desktop) and wrote no `.avi`, so
 * the consumer saw only "produced no video" after a full-length run. Record
 * mode therefore turns Dolphin's file log on for the VIDEO channel
 * (`<userDir>/Logs/dolphin.log`), and `record()` reads it back when there is no
 * video, naming the codec and quoting the AVIDump lines.
 *
 * A codec name Dolphin does not know is worse: it logs "Invalid codec <name>"
 * and silently dumps the container default (mpeg4) instead — a lossy file
 * where lossless was asked for. `record()` warns `dump-codec-fallback`.
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync, writeSync } from "node:fs";
import path from "node:path";
import { getInSection } from "./ini.ts";

/** What the profile told Dolphin to dump with. */
export interface DumpSettings {
  /** `"ffv1"` (UseFFV1), the `DumpCodec` name, or `"default"` (empty: mpeg4 in AVI). */
  codec: string;
  efbScale: number | null;
}

/**
 * Logger.ini keys record mode writes: the file log on, the VIDEO channel (where
 * AVIDump logs) on, warnings and up ("Invalid codec" is a warning). Everything
 * else in a copied Logger.ini is left as the user had it.
 */
export const DUMP_LOG_INI: ReadonlyArray<{ section: string; key: string; value: string }> = [
  { section: "Options", key: "WriteToFile", value: "True" },
  { section: "Options", key: "Verbosity", value: "3" },
  { section: "Logs", key: "VIDEO", value: "True" },
];

/** Read back the dump codec from `<userDir>/Config/GFX.ini`. Null when unreadable. */
export function readDumpSettings(userDir: string): DumpSettings | null {
  let gfx: string;
  try {
    gfx = readFileSync(path.join(userDir, "Config", "GFX.ini"), "utf8");
  } catch {
    return null;
  }
  return dumpSettingsFromGfx(gfx);
}

/** Pure half of readDumpSettings. `UseFFV1` overrides `DumpCodec` in Dolphin. */
export function dumpSettingsFromGfx(gfx: string): DumpSettings {
  const ffv1 = (getInSection(gfx, "Settings", "UseFFV1") ?? "").trim().toLowerCase() === "true";
  const name = (getInSection(gfx, "Settings", "DumpCodec") ?? "").trim();
  const efb = Number((getInSection(gfx, "Settings", "EFBScale") ?? "").trim());
  return { codec: ffv1 ? "ffv1" : name || "default", efbScale: Number.isFinite(efb) && efb > 0 ? efb : null };
}

const DUMP_LINE = /AVIDump|Invalid codec|Could not (find encoder|open codec|allocate|open)|frame dump/i;

/** The AVIDump lines of a Dolphin log (bounded). Pure. */
export function dumpLogLines(text: string, max = 12): string[] {
  return String(text || "")
    .split(/\r?\n/)
    .filter((l) => DUMP_LINE.test(l))
    .map((l) => l.trim())
    .slice(0, max);
}

/** The AVIDump lines of `<userDir>/Logs/dolphin.log`; empty when there is no log. */
export function readDumpLog(userDir: string): string[] {
  try {
    return dumpLogLines(readFileSync(path.join(userDir, "Logs", "dolphin.log"), "utf8"));
  } catch {
    return [];
  }
}

/** The log said the encoder was refused (not found, or would not open). */
export function encoderRefused(lines: string[]): boolean {
  return lines.some((l) => /Could not (find encoder|open codec)|AVIDump Start failed/i.test(l));
}

/** The log said the codec name was unknown and the default was used instead. */
export function codecFellBack(lines: string[]): boolean {
  return lines.some((l) => /Invalid codec/i.test(l));
}

/** One sentence for the "produced no video" error. Pure. */
export function describeDumpFailure(dump: DumpSettings | null, lines: string[]): string {
  const parts: string[] = [];
  if (dump) {
    parts.push(`dump codec ${JSON.stringify(dump.codec)}${dump.efbScale != null ? ` at EFBScale ${dump.efbScale}` : ""}`);
  }
  const refused = lines.filter((l) => /Could not|AVIDump Start failed|Invalid codec/i.test(l));
  if (refused.length) {
    parts.push(`Dolphin's log: ${refused.slice(0, 3).map((l) => l.replace(/^.*?(?:\]: |\]:)/, "")).join(" | ")}`);
    if (dump && dump.codec !== "ffv1" && encoderRefused(lines)) {
      parts.push(`this Dolphin build cannot encode ${JSON.stringify(dump.codec)}; "ffv1" is in every Playback build`);
    }
  }
  return parts.join("; ");
}

/**
 * Make a WAV's RIFF and `data` sizes match its length, in place. Returns true
 * when it changed something. Never throws (a file it can't parse is left alone).
 *
 * Dolphin writes the WAV progressively and fills in the sizes only when its
 * audio dump stops, which happens AFTER the video backend shuts down; a stop
 * forced before that leaves the sizes at their placeholders while every sample
 * is on disk. Truncated to whole sample frames.
 */
export function repairWavHeader(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r+");
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(12);
    if (readSync(fd, head, 0, 12, 0) < 12) return false;
    if (head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WAVE") return false;
    let pos = 12;
    let blockAlign = 4;
    while (pos + 8 <= size) {
      const c = Buffer.alloc(8);
      readSync(fd, c, 0, 8, pos);
      const id = c.toString("latin1", 0, 4);
      const len = c.readUInt32LE(4);
      if (id === "fmt ") {
        const f = Buffer.alloc(16);
        readSync(fd, f, 0, 16, pos + 8);
        blockAlign = f.readUInt16LE(12) || 4;
      } else if (id === "data") {
        const actual = size - (pos + 8);
        const data = actual - (actual % blockAlign);
        const riff = pos + 8 + data - 8;
        let changed = false;
        if (len !== data) {
          const b = Buffer.alloc(4);
          b.writeUInt32LE(data >>> 0);
          writeSync(fd, b, 0, 4, pos + 4);
          changed = true;
        }
        if (head.readUInt32LE(4) !== riff) {
          const b = Buffer.alloc(4);
          b.writeUInt32LE(riff >>> 0);
          writeSync(fd, b, 0, 4, 4);
          changed = true;
        }
        return changed;
      }
      // A placeholder size on a chunk before `data` means we can't walk on.
      if (len === 0 || len === 0xffffffff || pos + 8 + len > size) return false;
      pos += 8 + len + (len & 1);
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd != null) closeSync(fd);
  }
}
