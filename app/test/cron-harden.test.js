'use strict';
// Cron reliability hardening (opt-in URFAEL_CRON_HARDEN=1; DEFAULT OFF): the two fail-closed guards added to the
// scheduler's cron tick, plus a byte-identical flag-off PARITY proof. Zero-dep node:test, matching the repo style.
// scheduler.js persists cron to ~/.claude/urfael/cronjobs.json, so isolate HOME to a throwaway dir BEFORE requiring
// it (node --test runs each file in its own process, so this never touches the real user store).
const os = require('os');
const path = require('path');
const fs = require('fs');
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-cron-harden-home-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;
delete process.env.URFAEL_CRON_HARDEN;   // start from the shipped default (flag OFF); tests opt in explicitly

const { test } = require('node:test');
const assert = require('node:assert');
const lib = require('../lib');
const scheduler = require('../scheduler');

const CRON_FILE = path.join(TMP_HOME, '.claude', 'urfael', 'cronjobs.json');
const CLAUDE = { provider: 'claude', model: 'claude-sonnet' };   // stand-in for the daemon's live-brain pin

// Fresh store + injected capture. Every fired job is pushed to `fired`; every skip notice to `skips`.
function reset({ livePin } = {}) {
  try { fs.rmSync(CRON_FILE, { force: true }); } catch {}
  const fired = [];
  const skips = [];
  scheduler.startCron((c) => fired.push(c.id), {
    livePin: () => (livePin === undefined ? CLAUDE : livePin),
    notify: (info) => skips.push(info),
  });
  return { fired, skips };
}
function harden(on) { if (on) process.env.URFAEL_CRON_HARDEN = '1'; else delete process.env.URFAEL_CRON_HARDEN; }
// A repeat-every-5-minutes cron with a first `at` we can then move into the past to simulate a missed window.
function addRepeat(now) { return scheduler.addCron({ prompt: 'do the thing', repeat: { everyMins: 5 }, at: new Date(now).toISOString() }); }
const FIVE_MIN = 5 * 60000;

// ── 1. flag OFF: on-time firing is unchanged ────────────────────────────────
test('flag OFF: a due repeat cron fires on-time and advances, exactly as before', () => {
  harden(false);
  const now = Date.now();
  const { fired } = reset();
  const c = addRepeat(now);
  c.at = now;                                     // due right now
  scheduler.tickCron(now);
  assert.deepEqual(fired, [c.id], 'the due job fired exactly once');
  assert.ok(scheduler.getCron(c.id).at > now, 'nextOccurrence advanced past now');
  assert.equal('lastRun' in scheduler.getCron(c.id), false, 'flag OFF never stamps lastRun (byte-identical store)');
});

// ── 2. flag ON: a single missed window (N collapsed) fires exactly once ──────
test('flag ON: a repeat job missed across N windows fires ONCE, not N times (no catch-up storm)', () => {
  harden(true);
  const now = Date.now();
  const { fired } = reset();
  const c = addRepeat(now);
  c.at = now - 50 * 60000;                         // due 50 min ago == 10 missed 5-min windows, still within the 1h grace
  scheduler.tickCron(now);
  assert.equal(fired.length, 1, 'exactly one fire for the whole gap (the 10 missed windows collapsed to one)');
  assert.equal(fired[0], c.id);
  const after = scheduler.getCron(c.id);
  assert.ok(after.at > now, 'the job advanced past now (no leftover overdue window to fire again)');
  assert.equal(after.at - (now - 50 * 60000) >= 50 * 60000, true, 'advanced by whole windows, not by one step');
  assert.equal(after.lastRun, now, 'lastRun was stamped for the fire');
  harden(false);
});

// ── 3. flag ON: an over-bound (stale) miss is skipped, not fired stale ───────
test('flag ON: a job missed by more than the grace bound is SKIPPED (advanced, never fired stale)', () => {
  harden(true);
  const now = Date.now();
  const { fired, skips } = reset();
  const c = addRepeat(now);
  c.at = now - 2 * 3600000;                        // due 2h ago > 1h grace bound → too stale to fire
  scheduler.tickCron(now);
  assert.equal(fired.length, 0, 'a stale job is not fired');
  assert.equal(skips.length, 1, 'the skip is announced, never silent');
  assert.equal(skips[0].reason, 'stale');
  assert.ok(scheduler.getCron(c.id).at > now, 'the stale job is re-armed forward, not left overdue or fired');
  harden(false);
});

// ── 4. flag ON: a fresh job (no lastRun, at in the future) is NOT retro-fired ─
test('flag ON: a job with no prior lastRun and a future due time is not retroactively fired', () => {
  harden(true);
  const now = Date.now();
  const { fired } = reset();
  const c = addRepeat(now);                        // addCron seeds `at` to the NEXT occurrence (future), never the past
  assert.ok(scheduler.getCron(c.id).at > now, 'a fresh repeat job starts due in the future');
  assert.equal('lastRun' in scheduler.getCron(c.id), false, 'no lastRun yet');
  scheduler.tickCron(now);
  assert.equal(fired.length, 0, 'a not-yet-due job never fires, so it is not retro-fired for all history');
  harden(false);
});

// ── 5. flag ON: provider/model drift => fail-closed skip ─────────────────────
test('flag ON: a job whose recorded brain has drifted from the live config is SKIPPED (fail-closed)', () => {
  harden(true);
  const now = Date.now();
  const { fired, skips } = reset({ livePin: { provider: 'ollama', model: 'llama' } });  // live brain changed since authoring
  const c = addRepeat(now);
  c.at = now - 60000;                              // due 1 min ago, well within grace
  c.pin = { provider: 'claude', model: 'claude-sonnet' };  // authored against Claude, now on Ollama
  scheduler.tickCron(now);
  assert.equal(fired.length, 0, 'a drifted job never runs on a different brain');
  assert.equal(skips.length, 1);
  assert.equal(skips[0].reason, 'drift');
  assert.ok(scheduler.getCron(c.id).at > now, 'the drifted job is advanced, not fired');
  harden(false);
});

