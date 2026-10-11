/**
 * The preview launch shape. The package had only `record()` (batch, dumps,
 * hidden) and `obsMirror()` (OBS capture env, mirror comm with no frame
 * range); a clip preview is neither, and the clip tool has two spawn sites that
 * are exactly this. These pin what makes it a preview rather than a dump.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { play, playArgs, recordArgs } from "../src/run.ts";

const paths = { dolphinPath: "/d/Dolphin", isoPath: "/i/melee.iso" };

test("REGRESSION: a preview never dumps — no -o, no --output-directory", () => {
  const args = playArgs(paths, { userDir: "/tmp/u", commPath: "/tmp/u/comm.json" });
  assert.ok(!args.includes("-o"), "-o would start a frame dump behind the operator");
  assert.ok(!args.some((a) => a.startsWith("--output-directory")));
});

test("--cout is kept: it is how the end frame is detected at all", () => {
  const args = playArgs(paths, { userDir: "/tmp/u", commPath: "/tmp/u/comm.json" });
  assert.ok(args.includes("--cout"));
});

test("batch is on by default — a preview that outlives its clip is a window to close by hand", () => {
  assert.ok(playArgs(paths, { userDir: "/tmp/u", commPath: "/c" }).includes("-b"));
  assert.ok(!playArgs(paths, { userDir: "/tmp/u", commPath: "/c", batch: false }).includes("-b"));
});

test("the seekbar is shown unless hidden — a human is watching this one", () => {
  assert.ok(!playArgs(paths, { userDir: "/tmp/u", commPath: "/c" }).includes("--hide-seekbar"));
  assert.ok(playArgs(paths, { userDir: "/tmp/u", commPath: "/c", hideSeekbar: true }).includes("--hide-seekbar"));
});

test("full argv shape", () => {
  assert.deepEqual(playArgs(paths, { userDir: "/tmp/u1", commPath: "/tmp/u1/comm.json" }), [
    "-i", "/tmp/u1/comm.json",
    "-b",
    "-e", "/i/melee.iso",
    "--user", "/tmp/u1",
    "--cout",
  ]);
});

test("a replay with no readable length is refused unless the caller supplies one", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dr-play-"));
  const slp = path.join(tmp, "empty.slp");
  fs.writeFileSync(slp, "not a replay");
  await assert.rejects(
    () => play({ dolphinPath: slp, isoPath: slp }, slp, { userDir: tmp }),
    /could not read lastFrame|pass lastFrame or endFrame/,
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("a missing replay is refused before anything is spawned", async () => {
  await assert.rejects(
    () => play(paths, "/definitely/not/here.slp", { userDir: "/tmp" }),
    /replay not found/,
  );
});

test("record() can leave the window up too — batch is not forced", () => {
  // A consumer's "fullscreen" toggle meant exactly this, and record() had no
  // equivalent while play() did.
  const base = { userDir: "/u", outDir: "/o", commPath: "/c", baseName: "dump" };
  assert.ok(recordArgs(paths, base).includes("-b"));
  assert.ok(!recordArgs(paths, { ...base, batch: false }).includes("-b"));
  // The dump flags are still there either way — this is not a preview.
  assert.ok(recordArgs(paths, { ...base, batch: false }).includes("-o"));
});
