import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lastFrameOf } from "../src/slp.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dr-slp-"));

/** A synthetic replay footer: …"lastFrame"l<int32be>… */
function fakeSlp(name: string, frame: number, marker = "l"): string {
  const head = Buffer.from("\x7bU\x03raw[$U#l...some payload bytes...");
  const key = Buffer.from(`lastFrame${marker}`);
  const val = Buffer.alloc(4);
  val.writeInt32BE(frame);
  const tail = Buffer.from("U\x0bplayedOnSU\x07network}}");
  const p = path.join(tmp, name);
  fs.writeFileSync(p, Buffer.concat([head, key, val, tail]));
  return p;
}

test("reads lastFrame from the UBJSON footer", () => {
  assert.equal(lastFrameOf(fakeSlp("a.slp", 8454)), 8454);
  assert.equal(lastFrameOf(fakeSlp("b.slp", 123456)), 123456);
});

test("takes the LAST occurrence", () => {
  // "lastFrame" can appear earlier in a payload by chance; the metadata footer
  // is what we want, and it is last.
  const p = path.join(tmp, "c.slp");
  const decoy = Buffer.concat([Buffer.from("lastFramel"), (() => { const b = Buffer.alloc(4); b.writeInt32BE(11); return b; })()]);
  const real = Buffer.concat([Buffer.from("lastFramel"), (() => { const b = Buffer.alloc(4); b.writeInt32BE(9999); return b; })()]);
  fs.writeFileSync(p, Buffer.concat([decoy, Buffer.from("filler"), real, Buffer.from("}}")]));
  assert.equal(lastFrameOf(p), 9999);
});

test("returns null rather than guessing when the marker is wrong", () => {
  // A bare string match is not enough — without the 'l' int32 marker we would
  // be reading four arbitrary bytes as a frame count.
  assert.equal(lastFrameOf(fakeSlp("d.slp", 8454, "S")), null);
});

test("returns null for a missing or unreadable file", () => {
  assert.equal(lastFrameOf(path.join(tmp, "nope.slp")), null);
  const empty = path.join(tmp, "e.slp");
  fs.writeFileSync(empty, "");
  assert.equal(lastFrameOf(empty), null);
});

test("returns null when the value is truncated", () => {
  const p = path.join(tmp, "f.slp");
  fs.writeFileSync(p, Buffer.concat([Buffer.from("lastFramel"), Buffer.from([0, 1])]));
  assert.equal(lastFrameOf(p), null);
});
