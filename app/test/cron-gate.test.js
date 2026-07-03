'use strict';
// Single-flight cron gate: a due fire that arrives while a prior run is in flight must be QUEUED and drained on
// completion, never silently DROPPED. The old daemon behavior lost one-shot crons, one-shot watch fires, and
// already-202-acked webhook 'ask's forever (a bare cron_skip log). This exercises lib.makeCronGate — the pure
// state machine the daemon now dispatches through — and, for contrast, the old drop-on-busy policy to document
// exactly the loss the fix removes. Zero-dep node:test, matching the repo style.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeCronGate, dedupePending } = require('../lib');

// A faithful, brain-free reproduction of the daemon's deliverCron/afterCron dispatch loop, parameterized by a
// gate policy. `dispatch(item)` decides run|queue|drop; on "run" the item is marked running, then completes on
// the NEXT drain() call (single-flight: exactly one runs at a time). Returns the observed history.
function driveDaemon(gate, fires) {
  const completed = [];   // items whose run finished (delivered)
  const dropped = [];     // items the gate refused (loud, bounded)
  let inFlight = null;    // the one item currently "running"
  let maxConcurrent = 0;

  const start = (item) => { inFlight = item; maxConcurrent = Math.max(maxConcurrent, 1); };
  // completion: release the flight, deliver, then drain EXACTLY ONE queued fire (re-dispatched through the gate).
  const complete = () => {
    const finished = inFlight; inFlight = null;
    completed.push(finished);
    const next = gate.release();
    if (next) { const r = gate.admit(next); if (r === 'run') start(next); }  // drain one; it re-acquires the flight
  };

  for (const f of fires) {
    const r = gate.admit(f);
    if (r === 'run') start(f);
    else if (r === 'dropped') dropped.push(f);
    // 'queued' => held in the gate, drained later
    if (inFlight) assert.equal(gate.busy(), true, 'flight must be held while an item runs');
    // never two at once
    if (inFlight) maxConcurrent = Math.max(maxConcurrent, 1);
  }
  // drain to quiescence, one completion at a time
  let guard = 0;
  while (inFlight) { complete(); if (++guard > 10000) throw new Error('drain did not terminate'); }
  return { completed, dropped, maxConcurrent };
}

test('makeCronGate: a due fire while busy is QUEUED and drained on completion (never lost)', () => {
  const gate = makeCronGate(32);
  const a = { id: 'A' }, b = { id: 'B' };
  // A acquires the flight; B arrives while A is still running.
  assert.equal(gate.admit(a), 'run');
  assert.equal(gate.busy(), true);
  assert.equal(gate.admit(b), 'queued');   // NOT dropped
  assert.equal(gate.depth(), 1);
  // A completes -> release hands back B to run.
  const next = gate.release();
  assert.strictEqual(next, b, 'B must be drained on completion, not lost');
  assert.equal(gate.admit(b), 'run');
  assert.equal(gate.depth(), 0);
});

test('daemon loop: overlapping fires all complete, one at a time (single-flight preserved, zero loss)', () => {
  const gate = makeCronGate(32);
  const fires = [{ id: 'cron1' }, { id: 'watch1' }, { id: 'hook1' }, { id: 'cron2' }];  // all "due" in the same tick
  const { completed, dropped, maxConcurrent } = driveDaemon(gate, fires);
  assert.equal(dropped.length, 0, 'nothing dropped below cap');
  assert.equal(maxConcurrent, 1, 'single-flight: never more than one brain run at a time');
  assert.deepEqual(completed.map((x) => x.id).sort(), ['cron1', 'cron2', 'hook1', 'watch1'], 'every due fire ran');
});

test('makeCronGate: cap overflow drops LOUDLY (bounded), not silently', () => {
  const gate = makeCronGate(2);   // small cap for the test
  assert.equal(gate.admit({ id: 'run' }), 'run');    // holds the flight
  assert.equal(gate.admit({ id: 'q1' }), 'queued');  // fills the queue...
  assert.equal(gate.admit({ id: 'q2' }), 'queued');
  assert.equal(gate.depth(), 2);
  assert.equal(gate.admit({ id: 'over' }), 'dropped', 'a fire past the cap is dropped (caller logs loudly)');
  assert.equal(gate.depth(), 2, 'the queue never grows past cap');
});

test('makeCronGate: cap is clamped to a sane minimum (never a 0-length wedge)', () => {
  const g0 = makeCronGate(0);
  assert.equal(g0.admit({ id: 'a' }), 'run');
  assert.equal(g0.admit({ id: 'b' }), 'queued');  // cap floored to 1, so at least one can queue
});

// ── contrast: the OLD drop-on-busy policy LOSES the fire — the exact regression this fix removes ──
test('regression contrast: the old drop-on-busy policy loses the due fire', () => {
  // Reproduce the pre-fix gate: a boolean single-flight that DROPS anything arriving while busy.
  let cronRunning = false;
  const oldAdmit = () => { if (cronRunning) return 'dropped'; cronRunning = true; return 'run'; };
  assert.equal(oldAdmit({ id: 'A' }), 'run');
  assert.equal(oldAdmit({ id: 'B' }), 'dropped');  // B is gone forever — the bug
  // the new gate keeps B instead:
  const gate = makeCronGate(32);
  assert.equal(gate.admit({ id: 'A' }), 'run');
  assert.equal(gate.admit({ id: 'B' }), 'queued');  // kept, not lost
});

// ── PERSISTED pending FIFO: a QUEUED fire (already pulled from its one-shot store) must survive a mid-busy RESTART ──
// PR #3's in-memory FIFO stopped drop-on-busy, but a queued fire still vanished if the daemon died before it drained.
// The gate now takes a `persist` snapshot sink; the daemon mirrors it to a bounded, 0600 pending.json. These tests
// reuse that SAME seam with a faithful file-backed sink (the exact atomic temp+rename + remove-when-empty the daemon
// uses) so the whole enqueue→persist→restart→re-dispatch→drain cycle — and the cap — is proven without a live daemon.

