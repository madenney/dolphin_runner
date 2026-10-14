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

// --- macOS app bundles (0.5.7). Unverified at runtime on a Mac; these pin
// the resolution, which is all a Linux box can check.

import fs from "node:fs";
import os from "node:os";
import { appBundleOf, resolveDolphinExecutable } from "../src/paths.ts";

function bundle(name: string, plistExe: string | null, files: string[]): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dr-app-"));
  const app = path.join(tmp, name);
  const macos = path.join(app, "Contents", "MacOS");
  fs.mkdirSync(macos, { recursive: true });
  if (plistExe != null) {
    fs.writeFileSync(
      path.join(app, "Contents", "Info.plist"),
      `<?xml version="1.0"?>\n<plist version="1.0"><dict>\n\t<key>CFBundleName</key>\n\t<string>X</string>\n` +
        `\t<key>CFBundleExecutable</key>\n\t<string>${plistExe}</string>\n</dict></plist>\n`,
    );
  }
  for (const f of files) fs.writeFileSync(path.join(macos, f), "");
  return app;
}

test("an .app resolves to Contents/MacOS/<CFBundleExecutable>", () => {
  const app = bundle("Slippi Dolphin.app", "Slippi Dolphin", ["Slippi Dolphin", "helper"]);
  try {
    assert.equal(resolveDolphinExecutable(app), path.join(app, "Contents", "MacOS", "Slippi Dolphin"));
    assert.equal(resolveDolphinExecutable(app + "/"), path.join(app, "Contents", "MacOS", "Slippi Dolphin"));
  } finally {
    fs.rmSync(path.dirname(app), { recursive: true, force: true });
  }
});

test("no usable Info.plist: the single file in Contents/MacOS", () => {
  const app = bundle("Dolphin.app", null, ["Dolphin"]);
  const wrong = bundle("Other.app", "Missing", ["Real"]);
  try {
    assert.equal(resolveDolphinExecutable(app), path.join(app, "Contents", "MacOS", "Dolphin"));
    assert.equal(resolveDolphinExecutable(wrong), path.join(wrong, "Contents", "MacOS", "Real"));
  } finally {
    fs.rmSync(path.dirname(app), { recursive: true, force: true });
    fs.rmSync(path.dirname(wrong), { recursive: true, force: true });
  }
});

test("an unresolvable bundle, a plain file and a missing path come back unchanged", () => {
  const app = bundle("Ambiguous.app", null, ["a", "b"]);
  try {
    assert.equal(resolveDolphinExecutable(app), app);
    const file = path.join(path.dirname(app), "dolphin-emu");
    fs.writeFileSync(file, "");
    assert.equal(resolveDolphinExecutable(file), file);
    assert.equal(resolveDolphinExecutable("/no/such/Dolphin.app"), "/no/such/Dolphin.app");
    // A directory that is no bundle stays a directory (dolphinStatus says so).
    assert.equal(resolveDolphinExecutable(path.dirname(app)), path.dirname(app));
  } finally {
    fs.rmSync(path.dirname(app), { recursive: true, force: true });
  }
});

test("appBundleOf finds the .app a path is, or is inside", () => {
  assert.equal(appBundleOf("/Applications/Slippi Dolphin.app"), "/Applications/Slippi Dolphin.app");
  assert.equal(
    appBundleOf("/Applications/Slippi Dolphin.app/Contents/MacOS/Slippi Dolphin"),
    "/Applications/Slippi Dolphin.app",
  );
  assert.equal(appBundleOf("/opt/slippi/dolphin-emu"), null);
});

test("macOS: the profile is the bundle's Contents/Resources/User", () => {
  const app = bundle("Slippi Dolphin.app", "Slippi Dolphin", ["Slippi Dolphin"]);
  try {
    const user = path.join(app, "Contents", "Resources", "User");
    fs.mkdirSync(user, { recursive: true });
    assert.equal(realProfileRoot(app, "Darwin"), user);
    // The resolved executable finds the same profile.
    assert.equal(realProfileRoot(resolveDolphinExecutable(app), "Darwin"), user);
  } finally {
    fs.rmSync(path.dirname(app), { recursive: true, force: true });
  }
});

test("macOS: Application Support/SlippiPlayback only when the bundle has no User folder", () => {
  const app = bundle("Slippi Dolphin.app", "Slippi Dolphin", ["Slippi Dolphin"]);
  try {
    const fallback = path.join(os.homedir(), "Library", "Application Support", "SlippiPlayback");
    assert.equal(realProfileRoot(app, "Darwin"), fallback);
    assert.equal(realProfileRoot("/usr/local/bin/dolphin-emu", "Darwin"), fallback);
  } finally {
    fs.rmSync(path.dirname(app), { recursive: true, force: true });
  }
});
