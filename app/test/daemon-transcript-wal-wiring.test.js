'use strict';
// Source-assert guard for the opt-in crash-safe transcript WAL wiring in app/daemon.js. Requiring daemon.js boots the
// brain (it binds the unix socket at load), so we read it as TEXT and assert the load-bearing invariants: the feature
// is env-gated OFF (only the exact value '1' enables it), EVERY WAL call site is wrapped in `if (TRANSCRIPT_WAL_ON)`
// (so with the flag off there is zero extra I/O and the turn path is byte-identical), the record happens as the turn
// STARTS and the clear on clean completion, boot recovery runs right after jobstore.reconcile(), the WAL never touches
// mem.promptText / the turn assembly, the pure module opens NO inbound port, and dependencies stays {}.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const daemon = fs.readFileSync(path.join(APP, 'daemon.js'), 'utf8');
const walSrc = fs.readFileSync(path.join(APP, 'transcript-wal.js'), 'utf8');
const pkg = require('../package.json');

// ── ZERO-DEP + NO NEW PORT ──
test('app/package.json dependencies stays {} (Node built-ins only)', () => {
  assert.deepStrictEqual(pkg.dependencies || {}, {});
});

test('the pure WAL module opens NO inbound port and spawns no process (side journal only)', () => {
  assert.doesNotMatch(walSrc, /\blisten\s*\(|createServer|net\.Server|child_process|\.spawn\b|require\(['"]http['"]\)/);
});

test('the WAL module has no dependencies beyond fs + path (pure, zero-dep)', () => {
  const reqs = [...walSrc.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]).sort();
  assert.deepStrictEqual(reqs, ['fs', 'path']);
});

// ── ENV GATE: only the exact value '1' enables the feature ──
test('TRANSCRIPT_WAL_ON parses ONLY the exact value "1" (default OFF)', () => {
  assert.match(daemon, /const TRANSCRIPT_WAL_ON = process\.env\.URFAEL_TRANSCRIPT_WAL === '1';/);
});

// ── DEFAULT BYTE-IDENTICAL: every single WAL call is gated behind `if (TRANSCRIPT_WAL_ON)` on the same line, so with
//    the flag off none of them runs -> no journal file, zero extra I/O, and the turn path is byte-identical. ──
test('every transcriptWal.* call site is gated behind `if (TRANSCRIPT_WAL_ON)` (flag-off parity)', () => {
  const calls = [...daemon.matchAll(/transcriptWal\.\w+\s*\(/g)];
  assert.ok(calls.length >= 3, 'expected the record + clear + recover call sites, found ' + calls.length);
  // no call to a WAL mutator/reader may appear on a line that is not guarded by the flag.
  for (const line of daemon.split('\n')) {
    if (/transcriptWal\.(record|clear|recover)\s*\(/.test(line)) {
      assert.match(line, /if \(TRANSCRIPT_WAL_ON\)/, 'ungated WAL call would break flag-off parity: ' + line.trim());
    }
  }
});

test('exactly the three intended WAL operations are wired: record, clear, recover', () => {
  assert.strictEqual((daemon.match(/transcriptWal\.record\(/g) || []).length, 1, 'one record (turn start)');
  assert.strictEqual((daemon.match(/transcriptWal\.clear\(/g) || []).length, 1, 'one clear (clean completion)');
  assert.strictEqual((daemon.match(/transcriptWal\.recover\(/g) || []).length, 1, 'one recover (boot)');
});

// ── the record is a SIDE write only: it must NOT read or mutate the model input (mem.promptText / the turn assembly) ──
test('the WAL record is a side write that never touches the model input (mem.promptText)', () => {
  const line = daemon.split('\n').find((l) => /transcriptWal\.record\(/.test(l));
  assert.ok(line, 'record call site not found');
  assert.doesNotMatch(line, /mem\.promptText|promptText/);
  // it records the same `text` + turnId the transcript path already holds, under MEMORY_DIR.
  assert.match(line, /transcriptWal\.record\(MEMORY_DIR, \{ user: text, turnId,/);
});

// ── ORDER: record BEFORE the model call; clear on the return path AFTER transcript.push ──
test('record is journaled BEFORE session.ask (the turn STARTS), clear is on the completion path', () => {
  const askIdx = daemon.indexOf('let reply = await session.ask(mem.promptText');
  const recIdx = daemon.indexOf('transcriptWal.record(');
  assert.ok(recIdx > 0 && askIdx > 0 && recIdx < askIdx, 'record must precede session.ask on the same turn');
  const pushIdx = daemon.indexOf('pushTranscript({ user: text, urfael: reply })');   // capped push helper (server-side bound)
  const clearIdx = daemon.indexOf('transcriptWal.clear(');
  assert.ok(clearIdx > pushIdx && pushIdx > 0, 'clear must come after the transcript push on clean completion');
});

// ── BOOT RECOVERY: recover runs in listen() right after jobstore.reconcile(), and the recovered turn is marked ──
test('boot recovery runs right after jobstore.reconcile() and marks the entry recovered', () => {
  const reconcileIdx = daemon.indexOf('jobstore.reconcile();');
  const recoverIdx = daemon.indexOf('transcriptWal.recover(');
  assert.ok(reconcileIdx > 0 && recoverIdx > reconcileIdx, 'recover must follow jobstore.reconcile() at boot');
  const line = daemon.split('\n').find((l) => /transcriptWal\.recover\(/.test(l));
  assert.match(line, /pushTranscript\(\{ user: w\.user/, 'recovered user message is pushed into the transcript');
  assert.match(line, /recovered: true/, 'the recovered entry is marked recovered');
  assert.match(line, /logEvent\(\{ ev: 'transcript_wal_recover'/, 'a recovery is logged');
});

// ── HONESTY: no em/en dashes in the recovery marker string that can reach the transcript ──
test('the recovery marker string carries no em/en dashes', () => {
  const line = daemon.split('\n').find((l) => /reply lost to a mid-turn crash/.test(l));
  assert.ok(line, 'recovery marker not found');
  assert.doesNotMatch(line, /[–—]/, 'no en/em dashes in user-visible strings');
});

// ── ORIGIN-CLEAN: no origin-reveal note leaks, and no forbidden copy fingerprint is present ──
test('the module carries no origin-reveal note and no copy fingerprint', () => {
  assert.ok(!walSrc.includes('NousResearch' + '/hermes-agent'), 'no origin-reveal note in transcript-wal.js');
  assert.doesNotMatch(walSrc, /mirror of (hermes|openclaw)/i);
});
