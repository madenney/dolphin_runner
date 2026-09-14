import { test } from "node:test";
import assert from "node:assert/strict";
import { getInSection, setEverywhere, setInSection } from "../src/ini.ts";

const SAMPLE = [
  "[Movie]",
  "DumpFrames = False",
  "DumpAudio = False",
  "[DSP]",
  "DumpAudio = False",
  "Backend = ALSA",
  "[Interface]",
  "ConfirmStop = False",
  "",
].join("\n");

test("setInSection targets one section only", () => {
  const out = setInSection(SAMPLE, "Movie", "DumpAudio", "True");
  assert.equal(getInSection(out, "Movie", "DumpAudio"), "True");
  assert.equal(getInSection(out, "DSP", "DumpAudio"), "False", "DSP must be untouched");
});

test("setEverywhere hits every section", () => {
  const out = setEverywhere(SAMPLE, "DumpAudio", "True");
  assert.equal(getInSection(out, "Movie", "DumpAudio"), "True");
  assert.equal(getInSection(out, "DSP", "DumpAudio"), "True");
});

test("creates a missing key inside an existing section", () => {
  // A profile that has never dumped has no InternalResolutionFrameDumps line.
  // Only rewriting existing lines silently dumps at window resolution.
  const gfx = "[Settings]\nEFBScale = 4\nUseFFV1 = True\n";
  const out = setInSection(gfx, "Settings", "InternalResolutionFrameDumps", "True");
  assert.equal(getInSection(out, "Settings", "InternalResolutionFrameDumps"), "True");
  assert.equal(getInSection(out, "Settings", "UseFFV1"), "True", "must not disturb neighbours");
});

test("creates a missing section", () => {
  const out = setInSection("[Settings]\nEFBScale = 4\n", "Movie", "DumpFrames", "True");
  assert.equal(getInSection(out, "Movie", "DumpFrames"), "True");
  assert.equal(getInSection(out, "Settings", "EFBScale"), "4");
});

test("preserves the source's spacing style", () => {
  assert.match(setInSection("[S]\nKey=1\n", "S", "Key", "2"), /Key=2/);
  assert.match(setInSection("[S]\nKey = 1\n", "S", "Key", "2"), /Key = 2/);
});

test("does not match a key that is a prefix of another", () => {
  const src = "[Movie]\nDumpFrames = False\nDumpFramesSilent = False\n";
  const out = setInSection(src, "Movie", "DumpFrames", "True");
  assert.equal(getInSection(out, "Movie", "DumpFrames"), "True");
  assert.equal(getInSection(out, "Movie", "DumpFramesSilent"), "False");
});
