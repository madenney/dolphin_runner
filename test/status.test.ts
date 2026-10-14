/**
 * dolphinStatus catches the startup failures that otherwise only show as a
 * Dolphin that exits at once or a 90 s boot stall (0.5.7). Platform and the
 * libfuse probe are injected; the files are real.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dolphinStatus, isAppImage } from "../src/status.ts";

let tmp: string;
let iso: string;
let exe: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dr-status-"));
  iso = path.join(tmp, "melee.iso");
  fs.writeFileSync(iso, "");
  exe = path.join(tmp, "dolphin-emu");
  fs.writeFileSync(exe, "#!/bin/sh\n");
  fs.chmodSync(exe, 0o755);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const linux = { platform: "Linux", env: { DISPLAY: ":0" }, hasLibfuse2: () => true };

/** A type-2 AppImage header: ELF magic, then "AI\x02" at offset 8. */
function appImage(name: string): string {
  const p = path.join(tmp, name);
  const b = Buffer.alloc(64);
  b.write("\x7fELF", 0, "latin1");
  b[8] = 0x41;
  b[9] = 0x49;
  b[10] = 0x02;
  fs.writeFileSync(p, b);
  fs.chmodSync(p, 0o755);
  return p;
}

test("a healthy setup is null", () => {
  assert.equal(dolphinStatus({ dolphinPath: exe, isoPath: iso }, linux), null);
});

test("not executable: says so, and how to fix it", () => {
  fs.chmodSync(exe, 0o644);
  const why = dolphinStatus({ dolphinPath: exe, isoPath: iso }, linux);
  assert.match(why ?? "", /not executable/);
  assert.match(why ?? "", /chmod \+x/);
  // macOS too; Windows has no execute bit to check.
  assert.match(dolphinStatus({ dolphinPath: exe, isoPath: iso }, { ...linux, platform: "Darwin" }) ?? "", /chmod/);
  assert.equal(dolphinStatus({ dolphinPath: exe, isoPath: iso }, { ...linux, platform: "Windows_NT" }), null);
});

test("a directory is not a Dolphin", () => {
  assert.match(dolphinStatus({ dolphinPath: tmp, isoPath: iso }, linux) ?? "", /is a directory/);
});

test("an AppImage with no libfuse.so.2 is caught before it fails to mount", () => {
  const ai = appImage("dolphin-no-ext");
  const why = dolphinStatus({ dolphinPath: ai, isoPath: iso }, { ...linux, hasLibfuse2: () => false });
  assert.match(why ?? "", /AppImage/);
  assert.match(why ?? "", /libfuse2/);
  assert.match(why ?? "", /APPIMAGE_EXTRACT_AND_RUN=1/);
});

test("APPIMAGE_EXTRACT_AND_RUN=1 or an installed libfuse2 makes it fine", () => {
  const ai = appImage("Slippi_Playback.AppImage");
  const noFuse = { ...linux, hasLibfuse2: () => false };
  assert.equal(
    dolphinStatus({ dolphinPath: ai, isoPath: iso }, { ...noFuse, env: { DISPLAY: ":0", APPIMAGE_EXTRACT_AND_RUN: "1" } }),
    null,
  );
  assert.equal(dolphinStatus({ dolphinPath: ai, isoPath: iso }, linux), null);
});

test("the FUSE check is Linux-only, and a plain binary never triggers it", () => {
  const ai = appImage("x.AppImage");
  assert.equal(dolphinStatus({ dolphinPath: ai, isoPath: iso }, { ...linux, platform: "Darwin", hasLibfuse2: () => false }), null);
  assert.equal(dolphinStatus({ dolphinPath: exe, isoPath: iso }, { ...linux, hasLibfuse2: () => false }), null);
});

test("isAppImage: by name or by magic, not by being an ELF", () => {
  assert.equal(isAppImage(appImage("plain")), true);
  assert.equal(isAppImage(appImage("Slippi.AppImage")), true);
  const elf = path.join(tmp, "elf");
  fs.writeFileSync(elf, Buffer.from("\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00", "latin1"));
  assert.equal(isAppImage(elf), false);
  assert.equal(isAppImage(path.join(tmp, "missing")), false);
});

test("no display on Linux is caught; `display` or WAYLAND_DISPLAY satisfies it", () => {
  const p = { dolphinPath: exe, isoPath: iso };
  assert.match(dolphinStatus(p, { ...linux, env: {} }) ?? "", /DISPLAY/);
  assert.equal(dolphinStatus(p, { ...linux, env: {}, display: ":5" }), null);
  assert.equal(dolphinStatus(p, { ...linux, env: { WAYLAND_DISPLAY: "wayland-0" } }), null);
  assert.equal(dolphinStatus(p, { ...linux, env: {}, platform: "Darwin" }), null);
  assert.equal(dolphinStatus(p, { ...linux, env: {}, platform: "Windows_NT" }), null);
});

test("an app bundle with nothing to run says so", () => {
  const app = path.join(tmp, "Broken.app");
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  assert.match(dolphinStatus({ dolphinPath: app, isoPath: iso }, { ...linux, platform: "Darwin" }) ?? "", /app bundle/);
});

test("an app bundle resolves to its executable and passes", () => {
  const app = path.join(tmp, "Slippi Dolphin.app");
  const macos = path.join(app, "Contents", "MacOS");
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(path.join(macos, "Slippi Dolphin"), "");
  fs.chmodSync(path.join(macos, "Slippi Dolphin"), 0o755);
  assert.equal(dolphinStatus({ dolphinPath: app, isoPath: iso }, { ...linux, platform: "Darwin" }), null);
});

test("the old checks still come first and read the same", () => {
  assert.equal(dolphinStatus({ dolphinPath: "", isoPath: iso }, linux), "dolphinPath is not set");
  assert.match(dolphinStatus({ dolphinPath: path.join(tmp, "nope"), isoPath: iso }, linux) ?? "", /does not exist/);
  assert.equal(dolphinStatus({ dolphinPath: exe, isoPath: "" }, linux), "isoPath is not set");
});
