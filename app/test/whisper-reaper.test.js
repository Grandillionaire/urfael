'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reapOrphanPids } = require('../lib');

// ── the PURE half of the whisper-server reaper (a mirror of the daemon's brain-reaper). main.js appends every
//    spawned whisper pid to ~/.claude/urfael/whisper.pids and, BEFORE binding STT port 8462, SIGKILLs any
//    still-alive recorded pid that a prior crash/force-quit orphaned. Without this, the 168MB model server is
//    leaked forever and only the oldest orphan owns 8462, so a fresh spawn silently fails to bind. These cover
//    the read / dedupe / aliveness-filter logic and prove no orphan pid survives a simulated restart. ──

test('reapOrphanPids parses a pid-file to plausible, de-duplicated pids', () => {
  const alive = () => true;
  assert.deepEqual(reapOrphanPids('101\n202\n303\n', alive), [101, 202, 303]);
  assert.deepEqual(reapOrphanPids('101\n101\n202\n202\n', alive), [101, 202]);           // de-dupe repeat spawns
  // blank lines, whitespace, junk, non-positive and out-of-range values are dropped (a real, plausible pid only)
  assert.deepEqual(reapOrphanPids('\n  \n42\nnot-a-pid\n-7\n0\n99999999999\n', alive), [42]);
  assert.deepEqual(reapOrphanPids('', alive), []);
  assert.deepEqual(reapOrphanPids(null, alive), []);
});

test('reapOrphanPids keeps only STILL-ALIVE pids and fails closed on a throwing probe', () => {
  const living = new Set([101, 303]);
  // 202 exited on its own after the crash → not worth a signal; 101 + 303 are the real leaked servers
  assert.deepEqual(reapOrphanPids('101\n202\n303\n', (pid) => living.has(pid)), [101, 303]);
  // a throwing probe (EPERM etc.) fails closed → not ours to kill
  assert.deepEqual(reapOrphanPids('101\n', () => { throw new Error('EPERM'); }), []);
  // no probe → every plausible pid is returned (matches the daemon's kill-all-then-catch idiom)
  assert.deepEqual(reapOrphanPids('101\n202\n'), [101, 202]);
});

test('simulated restart: an orphaned whisper pid never survives the record → reap → truncate cycle', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-whisper-'));
  const pidfile = path.join(dir, 'whisper.pids');
  // run 1 spawns a whisper-server (pid 4242) and records it, then the app is force-quit (no clean stop):
  fs.appendFileSync(pidfile, 4242 + '\n');
  // run 2 boots. 4242 is STILL ALIVE (an orphan holding STT port 8462). Reap it with the exact idiom main.js uses:
  const stillAlive = new Set([4242]);
  const killed = [];
  for (const pid of reapOrphanPids(fs.readFileSync(pidfile, 'utf8'), (p) => stillAlive.has(p))) { killed.push(pid); stillAlive.delete(pid); }
  fs.writeFileSync(pidfile, '');
  assert.deepEqual(killed, [4242], 'the orphaned whisper-server must be SIGKILLed on restart');
  assert.equal(stillAlive.has(4242), false, 'no orphan whisper pid survives the restart');
  // the fresh server (pid 8888) is recorded; the reaped orphan is gone from the ledger, so it is never double-killed:
  fs.appendFileSync(pidfile, 8888 + '\n');
  assert.deepEqual(reapOrphanPids(fs.readFileSync(pidfile, 'utf8'), () => true), [8888]);
  fs.rmSync(dir, { recursive: true, force: true });
});
