/**
 * Spawn env hygiene (0.5.7). A consumer that runs as an AppImage hands its
 * children APPDIR/APPIMAGE/ARGV0/OWD and PATH/LD_LIBRARY_PATH led by its own
 * bundle; Dolphin must not inherit them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordEnv, stripAppImageEnv } from "../src/run.ts";
import { obsMirrorEnv } from "../src/obs.ts";

const parent = {
  APPDIR: "/tmp/.mount_clipXYZ",
  APPIMAGE: "/home/u/Clip.AppImage",
  ARGV0: "Clip.AppImage",
  OWD: "/home/u",
  PATH: "/tmp/.mount_clipXYZ/usr/bin:/usr/local/bin:/usr/bin:/tmp/.mount_clipXYZ",
  LD_LIBRARY_PATH: "/tmp/.mount_clipXYZ/usr/lib:/opt/cuda/lib64",
  HOME: "/home/u",
};

test("REGRESSION: a parent AppImage's runtime variables are not inherited", () => {
  const env = stripAppImageEnv(parent);
  for (const k of ["APPDIR", "APPIMAGE", "ARGV0", "OWD"]) assert.equal(env[k], undefined, k);
  assert.equal(env.HOME, "/home/u");
});

test("only $APPDIR entries leave PATH and LD_LIBRARY_PATH, the rest keep their order", () => {
  const env = stripAppImageEnv(parent);
  assert.equal(env.PATH, "/usr/local/bin:/usr/bin");
  assert.equal(env.LD_LIBRARY_PATH, "/opt/cuda/lib64");
});

test("a prefix that merely LOOKS like APPDIR is kept", () => {
  const env = stripAppImageEnv({ APPDIR: "/tmp/.mount_a", PATH: "/tmp/.mount_ab/bin:/usr/bin" });
  assert.equal(env.PATH, "/tmp/.mount_ab/bin:/usr/bin");
});

test("a library path left empty is dropped, not set to an empty string", () => {
  const env = stripAppImageEnv({ APPDIR: "/a/", LD_LIBRARY_PATH: "/a/usr/lib:/a/lib" });
  assert.ok(!("LD_LIBRARY_PATH" in env));
});

test("without APPDIR nothing but the runtime variables changes", () => {
  const env = stripAppImageEnv({ PATH: "/usr/bin", LD_LIBRARY_PATH: "/x", OWD: "/w" });
  assert.deepEqual(env, { PATH: "/usr/bin", LD_LIBRARY_PATH: "/x" });
});

test("the input is never mutated", () => {
  const copy = { ...parent };
  stripAppImageEnv(copy);
  assert.deepEqual(copy, parent);
});

test("record/play env is stripped, but the caller's own env can still set anything", () => {
  const env = recordEnv(parent, { env: { LD_LIBRARY_PATH: "/mine" } });
  assert.equal(env.APPDIR, undefined);
  assert.equal(env.PATH, "/usr/local/bin:/usr/bin");
  assert.equal(env.LD_LIBRARY_PATH, "/mine");
});

test("obs-mirror env is stripped too", () => {
  const env = obsMirrorEnv(parent, { captureName: "dolphin-1" });
  assert.equal(env.APPIMAGE, undefined);
  assert.equal(env.LD_LIBRARY_PATH, "/opt/cuda/lib64");
});
