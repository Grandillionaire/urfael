'use strict';
// Crash-safe durable stores: lib.atomicWriteJSON (tmp-write + fsync + atomic rename, 0600) plus the scheduler's
// corrupt-read policy for reminders.json + cronjobs.json. A crash / ENOSPC mid-write must never truncate or wipe
// the owner's reminders/crons, and a corrupt store must be QUARANTINED for recovery — never silently reset to
// empty. Zero-dep node:test, matching the repo style. The scheduler stores persist under ~/.claude/urfael, so
// isolate HOME to a throwaway dir BEFORE requiring the modules (node --test runs each file in its own process, so
// this never touches the real user store).
const os = require('os');
const path = require('path');
const fs = require('fs');
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-atomic-home-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const { test } = require('node:test');
const assert = require('node:assert');
const lib = require('../lib');
const scheduler = require('../scheduler');

const JDIR = path.join(TMP_HOME, '.claude', 'urfael');
const FILE = path.join(JDIR, 'reminders.json');
const CRON_FILE = path.join(JDIR, 'cronjobs.json');

// Remove every store + quarantine sidecar so each stateful test starts clean.
function wipe() {
  try { fs.rmSync(JDIR, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(JDIR, { recursive: true });
}
function siblings(file) {
  const dir = path.dirname(file), base = path.basename(file);
  try { return fs.readdirSync(dir).filter((n) => n.startsWith(base)); } catch { return []; }
}
// Capture console.error during fn(); returns the captured lines so we can prove a corrupt read logs LOUDLY.
function captureErr(fn) {
  const orig = console.error; const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  try { fn(); } finally { console.error = orig; }
  return lines;
}

// ── 1. atomicWriteJSON: round-trip + owner-only mode, no sidecar left behind ──
test('atomicWriteJSON: a normal write round-trips, is 0600, and leaves no .tmp sidecar', () => {
  wipe();
  const f = path.join(JDIR, 'rt.json');
  const obj = { hello: 'world', list: [1, 2, 3], nested: { a: true } };
  const ret = lib.atomicWriteJSON(f, obj);
  assert.equal(ret, f, 'returns the target path on success');
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), obj, 'round-trips byte-for-byte');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600, 'written owner-only (0600)');
  // exactly one file at that name — the tmp sibling was renamed away, not left behind
  assert.deepEqual(siblings(f), ['rt.json'], 'no leftover .tmp-* sidecar after a successful write');
});

// ── 2. atomicWriteJSON never truncates the existing store on a failed write ──
// The real regression: a non-atomic writeFileSync that dies mid-write leaves a truncated (or 0-byte) file, wiping
// the owner's data. atomicWriteJSON serializes FIRST, so a bad value throws BEFORE any file op — the prior store
// is left byte-identical, never truncated. A circular value is a faithful stand-in for "the write blew up".
test('atomicWriteJSON: a failed serialize leaves the PRIOR file intact (never truncated/wiped)', () => {
  wipe();
  const f = path.join(JDIR, 'durable.json');
  const good = { reminders: [{ id: 'a', at: 1 }, { id: 'b', at: 2 }] };
  lib.atomicWriteJSON(f, good);
  const before = fs.readFileSync(f, 'utf8');

  const circular = {}; circular.self = circular;              // JSON.stringify throws on this
  assert.throws(() => lib.atomicWriteJSON(f, circular), /circular|Converting/i, 'a bad value throws, it does not silently succeed');

  assert.equal(fs.readFileSync(f, 'utf8'), before, 'the prior store is byte-identical — the failed write never touched it');
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), good, 'and still parses to the full prior contents (not truncated)');
  assert.deepEqual(siblings(f), ['durable.json'], 'the failed write left no half-written .tmp-* sidecar');
});

// ── 3. reminders store: a corrupt read is QUARANTINED, not silently wiped ──
test('reminders: a corrupt store is quarantined (not silently reset) and logged loudly', () => {
  wipe();
  const junk = '{ this is not valid json ]]';
  fs.writeFileSync(FILE, junk);

  const logs = captureErr(() => scheduler.start(() => {}));    // start() re-loads the reminders store

  assert.deepEqual(scheduler.list(), [], 'the in-memory store starts fresh (empty)');
  assert.equal(fs.existsSync(FILE), false, 'the corrupt file was moved aside, not left in place');
  const quarantine = path.join(JDIR, 'reminders.json.corrupt-0');
  assert.ok(fs.existsSync(quarantine), 'the corrupt bytes are quarantined for recovery');
  assert.equal(fs.readFileSync(quarantine, 'utf8'), junk, 'the owner can recover the exact original bytes');
  assert.ok(logs.some((l) => /corrupt/i.test(l) && /quarantin/i.test(l)), 'the quarantine is logged LOUDLY, not swallowed');
});