// ── 6. flag ON: no drift => the job runs ─────────────────────────────────────
test('flag ON: a job whose recorded brain still matches the live config runs normally', () => {
  harden(true);
  const now = Date.now();
  const { fired, skips } = reset({ livePin: CLAUDE });
  const c = addRepeat(now);
  c.at = now - 60000;                              // due, within grace
  c.pin = { provider: 'claude', model: 'claude-sonnet' };  // matches the live pin exactly
  scheduler.tickCron(now);
  assert.deepEqual(fired, [c.id], 'no drift => the job fires');
  assert.equal(skips.length, 0, 'no skip notice when nothing drifted');
  harden(false);
});

// ── 7. addCron records a pin ONLY under the flag (byte-identical store when off) ─
test('addCron records the brain pin only when the flag is on; flag-off store shape is unchanged', () => {
  const now = Date.now();

  harden(false);
  reset();
  const off = addRepeat(now);
  assert.equal('pin' in off, false, 'flag OFF: no pin field is added to the persisted job');
  const offDisk = JSON.parse(fs.readFileSync(CRON_FILE, 'utf8')).find((x) => x.id === off.id);
  assert.equal('pin' in offDisk, false, 'flag OFF: no pin field on disk');
  assert.equal('lastRun' in offDisk, false, 'flag OFF: no lastRun field on disk');

  harden(true);
  reset({ livePin: CLAUDE });
  const on = addRepeat(now);
  assert.deepEqual(on.pin, { provider: 'claude', model: 'claude-sonnet' }, 'flag ON: the live brain is pinned at authoring');
  harden(false);
});

// ── 8. the pure decision function is total + fail-closed ─────────────────────
test('cronDecision: pure, fail-closed outcomes (drift / stale / already-ran / due)', () => {
  const now = 1_000_000_000_000;
  const grace = 3600000;
  // drift: a pin that does not match the live pin
  assert.equal(scheduler.cronDecision({ at: now, pin: CLAUDE }, now, grace, { provider: 'ollama', model: 'x' }).reason, 'drift');
  // drift is fail-closed even when the live pin is unknown (null)
  assert.equal(scheduler.cronDecision({ at: now, pin: CLAUDE }, now, grace, null).reason, 'drift');
  // no pin => drift can never trigger (flag-off authoring shape)
  assert.equal(scheduler.cronDecision({ at: now }, now, grace, null).fire, true);
  // stale: overdue by more than the bound
  assert.equal(scheduler.cronDecision({ at: now - grace - 1 }, now, grace, CLAUDE).reason, 'stale');
  // within grace: fires
  assert.equal(scheduler.cronDecision({ at: now - grace + 1 }, now, grace, CLAUDE).fire, true);
  // already-ran idempotence: a recorded run at/after this due time never double-fires
  assert.equal(scheduler.cronDecision({ at: now, lastRun: now }, now, grace, CLAUDE).reason, 'already-ran');
});

// ── 9. FLAG-OFF PARITY: the fire path is byte-identical to the pristine algorithm ─
// The strongest proof: build a mixed store that WOULD be affected by every hardening guard (a stale-overdue job and a
// pin-mismatched job), run the real flag-off tick, and run a local re-implementation of the ORIGINAL loop over an
// identical clone. Same jobs must fire and the store must end in the same state — i.e. none of the guards engaged.
test('flag OFF parity: tickCron fires + advances exactly like the pristine (pre-hardening) algorithm', () => {
  harden(false);
  const now = Date.now();
  const { fired, skips } = reset({ livePin: { provider: 'ollama', model: 'x' } });  // a live pin that WOULD drift-skip if the flag were on

  // a) a normal on-time repeat  b) a wildly-stale repeat (would be grace-skipped if on)  c) a pin-mismatched repeat (would drift-skip if on)
  const a = addRepeat(now); a.at = now;
  const b = addRepeat(now); b.at = now - 6 * 3600000;                 // 6h overdue
  const d = addRepeat(now); d.at = now - 60000; d.pin = CLAUDE;       // carries a pin that mismatches the live 'ollama'

  // a deep clone of the exact pre-tick state, to run the original algorithm against
  const clone = scheduler.listCron().map((c) => JSON.parse(JSON.stringify(c)));
  const pristineFired = [];
  for (const c of clone.slice()) {                                    // ← verbatim shape of the original tickCron loop
    if (c.at > now) continue;
    pristineFired.push(c.id);
    if (!lib.nextOccurrence(c, now)) clone.splice(clone.indexOf(c), 1);
  }

  scheduler.tickCron(now);

  assert.equal(skips.length, 0, 'flag OFF emits no skip notices (no guard ran)');
  assert.deepEqual([...fired].sort(), [a.id, b.id, d.id].sort(), 'flag OFF fires every due job, including the stale + pin-mismatched ones');
  assert.deepEqual([...fired].sort(), [...pristineFired].sort(), 'the fired set matches the pristine algorithm exactly');

  // resulting store state (id -> at) must match the pristine run, and carry NO hardening bookkeeping
  const realState = {}; for (const c of scheduler.listCron()) { realState[c.id] = c.at; assert.equal('lastRun' in c, false, 'flag OFF never stamps lastRun'); }
  const cloneState = {}; for (const c of clone) cloneState[c.id] = c.at;
  assert.deepEqual(realState, cloneState, 'the surviving store (id -> next due) is byte-identical to the pristine result');
});
