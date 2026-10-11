import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lastFrameOf, lastFrameFromEvents, lastFrameFromFooter } from "../src/slp.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dr-slp-"));
// The suite shares a process and these are fixtures, not artifacts — remove them.
// Hundreds of `dr-slp-*` dirs had accumulated in /tmp before this existed.
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

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

// --- the raw event-stream fallback -------------------------------------------
// Anonymised ranked replays carry metadata with NO lastFrame. record() used to
// hard-fail on those, and a consumer worked around it by rewriting the replay
// file with a patched footer. Walk the frames instead.

/** A minimal .slp: EVENT_PAYLOADS declaring 0x38/0x3C, then those events. */
function synthSlp(frames: number[], opts: { footer?: number; declaredLen?: number; truncate?: number } = {}) {
  const head = Buffer.from("{U\x03raw[$U#l");
  const events: Buffer[] = [];
  // EVENT_PAYLOADS: size counts itself; two (command, uint16 size) triples.
  const payloads = Buffer.from([0x35, 7, 0x38, 0x00, 0x04, 0x3c, 0x00, 0x04]);
  events.push(payloads);
  for (const f of frames) {
    const post = Buffer.alloc(5);
    post[0] = 0x38;
    post.writeInt32BE(f, 1);
    const book = Buffer.alloc(5);
    book[0] = 0x3c;
    book.writeInt32BE(f, 1);
    events.push(post, book);
  }
  let raw = Buffer.concat(events);
  if (opts.truncate != null) raw = raw.subarray(0, raw.length - opts.truncate);
  const len = Buffer.alloc(4);
  len.writeInt32BE(opts.declaredLen ?? raw.length);
  const tail =
    opts.footer != null
      ? (() => {
          const b = Buffer.alloc(14);
          Buffer.from("lastFrame").copy(b, 0);
          b.write("l", 9);
          b.writeInt32BE(opts.footer, 10);
          return b;
        })()
      : Buffer.from("U\x08metadata{}}");
  return Buffer.concat([head, len, raw, tail]);
}

test("REGRESSION: a replay with no lastFrame in its metadata still yields a length", () => {
  const buf = synthSlp([-123, 0, 500, 8454]);
  assert.equal(lastFrameFromFooter(buf), null, "fixture really has no footer value");
  assert.equal(lastFrameFromEvents(buf), 8454);
});

test("the footer wins when it is there — the scan is only a fallback", () => {
  const buf = synthSlp([0, 100], { footer: 100 });
  assert.equal(lastFrameFromFooter(buf), 100);
});

test("a replay still being written (declared length 0) is scanned to EOF", () => {
  const buf = synthSlp([0, 1, 2, 3], { declaredLen: 0 });
  assert.equal(lastFrameFromEvents(buf), 3);
});

test("a truncated final event keeps the frames already seen instead of throwing", () => {
  const buf = synthSlp([0, 1, 2], { declaredLen: 0, truncate: 3 });
  assert.equal(lastFrameFromEvents(buf), 2);
});

test("garbage is null, not a guess", () => {
  assert.equal(lastFrameFromEvents(Buffer.from("not a replay at all")), null);
});
