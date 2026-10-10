/**
 * Window placement (src/place.ts) against a fake X server. The real one was
 * measured on GNOME/mutter (docs/background-and-mute.md); these pin the RULES:
 * by pid only, pre-map first, read back, never fight a confirmed window.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPlacement, placeWindows, type X11 } from "../src/place.ts";
import { preparePlacement, record } from "../src/run.ts";
import type { RunnerWarning } from "../src/types.ts";

/**
 * A window as mutter treats it. `desktop` is where it REALLY is; `prop` is the
 * `_NET_WM_DESKTOP` property, which is what anyone reads back. Before the WM
 * manages a window, a property write decides where it maps. After, a property
 * write changes only the property — the lie the first parker believed.
 */
interface FakeWin {
  pid: number;
  mapped: boolean;
  desktop: number | null;
  prop?: number | null;
  /** WM refuses moves to anything else (models a WM ignoring EWMH). */
  stuckAt?: number;
}

function fakeX(
  wins: Record<string, FakeWin>,
  opts: { desktops?: number | null; tree?: number[]; alive?: () => boolean; active?: string | null; here?: number } = {},
) {
  const log: string[] = [];
  const state = { active: opts.active ?? null, here: opts.here ?? 0 };
  for (const w of Object.values(wins)) if (w.prop === undefined) w.prop = w.desktop;
  const x: X11 = {
    wmDesktops: async () => (opts.desktops === undefined ? 12 : opts.desktops),
    windowsOf: async (pid) => Object.entries(wins).filter(([, w]) => w.pid === pid).map(([id]) => id),
    isManaged: async (id) => wins[id]!.mapped,
    setDesktopProperty: async (id, d) => {
      const w = wins[id]!;
      log.push(`prop ${id} ${d} mapped=${w.mapped}`);
      w.prop = d;
      if (!w.mapped && w.stuckAt == null) w.desktop = d; // honoured at map time
    },
    moveToDesktop: async (id, d) => {
      log.push(`move ${id} ${d}`);
      const w = wins[id]!;
      w.desktop = w.stuckAt ?? d;
      w.prop = w.desktop; // the WM rewrites the property when it moves the window
    },
    getDesktop: async (id) => (wins[id] ? wins[id]!.prop ?? null : id === "user" ? state.here : null),
    activeWindow: async () => state.active,
    currentDesktop: async () => state.here,
    activate: async (id) => {
      log.push(`activate ${id}`);
      state.active = id;
    },
    pidTree: (root) => opts.tree ?? [root],
    alive: opts.alive ?? (() => true),
  };
  return { x, log, state };
}

test("windows are found BY PID — another process's Dolphin is never touched", async () => {
  const wins: Record<string, FakeWin> = {
    "100": { pid: 42, mapped: true, desktop: 0 },
    "200": { pid: 77, mapped: true, desktop: 0 }, // someone else's, e.g. MST's on-air mirror
  };
  const { x, log } = fakeX(wins);
  const r = await placeWindows(42, { workspace: 9, timeoutMs: 200 }, x).done;
  assert.equal(r.status, "placed");
  assert.deepEqual(r.windows, [{ id: "100", desktop: 9 }]);
  assert.equal(wins["200"]!.desktop, 0);
  assert.ok(!log.some((l) => l.includes(" 200 ")));
});

test("the whole pid tree is searched — the AppImage execs, the window may be a descendant's", async () => {
  const wins: Record<string, FakeWin> = { "300": { pid: 43, mapped: true, desktop: 0 } };
  const { x } = fakeX(wins, { tree: [42, 43] });
  const r = await placeWindows(42, { workspace: 3, timeoutMs: 200 }, x).done;
  assert.deepEqual(r.windows, [{ id: "300", desktop: 3 }]);
});

test("pre-map first: a window found before the WM manages it gets the property, so it maps on the target", async () => {
  const wins: Record<string, FakeWin> = { "100": { pid: 42, mapped: false, desktop: null } };
  const { x, log } = fakeX(wins);
  const h = placeWindows(42, { workspace: 9, timeoutMs: 400 }, x);
  setTimeout(() => (wins["100"]!.mapped = true), 120); // maps after we found it
  const r = await h.done;
  assert.equal(r.status, "placed");
  assert.equal(log[0], "prop 100 9 mapped=false");
  assert.equal(wins["100"]!.desktop, 9);
});

