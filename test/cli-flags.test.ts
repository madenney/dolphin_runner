/**
 * Every subcommand that can park a window must also accept the flags that
 * SHAPE it. `obs-mirror` took `--workspace` but not `--undecorate`,
 * `--geometry` or `--monitor` — and obs-mirror is the one subcommand the
 * shaping work existed for, since the stream tool needs an undecorated 1080p surface on a
 * landscape output. The stream tool's own test caught it as "Unknown option" (2026-10-11).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The CLI exits non-zero on error and prints one JSON line; return it. */
async function cli(args: string[]): Promise<{ event: string; message?: string }> {
  try {
    const { stdout } = await run("node", ["src/cli.ts", ...args], { encoding: "utf8" });
    return JSON.parse(stdout.trim().split("\n")[0]!);
  } catch (e) {
    const out = String((e as { stdout?: string }).stdout ?? "").trim();
    return JSON.parse(out.split("\n")[0]!);
  }
}

const SHAPING = [
  ["--undecorate"],
  ["--geometry", "1920x1080"],
  ["--monitor", "landscape"],
] as const;

const BASE: Record<string, string[]> = {
  "obs-mirror": [
    "obs-mirror", "--dolphin", "/nope", "--iso", "/nope",
    "--user-dir", "/tmp", "--comm", "/tmp/c.json", "--capture-name", "d1", "--efb-scale", "2",
  ],
  record: [
    "record", "--dolphin", "/nope", "--iso", "/nope", "--slp", "/nope",
    "--out", "/tmp", "--user-dir", "/tmp", "--efb-scale", "2",
  ],
  play: ["play", "--dolphin", "/nope", "--iso", "/nope", "--slp", "/nope", "--user-dir", "/tmp"],
};

for (const [cmd, base] of Object.entries(BASE)) {
  for (const flag of SHAPING) {
    test(`REGRESSION: ${cmd} knows ${flag[0]}`, async () => {
      const r = await cli([...base, "--workspace", "3", ...flag]);
      assert.doesNotMatch(
        r.message ?? "",
        /Unknown option/,
        `${cmd} rejected ${flag[0]} — a subcommand that parks must also shape`,
      );
    });
  }

  test(`${cmd}: shaping flags without --workspace are refused, not ignored`, async () => {
    const r = await cli([...base, "--undecorate"]);
    assert.equal(r.event, "error");
    assert.match(r.message ?? "", /need --workspace/);
  });
}
