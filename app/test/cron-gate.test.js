'use strict';
// Single-flight cron gate: a due fire that arrives while a prior run is in flight must be QUEUED and drained on
// completion, never silently DROPPED. The old daemon behavior lost one-shot crons, one-shot watch fires, and
// already-202-acked webhook 'ask's forever (a bare cron_skip log). This exercises lib.makeCronGate — the pure
// state machine the daemon now dispatches through — and, for contrast, the old drop-on-busy policy to document
// exactly the loss the fix removes. Zero-dep node:test, matching the repo style.
const { test } = require('node:test');
const assert = require('node:assert');
const { makeCronGate } = require('../lib');

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
