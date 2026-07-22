'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reapOrphanPids, pidStartMarker, pidStartMarkerAsync, stillOursProbe, makePidLedger } = require('../lib');

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

// ── PID-REUSE DEFENSE. Aliveness alone is not enough: if the OS recycled a leaked pid for an UNRELATED process,
//    a kill-if-alive reaper SIGKILLs a bystander. So each pid is recorded as `pid:marker` where marker is the
//    pid's OS start-time; the reaper only kills a pid whose CURRENT start-time still equals the recorded one. ──

test('reapOrphanPids parses a pid:marker line and hands the marker to the probe', () => {
  const seenMarkers = {};
  const probe = (pid, marker) => { seenMarkers[pid] = marker; return true; };
  assert.deepEqual(reapOrphanPids('101:Fri Jul  3 10:00:01 2026\n202:abc\n', probe), [101, 202]);
  assert.equal(seenMarkers[101], 'Fri Jul  3 10:00:01 2026');   // the marker (which itself contains colons) survives intact — pid is only the part before the FIRST colon
  assert.equal(seenMarkers[202], 'abc');
  // a legacy pid-only line (no colon) yields an empty marker, so behavior is unchanged for old pid-files
  const legacy = {};
  reapOrphanPids('303\n', (pid, marker) => { legacy[pid] = marker; return true; });
  assert.equal(legacy[303], '');
});

test('stillOursProbe: reaps ONLY a pid whose current marker still matches the recorded one', () => {
  // current OS markers: 4242 was RECYCLED (new start-time), 8888 is still our leaked orphan (same start-time), 9 is dead
  const nowMarker = (pid) => ({ 4242: 'START-NEW', 8888: 'START-B' }[pid] || '');
  const probe = stillOursProbe(nowMarker);
  assert.equal(probe(4242, 'START-A'), false, 'a recycled pid (marker changed) is NOT ours to kill');
  assert.equal(probe(8888, 'START-B'), true, 'a pid whose marker still matches IS still our process');
  assert.equal(probe(9, 'START-X'), false, 'a dead pid (no current marker) fails closed');
  assert.equal(probe(4242, ''), false, 'an empty recorded marker (legacy line) fails closed');
  assert.equal(stillOursProbe(() => { throw new Error('boom'); })(1, 'm'), false, 'a throwing marker source fails closed');
});

test('pidStartMarker: normalizes ps output, and fails to the empty string on any error', () => {
  assert.equal(pidStartMarker(4242, () => 'Fri Jul  3 10:00:01 2026\n'), 'Fri Jul 3 10:00:01 2026'); // collapse whitespace + trim
  assert.equal(pidStartMarker(4242, () => { throw new Error('no such process'); }), ''); // ps exit 1 on a dead pid → ''
  assert.equal(pidStartMarker(4242, null), '');            // no probe → ''
  assert.equal(pidStartMarker(-1, () => 'x'), '');         // implausible pid → '' (never probed)
});

test('pidStartMarkerAsync: non-blocking twin — same normalization, fails closed to the empty string, calls back exactly once', () => {
  const seen = [];
  // an execFile-shaped async probe: (cmd, args, cb=(err, stdout)). The callback fires with the normalized marker.
  pidStartMarkerAsync(4242, (cmd, args, cb) => cb(null, 'Fri Jul  3 10:00:01 2026\n'), (m) => seen.push(m));
  assert.deepEqual(seen, ['Fri Jul 3 10:00:01 2026'], 'collapse whitespace + trim, exactly as the sync probe does');
  const dead = []; pidStartMarkerAsync(4242, (cmd, args, cb) => cb(new Error('no such process')), (m) => dead.push(m));
  assert.deepEqual(dead, [''], 'a ps error (dead pid) fails closed to the empty string');
  const noProbe = []; pidStartMarkerAsync(4242, null, (m) => noProbe.push(m));
  assert.deepEqual(noProbe, [''], 'no async probe → ""');
  const bad = []; pidStartMarkerAsync(-1, (c, a, cb) => cb(null, 'x'), (m) => bad.push(m));
  assert.deepEqual(bad, [''], 'implausible pid → "" (probe never called)');
  const threw = []; pidStartMarkerAsync(4242, () => { throw new Error('spawn EAGAIN'); }, (m) => threw.push(m));
  assert.deepEqual(threw, [''], 'a throwing runAsync fails closed to ""');
});