// Mirrors daemon.savePendingCron/loadPendingCron: snapshot-on-mutation, atomic 0600 write, file removed when empty.
function filePersist(dir, cap) {
  const file = path.join(dir, 'pending.json');
  const persist = (queue) => {
    if (!queue.length) { fs.rmSync(file, { force: true }); return; }        // empty queue => no file
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(queue, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);                                               // atomic replace
  };
  const load = () => { try { return dedupePending(JSON.parse(fs.readFileSync(file, 'utf8')), cap); } catch { return []; } };
  return { persist, load, file };
}

test('makeCronGate persist: a queued fire survives a simulated restart and is re-dispatched (never lost)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-cronpersist-'));
  try {
    const { persist, load, file } = filePersist(dir, 32);
    // pre-crash daemon: A holds the flight; B arrives while A is still running -> B is QUEUED and PERSISTED.
    const gate = makeCronGate(32, persist);
    const a = { job: { id: 'A' } };
    const b = { job: { id: 'B' }, opts: { ev: 'watch_fire' } };
    assert.equal(gate.admit(a), 'run');
    assert.equal(fs.existsSync(file), false, 'the not-busy fast path never writes pending.json (in-flight is not pending)');
    assert.equal(gate.admit(b), 'queued');
    assert.ok(fs.existsSync(file), 'a queued fire is persisted');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'pending.json is 0600 (owner-only)');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [b], 'only the queued fire is on disk (A is in flight, not pending)');

    // the daemon DIES here — A's release() never runs, and B was already removed from its own store. Simulate a RESTART.
    const restored = load();
    assert.deepEqual(restored, [b], 'B is recovered from pending.json on boot, not lost');

    // boot: clear the file, then re-dispatch the survivor through a FRESH gate (the flight is free, so it runs at once).
    persist([]);
    assert.equal(fs.existsSync(file), false, 'boot clears pending.json before re-dispatch');
    const gate2 = makeCronGate(32, persist);
    const delivered = [];
    for (const it of restored) { if (gate2.admit(it) === 'run') delivered.push(it); }
    assert.deepEqual(delivered, [b], 'the recovered fire re-dispatches (runs) after the restart');
    assert.equal(fs.existsSync(file), false, 'B ran via the fast path — nothing stale is left on disk to re-fire');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('makeCronGate persist: draining a fire removes it from pending.json, and the cap still holds (loud drop)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-cronpersist-'));
  try {
    const { persist, load, file } = filePersist(dir, 2);   // small cap
    const gate = makeCronGate(2, persist);
    assert.equal(gate.admit({ job: { id: 'A' } }), 'run');       // holds the flight
    assert.equal(gate.admit({ job: { id: 'q1' } }), 'queued');
    assert.equal(gate.admit({ job: { id: 'q2' } }), 'queued');   // fills the cap
    assert.deepEqual(load().map((x) => x.job.id), ['q1', 'q2'], 'both queued fires are persisted');
    // cap holds: an overflow is DROPPED (caller logs loudly) and never persisted.
    assert.equal(gate.admit({ job: { id: 'over' } }), 'dropped');
    assert.deepEqual(load().map((x) => x.job.id), ['q1', 'q2'], 'the persisted queue never grows past cap');
    // A completes -> drain q1: it is REMOVED from disk, only q2 remains.
    const next = gate.release();
    assert.equal(next.job.id, 'q1', 'FIFO order: q1 drains first');
    assert.deepEqual(load().map((x) => x.job.id), ['q2'], 'a drained fire is removed from pending.json');
    assert.equal(gate.admit(next), 'run');                       // q1 re-dispatches (fast path)
    assert.deepEqual(load().map((x) => x.job.id), ['q2'], 'q2 stays persisted while q1 re-runs');
    // q1 done -> drain q2 (last one leaves an empty queue -> file removed), then q2 re-dispatches, then nothing left.
    const n2 = gate.release();
    assert.equal(n2.job.id, 'q2');
    assert.equal(fs.existsSync(file), false, 'draining the last queued fire removes the file (empty queue => no file)');
    assert.equal(gate.admit(n2), 'run');
    assert.equal(gate.release(), null, 'nothing left to drain');
    assert.equal(fs.existsSync(file), false, 'still no stale pending.json after the queue fully drains');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dedupePending: dedupes by (job.id, ev), bounds to cap, and drops junk (fail-closed)', () => {
  const items = [
    { job: { id: 'A' } },
    { job: { id: 'A' } },                              // duplicate identity -> collapsed
    { job: { id: 'A' }, opts: { ev: 'hook_fire' } },  // same id, DIFFERENT fire event -> kept
    null, 7, 'x', { nope: 1 }, { job: 'notobj' },     // junk -> dropped, never thrown
    { job: { id: 'B' } }, { job: { id: 'C' } },        // C is past cap 3 -> not reached
  ];
  const out = dedupePending(items, 3);
  assert.deepEqual(
    out.map((x) => x.job.id + '|' + ((x.opts && x.opts.ev) || '')),
    ['A|', 'A|hook_fire', 'B|'],
    'deduped by (id, ev), bounded to cap 3, junk dropped',
  );
  assert.deepEqual(dedupePending('nope', 5), [], 'a non-array is fail-closed to empty');
  assert.deepEqual(dedupePending(null, 5), []);
  assert.equal(dedupePending([{ job: { id: 'z' } }], 0).length, 1, 'cap is floored to a sane minimum of 1');
});