// ── 3b. watches store: the same crash-safe quarantine policy (this store shipped with the old silent-reset bug) ──
test('watches: a corrupt store is quarantined too, not silently reset', () => {
  wipe();
  const WATCHES_FILE = path.join(JDIR, 'watches.json');
  const junk = '{ half-written watch store';
  fs.writeFileSync(WATCHES_FILE, junk);
  const logs = captureErr(() => scheduler.startWatchers(() => {}, {}));   // startWatchers() re-loads the watches store
  assert.equal(fs.existsSync(WATCHES_FILE), false, 'the corrupt watches file was moved aside, not left in place');
  const quarantine = path.join(JDIR, 'watches.json.corrupt-0');
  assert.ok(fs.existsSync(quarantine), 'the corrupt watches bytes are quarantined for recovery');
  assert.equal(fs.readFileSync(quarantine, 'utf8'), junk, 'the owner can recover the exact original bytes');
  assert.ok(logs.some((l) => /corrupt/i.test(l) && /quarantin/i.test(l)), 'the quarantine is logged LOUDLY, not swallowed');
});

// ── 4. cron store: same quarantine policy, and a second corruption never clobbers the first ──
test('cronjobs: a corrupt store is quarantined, and repeated corruption keeps every recovery copy', () => {
  wipe();
  fs.writeFileSync(CRON_FILE, 'not-json-at-all');
  captureErr(() => scheduler.startCron(() => {}));             // startCron() re-loads the cron store
  assert.deepEqual(scheduler.listCron(), [], 'the cron store starts fresh');
  assert.ok(fs.existsSync(path.join(JDIR, 'cronjobs.json.corrupt-0')), 'first corruption -> .corrupt-0');

  // a second corrupt boot must NOT overwrite the first quarantine — pick the next free index
  fs.writeFileSync(CRON_FILE, '][');
  captureErr(() => scheduler.startCron(() => {}));
  assert.ok(fs.existsSync(path.join(JDIR, 'cronjobs.json.corrupt-1')), 'second corruption -> .corrupt-1 (first copy preserved)');
  assert.ok(fs.existsSync(path.join(JDIR, 'cronjobs.json.corrupt-0')), 'the earlier recovery copy is never clobbered');
});

// ── 5. a MISSING store is a normal first boot: fresh + silent, NOT a quarantine ──
test('a missing store starts fresh silently (a first boot is not a corruption)', () => {
  wipe();
  fs.rmSync(FILE, { force: true });
  const logs = captureErr(() => scheduler.start(() => {}));
  assert.deepEqual(scheduler.list(), []);
  assert.equal(siblings(FILE).length, 0, 'no quarantine sidecar is created for a simply-absent file');
  assert.equal(logs.length, 0, 'a first boot logs nothing loud');
});

// ── 6. happy-path persistence still round-trips through the atomic writer ──
test('reminders + crons persist through the atomic writer and reload verbatim (0600, no behavior change)', () => {
  wipe();
  scheduler.start(() => {});
  const r = scheduler.add({ text: 'stretch break', inMins: 15 });
  assert.ok(r && r.id, 'a reminder was added');
  assert.equal(fs.statSync(FILE).mode & 0o777, 0o600, 'reminders.json is written owner-only');
  const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.ok(Array.isArray(onDisk) && onDisk.some((x) => x.id === r.id), 'the reminder is on disk as a JSON array');

  scheduler.startCron(() => {});
  const c = scheduler.addCron({ prompt: 'summarize my inbox', inMins: 30 });
  assert.ok(c && c.id, 'a cron job was added');
  assert.equal(fs.statSync(CRON_FILE).mode & 0o777, 0o600, 'cronjobs.json is written owner-only');

  // reload from disk (fresh start) and confirm the survivors come back verbatim
  scheduler.start(() => {});
  scheduler.startCron(() => {});
  assert.ok(scheduler.list().some((x) => x.id === r.id), 'the reminder reloads from disk');
  assert.ok(scheduler.listCron().some((x) => x.id === c.id), 'the cron reloads from disk');
});
