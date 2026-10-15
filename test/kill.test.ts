/**
 * killTree with the OS injected. The Windows branch cannot run here, so the
 * commands it WOULD run are recorded instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { killTree, taskkillArgs } from "../src/kill.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function windows(alive = true) {
  const calls: string[][] = [];
  return {
    calls,
    deps: {
      platform: "win32" as const,
      exec: (cmd: string, args: string[]) => calls.push([cmd, ...args]),
      alive: () => alive,
    },
  };
}

test("taskkill argv: /F only when forced", () => {
  assert.deepEqual(taskkillArgs(42, false), ["/pid", "42", "/T"]);
  assert.deepEqual(taskkillArgs(42, true), ["/pid", "42", "/T", "/F"]);
});

test("REGRESSION: a graceful Windows kill asks first (no /F), so AVIDump can finalise", async () => {
  const w = windows(true);
  killTree(42, true, 30, w.deps);
  assert.deepEqual(w.calls, [["taskkill", "/pid", "42", "/T"]]);
  await wait(80);
  assert.deepEqual(w.calls, [
    ["taskkill", "/pid", "42", "/T"],
    ["taskkill", "/pid", "42", "/T", "/F"],
  ]);
});

test("Windows: no escalation when the polite request worked", async () => {
  const w = windows(false);
  killTree(42, true, 30, w.deps);
  await wait(80);
  assert.deepEqual(w.calls, [["taskkill", "/pid", "42", "/T"]]);
});

test("Windows: a stall or an abort is /F straight away", async () => {
  const w = windows(true);
  killTree(42, false, 30, w.deps);
  await wait(80);
  assert.deepEqual(w.calls, [["taskkill", "/pid", "42", "/T", "/F"]]);
});

test("POSIX graceful: SIGTERM children first, then SIGKILL after the delay", async () => {
  const sent: string[] = [];
  killTree(1, true, 30, {
    platform: "linux",
    tree: () => [1, 2, 3],
    signal: (pid, sig) => sent.push(`${sig}:${pid}`),
  });
  assert.deepEqual(sent, ["SIGTERM:3", "SIGTERM:2", "SIGTERM:1"]);
  await wait(80);
  assert.deepEqual(sent.slice(3), ["SIGKILL:3", "SIGKILL:2", "SIGKILL:1"]);
});

test("POSIX hard kill never runs taskkill", () => {
  const sent: string[] = [];
  const execd: string[] = [];
  killTree(1, false, 30, {
    platform: "darwin",
    tree: () => [1],
    signal: (pid, sig) => sent.push(`${sig}:${pid}`),
    exec: (cmd) => execd.push(cmd),
  });
  assert.deepEqual(sent, ["SIGKILL:1"]);
  assert.deepEqual(execd, []);
});

test("onForce fires only when a graceful stop had to be forced", async () => {
  let forced = 0;
  const w = windows(true);
  killTree(42, true, 30, { ...w.deps, onForce: () => forced++ });
  await wait(80);
  assert.equal(forced, 1);
  const ok = windows(false);
  killTree(42, true, 30, { ...ok.deps, onForce: () => forced++ });
  await wait(80);
  assert.equal(forced, 1, "the polite stop worked: nothing forced");
});

test("defaultStopGraceMs: 15 s on Windows (exits after a finalised dump measured past 5 s), 5 s elsewhere", async () => {
  const { defaultStopGraceMs } = await import("../src/run.ts");
  assert.equal(defaultStopGraceMs("win32"), 15_000);
  assert.equal(defaultStopGraceMs("linux"), 5_000);
});