test("NEVER TRUST A PROPERTY YOU WROTE — a window already managed when found is really moved", async () => {
  // The bug of 2026-10-09: the parker wrote _NET_WM_DESKTOP onto a mapped
  // window, read its own write back, and reported "placed" while the window
  // sat on the user's workspace for the whole run.
  const wins: Record<string, FakeWin> = { "100": { pid: 42, mapped: true, desktop: 0 } };
  const { x, log } = fakeX(wins);
  const r = await placeWindows(42, { workspace: 9, timeoutMs: 200 }, x).done;
  assert.ok(!log.some((l) => l.startsWith("prop")), "no property write on a managed window");
  assert.ok(log.includes("move 100 9"));
  assert.equal(wins["100"]!.desktop, 9); // where it REALLY is
  assert.equal(r.status, "placed");
});

test("a managed window always gets the real move once, even if its property already says the target", async () => {
  // A racing pre-map write can land just after the map: property 9, window on 0.
  const wins: Record<string, FakeWin> = { "100": { pid: 42, mapped: true, desktop: 0, prop: 9 } };
  const { x, log } = fakeX(wins);
  await placeWindows(42, { workspace: 9, timeoutMs: 200 }, x).done;
  assert.ok(log.includes("move 100 9"));
  assert.equal(wins["100"]!.desktop, 9);
});

test("a window that mapped before we found it is moved, then READ BACK", async () => {
  const wins: Record<string, FakeWin> = { "100": { pid: 42, mapped: true, desktop: 0 } };
  const { x, log } = fakeX(wins);
  const r = await placeWindows(42, { workspace: 9, timeoutMs: 200 }, x).done;
  assert.equal(r.status, "placed");
  assert.ok(log.includes("move 100 9"));
});

test("a WM that ignores the move is reported partial and warned, with retries capped", async () => {
  const wins: Record<string, FakeWin> = { "100": { pid: 42, mapped: true, desktop: 0, stuckAt: 0 } };
  const { x, log } = fakeX(wins);
  const warnings: RunnerWarning[] = [];
  const r = await placeWindows(42, { workspace: 9, timeoutMs: 400, onWarning: (w) => warnings.push(w) }, x).done;
  assert.equal(r.status, "partial");
  assert.equal(warnings[0]?.code, "placement-ignored");
  // Re-sent every ~100 ms (mutter lands a move late), never a tight loop.
  const moves = log.filter((l) => l.startsWith("move")).length;
  assert.ok(moves >= 2 && moves <= 6, `moves: ${moves}`);
});

test("a confirmed window is never moved again — placement doesn't fight a user who drags it back", async () => {
  const wins: Record<string, FakeWin> = { "100": { pid: 42, mapped: true, desktop: 9 } };
  const { x, log } = fakeX(wins);
  const h = placeWindows(42, { workspace: 9, timeoutMs: 400 }, x);
  setTimeout(() => {
    wins["100"]!.desktop = 0; // the user pulls it back
    wins["100"]!.prop = 0;
  }, 150);
  const r = await h.done;
  // The one mandatory move after it was managed — and none after the user's drag.
  assert.equal(log.filter((l) => l.startsWith("move")).length, 1);
  assert.equal(wins["100"]!.desktop, 0);
  assert.deepEqual(r.windows, [{ id: "100", desktop: 9 }]); // as confirmed
});

test("focus goes BACK to the user's window once ours are parked — a hidden Dolphin must not eat typing", async () => {
  const wins: Record<string, FakeWin> = { "100": { pid: 42, mapped: true, desktop: 0 } };
  const { x, log, state } = fakeX(wins, { active: "100", here: 0 });
  await placeWindows(42, { workspace: 9, timeoutMs: 200, previousActive: "user" }, x).done;
  assert.ok(log.includes("activate user"));
  assert.equal(state.active, "user");
});

test("focus is NOT restored to a window on another workspace — that would switch workspaces on the user", async () => {
  const wins: Record<string, FakeWin> = { "100": { pid: 42, mapped: true, desktop: 0 } };
  const { x, log } = fakeX(wins, { active: "100", here: 2 }); // user moved on; "user" window is on 0... see getDesktop
  // getDesktop("user") reports `here` in the fake, so model "elsewhere" by a different window:
  x.getDesktop = async (id) => (id === "user" ? 0 : wins[id]?.prop ?? null);
  await placeWindows(42, { workspace: 9, timeoutMs: 200, previousActive: "user" }, x).done;
  assert.ok(!log.some((l) => l.startsWith("activate")));
});

test("focus is left alone when the user already moved it, or when restoreFocus is off", async () => {
  const wins: Record<string, FakeWin> = { "100": { pid: 42, mapped: true, desktop: 0 } };
  const a = fakeX(wins, { active: "someone-else", here: 0 });
  await placeWindows(42, { workspace: 9, timeoutMs: 200, previousActive: "user" }, a.x).done;
  assert.ok(!a.log.some((l) => l.startsWith("activate")));
  const wins2: Record<string, FakeWin> = { "100": { pid: 42, mapped: true, desktop: 0 } };
  const b = fakeX(wins2, { active: "100", here: 0 });
  await placeWindows(42, { workspace: 9, timeoutMs: 200, previousActive: "user", restoreFocus: false }, b.x).done;
  assert.ok(!b.log.some((l) => l.startsWith("activate")));
});

