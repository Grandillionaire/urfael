'use strict';
// Unit tests for the crash-safe in-flight transcript WAL (app/transcript-wal.js). The module is a pure, zero-dep,
// never-throws side journal. These cover the brief's acceptance cases: a clean turn writes then clears the journal;
// a simulated crash (entry left behind) is recovered on the next boot; a write failure never throws and the caller
// proceeds; recovery is exactly-once; and the module never throws on garbage input. The daemon-side flag-off
// byte-identical proof lives in daemon-transcript-wal-wiring.test.js (source-asserts every call is gated).
const { test } = require('node:test');
const assert = require('node:assert');
const { assertOwnerOnly } = require('./_owner-only');
const fs = require('fs');
const os = require('os');
const path = require('path');

const wal = require('../transcript-wal');
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-wal-')); }

test('pathFor resolves the 0600 journal under the given dir', () => {
  const dir = tmp();
  assert.strictEqual(wal.pathFor(dir), path.join(dir, '.transcript-wal.json'));
  assert.strictEqual(wal.WAL_NAME, '.transcript-wal.json');
});

test('a clean turn: record writes the journal, then clear removes it', () => {
  const dir = tmp();
  const p = wal.pathFor(dir);
  assert.strictEqual(fs.existsSync(p), false, 'no journal before the turn starts');
  assert.strictEqual(wal.record(dir, { user: 'what is the weather', turnId: 7 }), true);
  assert.strictEqual(fs.existsSync(p), true, 'journal written at turn start');
  const on = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(on.user, 'what is the weather');
  assert.strictEqual(on.turnId, 7);
  assert.ok(typeof on.t === 'string' && on.t.length > 0, 'a timestamp is stamped');
  assert.strictEqual(wal.clear(dir), true);
  assert.strictEqual(fs.existsSync(p), false, 'journal cleared on clean completion');
});

test('the journal file is created 0600 (owner-only)', () => {
  const dir = tmp();
  wal.record(dir, { user: 'secret-ish message' });
  assertOwnerOnly(assert, wal.pathFor(dir), 'journal must be 0600');
});

test('record stores the user message verbatim (same data the transcript holds, no extra redaction)', () => {
  const dir = tmp();
  const raw = 'my api key is sk-ABC123 and I said "hi"\nnewline';
  wal.record(dir, { user: raw });
  assert.strictEqual(JSON.parse(fs.readFileSync(wal.pathFor(dir), 'utf8')).user, raw);
});

test('a simulated crash (entry left behind) is recovered on the next boot and the user message is never lost', () => {
  const dir = tmp();
  // turn starts, journal written, then the daemon "crashes" before clear() runs.
  wal.record(dir, { user: 'remind me to call the plumber', turnId: 42 });
  const rec = wal.recover(dir);
  assert.ok(rec, 'a surviving entry is recovered');
  assert.strictEqual(rec.user, 'remind me to call the plumber');
  assert.strictEqual(rec.turnId, 42);
  assert.strictEqual(fs.existsSync(wal.pathFor(dir)), false, 'recover consumes the entry (removed as it reads)');
});

test('recovery is exactly-once: a second recover after the first returns null (never double-fires)', () => {
  const dir = tmp();
  wal.record(dir, { user: 'one and only' });
  assert.ok(wal.recover(dir));
  assert.strictEqual(wal.recover(dir), null, 'the entry is gone after the first recovery');
});

test('a clean boot (no crash) recovers nothing: recover on an absent journal is null', () => {
  const dir = tmp();
  assert.strictEqual(wal.recover(dir), null);
});

test('write failure never throws and the turn proceeds (record returns false)', () => {
  // point the journal at a path whose parent is a FILE, so mkdir/write cannot succeed. Must not throw.
  const dir = tmp();
  const asFile = path.join(dir, 'not-a-dir');
  fs.writeFileSync(asFile, 'x');
  let threw = false, out;
  try { out = wal.record(asFile, { user: 'this turn must still complete' }); } catch { threw = true; }
  assert.strictEqual(threw, false, 'record must never throw');
  assert.strictEqual(out, false, 'a failed write returns false, so the caller proceeds unchanged');
});

test('a garbage (non-JSON) journal is consumed and recovers nothing, so it can never wedge a future boot', () => {
  const dir = tmp();
  fs.writeFileSync(wal.pathFor(dir), '{ this is not valid json', { mode: 0o600 });
  assert.strictEqual(wal.recover(dir), null, 'garbage recovers nothing');
  assert.strictEqual(fs.existsSync(wal.pathFor(dir)), false, 'garbage is removed, not left to wedge every boot');
});

test('a journal with no user message recovers nothing', () => {
  const dir = tmp();
  fs.writeFileSync(wal.pathFor(dir), JSON.stringify({ urfael: 'orphan reply', turnId: 3 }), { mode: 0o600 });
  assert.strictEqual(wal.recover(dir), null);
  assert.strictEqual(fs.existsSync(wal.pathFor(dir)), false);
});

test('the module never throws on garbage input (pure, fail-safe on every entrypoint)', () => {
  const junk = [null, undefined, 0, 1, '', 'x', {}, [], { user: 42 }, { user: null }, Symbol.iterator, NaN, Infinity];
  for (const d of junk) {
    for (const e of junk) {
      assert.doesNotThrow(() => wal.record(d, e));
    }
    assert.doesNotThrow(() => wal.clear(d));
    assert.doesNotThrow(() => wal.recover(d));
    assert.doesNotThrow(() => wal.pathFor(d));
  }
});

test('record fails safe (returns false, no file) when given no dir', () => {
  assert.strictEqual(wal.record(null, { user: 'x' }), false);
  assert.strictEqual(wal.record('', { user: 'x' }), false);
});

test('recovered entry normalizes a malformed turnId to 0 and preserves an accumulated reply if present', () => {
  const dir = tmp();
  fs.writeFileSync(wal.pathFor(dir), JSON.stringify({ user: 'u', urfael: 'partial reply', turnId: 'nope' }), { mode: 0o600 });
  const rec = wal.recover(dir);
  assert.strictEqual(rec.user, 'u');
  assert.strictEqual(rec.urfael, 'partial reply');
  assert.strictEqual(rec.turnId, 0);
});
