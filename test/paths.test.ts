import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { profileAt, realProfileRoot, resolveRealProfile } from "../src/paths.ts";

test("Windows reads the portable User/ layout beside the exe", () => {
  const exe = path.join("C:", "Slippi", "playback", "Dolphin.exe");
  const root = realProfileRoot(exe, "Windows_NT");
  assert.equal(root, path.join("C:", "Slippi", "playback", "User"));
  const p = profileAt(root);
  assert.equal(p.gfxIni, path.join(root, "Config", "GFX.ini"));
  assert.equal(p.dolphinIni, path.join(root, "Config", "Dolphin.ini"));
  assert.equal(p.gameSettingsIni, path.join(root, "GameSettings", "GALE01.ini"));
});

test("Linux reads XDG_CONFIG_HOME/SlippiPlayback", () => {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join("/tmp", "xdg");
  try {
    assert.equal(realProfileRoot("/anywhere/dolphin", "Linux"), path.join("/tmp", "xdg", "SlippiPlayback"));
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test("a THROWAWAY profile has Config/ at its root — no User/ segment", () => {
  // The `User/` in a Windows real profile is a property of the portable
  // install's layout, NOT of the --user flag. Conflating the two builds a
  // profile Dolphin silently ignores.
  const p = profileAt("/tmp/worker-3");
  assert.equal(p.configDir, path.join("/tmp", "worker-3", "Config"));
  assert.ok(!p.configDir.includes(`${path.sep}User${path.sep}`));
});

test("resolveRealProfile threads the platform through", () => {
  const exe = path.join("C:", "d", "Dolphin.exe");
  assert.equal(resolveRealProfile(exe, "Windows_NT").root, path.join("C:", "d", "User"));
});