test('makePidLedger: record() captures the marker OFF the hot path (async ps), and a recycled pid is NOT killed while a still-matching pid IS reaped', () => {
  const files = new Map();
  const killed = [];
  const startTimes = new Map();                            // fake OS process table: pid -> start-time
  const pending = [];                                      // queued async ps callbacks — proves record() did NOT block on a sync ps
  let syncPsCalls = 0;                                     // must stay 0 across record(): the spawn hot path never runs ps synchronously
  const io = {
    read: (f) => { if (!files.has(f)) throw new Error('ENOENT'); return files.get(f); },
    write: (f, s) => files.set(f, s),
    append: (f, s) => files.set(f, (files.get(f) || '') + s),
    mkdir: () => {},
    kill: (pid) => killed.push(pid),
    // pid extraction is arg-shape-agnostic (first integer in the argv) so this fake models BOTH the POSIX probe
    // (`ps -o lstart= -p <pid>`) and the win32 one (`powershell … -Id <pid> …`) — the marker VALUE is OS-neutral.
    // execFileSync-shaped fake: SYNCHRONOUS — reap()'s boot-path verify uses this.
    run: (cmd, args) => { syncPsCalls++; const pid = parseInt((args.join(' ').match(/\d+/) || [])[0], 10); if (!startTimes.has(pid)) throw new Error('no such process'); return startTimes.get(pid) + '\n'; },
    // execFile-shaped ASYNC fake: record() uses this. The callback is QUEUED, not run inline, so record() returns
    // before the probe resolves — modelling the real non-blocking child_process.execFile off the spawn hot path.
    runAsync: (cmd, args, cb) => { pending.push(() => { const pid = parseInt((args.join(' ').match(/\d+/) || [])[0], 10); if (!startTimes.has(pid)) return cb(new Error('no such process')); cb(null, startTimes.get(pid) + '\n'); }); },
  };
  const ledger = makePidLedger(io, '/x/brain.pids');

  // run 1: two children spawn and are recorded. The marker is captured ASYNC, so record() returns immediately.
  startTimes.set(4242, 'Fri Jul  3 10:00:01 2026');
  startTimes.set(8888, 'Fri Jul  3 10:00:02 2026');
  ledger.record(4242); ledger.record(8888);
  // FAST PATH: record() blocked on NO synchronous ps and wrote NOTHING yet — two async ps probes are still queued.
  assert.equal(syncPsCalls, 0, 'record() must NOT run a synchronous ps on the spawn hot path');
  assert.equal(files.has('/x/brain.pids'), false, 'the pid:marker line is appended only once the async ps resolves');
  assert.equal(pending.length, 2, 'each record() queued a non-blocking ps probe instead of blocking on a sync one');
  // drain the async probes → NOW the pid:marker lines land, exactly as the old sync path produced them.
  while (pending.length) pending.shift()();
  assert.equal(files.get('/x/brain.pids'), '4242:Fri Jul 3 10:00:01 2026\n8888:Fri Jul 3 10:00:02 2026\n');
  // then the app is force-quit (no clean stop) — the ledger persists both recorded (pid, marker) pairs.

  // between runs the OS RECYCLES pid 4242 for an unrelated process (a new start-time); 8888 is still our orphan.
  startTimes.set(4242, 'Fri Jul  3 11:30:00 2026');

  // run 2 boots and reaps: only the still-matching orphan is SIGKILLed; the recycled pid is spared (fail-closed).
  ledger.reap();
  assert.deepEqual(killed, [8888], 'the reaper kills ONLY the pid still holding its recorded marker; the recycled pid is untouched');
  assert.equal(files.get('/x/brain.pids'), '', 'the ledger is truncated after the reap so nothing is double-killed');
});