test("placement ends when the process dies, and with no mapped window says none-found", async () => {
  let alive = true;
  const { x } = fakeX({}, { alive: () => alive });
  const h = placeWindows(42, { workspace: 9, timeoutMs: 10_000 }, x);
  setTimeout(() => (alive = false), 100);
  const t = Date.now();
  const r = await h.done;
  assert.ok(Date.now() - t < 2000);
  assert.equal(r.status, "none-found");
});

test("stop() and an aborted signal end placement promptly", async () => {
  const { x } = fakeX({});
  const h = placeWindows(42, { workspace: 9, timeoutMs: 10_000 }, x);
  setTimeout(() => h.stop(), 50);
  assert.equal((await h.done).status, "none-found");
  const ac = new AbortController();
  const h2 = placeWindows(42, { workspace: 9, timeoutMs: 10_000, signal: ac.signal }, x);
  setTimeout(() => ac.abort(), 50);
  const t = Date.now();
  await h2.done;
  assert.ok(Date.now() - t < 2000);
});

// --- preflight --------------------------------------------------------------

test("preflight: not Linux, no DISPLAY, bad workspace number → unsupported", async () => {
  const { x } = fakeX({});
  for (const [o, platform, env] of [
    [{ workspace: 9 }, "win32", { DISPLAY: ":1" }],
    [{ workspace: 9 }, "linux", {}],
    [{ workspace: -1 }, "linux", { DISPLAY: ":1" }],
    [{ workspace: 1.5 }, "linux", { DISPLAY: ":1" }],
  ] as const) {
    const c = await checkPlacement(o, x, platform, env);
    assert.equal(c.ok, false);
    if (!c.ok) assert.equal(c.warning.code, "placement-unsupported");
  }
});

test("preflight: missing X tools are named, not a crash", async () => {
  const { x } = fakeX({});
  x.wmDesktops = async () => {
    throw Object.assign(new Error("spawn xprop ENOENT"), { code: "ENOENT" });
  };
  const c = await checkPlacement({ workspace: 9 }, x, "linux", { DISPLAY: ":1" });
  assert.ok(!c.ok && /not installed/.test(c.warning.detail));
});

test("preflight: no window manager (Xvfb) is its own answer — nothing to hide from", async () => {
  const { x } = fakeX({}, { desktops: null });
  const c = await checkPlacement({ workspace: 9 }, x, "linux", { DISPLAY: ":99" });
  assert.ok(!c.ok && c.warning.code === "placement-no-wm");
});

test("preflight: a workspace that doesn't exist is refused, never created", async () => {
  const { x } = fakeX({}, { desktops: 4 });
  const c = await checkPlacement({ workspace: 9 }, x, "linux", { DISPLAY: ":1" });
  assert.ok(!c.ok && c.warning.code === "placement-no-workspace");
  assert.equal((await checkPlacement({ workspace: 3 }, x, "linux", { DISPLAY: ":1" })).ok, true);
});

test("placement that can't work warns and skips — unless required, which refuses to spawn", async () => {
  const warnings: RunnerWarning[] = [];
  // A display that doesn't exist: the X query fails, so placement is unavailable.
  const p = await preparePlacement({ placement: { workspace: 9 }, onWarning: (w) => warnings.push(w) }, ":987");
  assert.equal(p.start, null);
  assert.equal(p.skipped?.status, "skipped");
  assert.equal(warnings.length, 1);
  await assert.rejects(preparePlacement({ placement: { workspace: 9, required: true } }, ":987"), /required/);
});

test("record() with unavailable placement still records, and reports the skip", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dr-place-"));
  try {
    const fake = path.join(tmp, "fake-dolphin.sh");
    fs.writeFileSync(
      fake,
      [
        "#!/bin/sh",
        'for a in "$@"; do case "$a" in --output-directory=*) d="${a#--output-directory=}";; esac; done',
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
    const warnings: RunnerWarning[] = [];
    const res = await record({ dolphinPath: fake, isoPath: iso }, slp, {
      userDir,
      outDir: path.join(tmp, "out"),
      display: ":987",
      placement: { workspace: 9 },
      onWarning: (w) => warnings.push(w),
      bootStallMs: 5000,
    });
    assert.equal(res.placement?.status, "skipped");
    assert.equal(warnings[0]?.code, "placement-unsupported");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("without placement, record() reports null — today's behaviour", async () => {
  const p = await preparePlacement({}, ":1");
  assert.deepEqual(p, { start: null, skipped: null });
});
