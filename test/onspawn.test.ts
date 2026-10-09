/**
 * record() hands out the Dolphin pid via onSpawn, so a caller (Media) can park
 * the window without `pgrep -f <userDir>`. A fake "Dolphin" shell script stands
 * in: it writes the .avi record() expects and exits.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { record } from "../src/run.ts";

test("record() reports the spawned pid once, and its result is unchanged", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dr-onspawn-"));
  try {
    const fake = path.join(tmp, "fake-dolphin.sh");
    fs.writeFileSync(
      fake,
      [
        "#!/bin/sh",
        'for a in "$@"; do case "$a" in --output-directory=*) d="${a#--output-directory=}";; esac; done',
        'echo $$ > "$d/pid.txt"',
        ': > "$d/dump.avi"',
        "exit 0",
        "",
      ].join("\n"),
    );
    fs.chmodSync(fake, 0o755);
    const iso = path.join(tmp, "melee.iso");
    fs.writeFileSync(iso, "");
    const slp = path.join(tmp, "g.slp");
    const val = Buffer.alloc(4);
    val.writeInt32BE(600);
    fs.writeFileSync(slp, Buffer.concat([Buffer.from("raw..lastFramel"), val, Buffer.from("}}")]));
    const userDir = path.join(tmp, "user");
    fs.mkdirSync(userDir);
    const outDir = path.join(tmp, "out");

    const pids: number[] = [];
    const res = await record({ dolphinPath: fake, isoPath: iso }, slp, {
      userDir,
      outDir,
      onSpawn: (pid) => pids.push(pid),
      bootStallMs: 5000,
    });
    assert.equal(pids.length, 1);
    assert.equal(String(pids[0]), fs.readFileSync(path.join(outDir, "pid.txt"), "utf8").trim());
    assert.equal(res.avi, path.join(outDir, "dump.avi"));
    assert.equal(res.lastFrame, 600);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
