import { existsSync } from "node:fs";
import type { DolphinPaths } from "./types.ts";

/**
 * Why we cannot run, phrased for whoever has to fix it — or null when we can.
 *
 * Parameterised rather than reading env at import time: a library that decides
 * its configuration when it is first imported cannot be used by a consumer that
 * resolves paths at runtime, and cannot be tested without mutating env.
 */
export function dolphinStatus(p: DolphinPaths): string | null {
  if (!p.dolphinPath) return "dolphinPath is not set";
  if (!existsSync(p.dolphinPath)) return `dolphinPath does not exist: ${p.dolphinPath}`;
  if (!p.isoPath) return "isoPath is not set";
  if (!existsSync(p.isoPath)) return `isoPath does not exist: ${p.isoPath}`;
  return null;
}

export function dolphinConfigured(p: DolphinPaths): boolean {
  return dolphinStatus(p) === null;
}
