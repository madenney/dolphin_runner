/** Keep the last N lines of a stream — a bounded diagnostic, not a transcript. */
export function tailBuffer(limit = 60) {
  const lines: string[] = [];
  return {
    lines,
    push(line: string) {
      if (!line.trim()) return;
      lines.push(line);
      if (lines.length > limit) lines.shift();
    },
  };
}
