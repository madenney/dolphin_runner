/**
 * The smallest ini editor that does this job correctly.
 *
 * Dolphin inis are section-scoped and the SAME KEY means different things in
 * different sections — `DumpAudio` appears under both `[Movie]` and `[DSP]`,
 * and a frame dump needs both. So the two operations here are deliberately
 * distinct: `setInSection` targets one, `setEverywhere` hits every occurrence.
 *
 * Existing spacing is preserved (`Key = X` and `Key=X` both survive as they
 * were) because these files are round-tripped from a user's real profile and
 * gratuitous reformatting makes diffs unreadable.
 */

const keyLine = (key: string) =>
  new RegExp(`^(\\s*)(${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(\\s*=\\s*)(.*)$`);

/** Set `key` everywhere it already appears. Never creates it. */
export function setEverywhere(text: string, key: string, value: string): string {
  const re = keyLine(key);
  return text
    .split(/\r?\n/)
    .map((line) => {
      const m = re.exec(line);
      return m ? `${m[1]}${m[2]}${m[3]}${value}` : line;
    })
    .join("\n");
}

/**
 * Set `key` inside `[section]`, creating the key — and the section — if absent.
 *
 * The creating half is the point. lm-clipper's builder only rewrites lines that
 * already exist, so a real profile missing `InternalResolutionFrameDumps` (a
 * fresh install that has never dumped) silently produces a dump at window
 * resolution instead of internal. Nothing downstream can tell; the footage is
 * just quietly wrong.
 */
export function setInSection(text: string, section: string, key: string, value: string): string {
  const lines = text.split(/\r?\n/);
  const re = keyLine(key);
  const header = `[${section}]`;
  let inSection = false;
  let sectionStart = -1;
  let sectionEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      if (inSection) {
        sectionEnd = i;
        break;
      }
      inSection = trimmed === header;
      if (inSection) sectionStart = i;
      continue;
    }
    if (!inSection) continue;
    const m = re.exec(line);
    if (m) {
      lines[i] = `${m[1]}${m[2]}${m[3]}${value}`;
      return lines.join("\n");
    }
  }

  if (sectionStart < 0) {
    // No such section: append it. Keep exactly one blank line before it so a
    // file that already ends in a newline doesn't grow a run of them.
    const body = lines.length && lines[lines.length - 1]!.trim() === "" ? lines.slice(0, -1) : lines;
    return [...body, "", header, `${key} = ${value}`, ""].join("\n");
  }
  // Section exists but lacks the key: insert at the end of that section.
  const at = sectionEnd < 0 ? lines.length : sectionEnd;
  lines.splice(at, 0, `${key} = ${value}`);
  return lines.join("\n");
}

/** Read a key's value from a section, or null. Test/diagnostic helper. */
export function getInSection(text: string, section: string, key: string): string | null {
  const re = keyLine(key);
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inSection = trimmed === `[${section}]`;
      continue;
    }
    if (!inSection) continue;
    const m = re.exec(line);
    if (m) return m[4]!.trim();
  }
  return null;
}
