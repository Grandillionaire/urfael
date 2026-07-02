'use strict';
// Local event triggers ("watches"): the pure normalizer, the debounce-collapse, the PID alive->exited
// transition, the store cap, and the NO-EGRESS fire routing. Zero-dep node:test, matching the repo style.
// The store persists to ~/.claude/urfael/watches.json, so isolate HOME to a throwaway dir BEFORE requiring the
// modules (node --test runs each file in its own process, so this never touches the real user store).
const os = require('os');
const path = require('path');
const fs = require('fs');
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-watch-home-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;

const { test } = require('node:test');
const assert = require('node:assert');
const lib = require('../lib');
const scheduler = require('../scheduler');

const WATCHES_FILE = path.join(TMP_HOME, '.claude', 'urfael', 'watches.json');
// A clean slate between stateful tests: drop the persisted store, then (re)arm with an injected liveness fn.
function reset(fireFn, aliveFn) {
  try { fs.rmSync(WATCHES_FILE, { force: true }); } catch {}
  scheduler.startWatchers(fireFn || (() => {}), aliveFn ? { isAlive: aliveFn } : {});
}

// ── 1. normalizeWatch (pure, fail-closed) ────────────────────────────────────
test('normalizeWatch: happy paths for on:file / on:glob / on:pid', () => {
  const f = lib.normalizeWatch({ on: 'file', target: '/tmp/a.txt', prompt: 'look at it' });
  assert.equal(f.kind, 'watch');
  assert.equal(f.on, 'file');
  assert.equal(f.target, path.resolve('/tmp/a.txt'));
  assert.equal(f.prompt, 'look at it');
  assert.equal(f.deliver, 'notify');
  assert.equal(f.repeat, false);
  assert.ok(f.debounceMs >= 200 && f.debounceMs <= 60000);

  const g = lib.normalizeWatch({ on: 'glob', target: '/tmp/proj', prompt: 'p', deliver: 'silent' });
  assert.equal(g.on, 'glob');
  assert.equal(g.deliver, 'silent');

  const p = lib.normalizeWatch({ on: 'pid', target: 4321, prompt: 'the build finished' });
  assert.equal(p.on, 'pid');
  assert.equal(p.target, 4321);
});

test('normalizeWatch: rejects unknown / hostile specs (fail-closed → null)', () => {
  assert.equal(lib.normalizeWatch(null), null);
  assert.equal(lib.normalizeWatch([]), null);
  assert.equal(lib.normalizeWatch({ on: 'command', target: 'x', prompt: 'p' }), null);         // no on:'command'
  assert.equal(lib.normalizeWatch({ on: 'file', prompt: 'p' }), null);                          // missing target
  assert.equal(lib.normalizeWatch({ on: 'file', target: '', prompt: 'p' }), null);              // empty target
  assert.equal(lib.normalizeWatch({ on: 'file', target: '/tmp/' + String.fromCharCode(0) + 'evil', prompt: 'p' }), null); // NUL byte
  assert.equal(lib.normalizeWatch({ on: 'file', target: 'a'.repeat(5000), prompt: 'p' }), null); // oversized target
  assert.equal(lib.normalizeWatch({ on: 'pid', target: 0, prompt: 'p' }), null);                // pid <= 0
  assert.equal(lib.normalizeWatch({ on: 'pid', target: -5, prompt: 'p' }), null);
  assert.equal(lib.normalizeWatch({ on: 'pid', target: 3.5, prompt: 'p' }), null);              // non-integer pid
  assert.equal(lib.normalizeWatch({ on: 'pid', target: 'abc', prompt: 'p' }), null);            // NaN pid
  assert.equal(lib.normalizeWatch({ on: 'file', target: '/tmp/a', prompt: '' }), null);         // empty prompt (via normalizeJobAction)
});

test('normalizeWatch: a shell action is NOT representable (no script field is accepted)', () => {
  assert.equal(lib.normalizeWatch({ on: 'file', target: '/tmp/a', kind: 'script', script: 'rm -rf ~' }), null);
  assert.equal(lib.normalizeWatch({ on: 'pid', target: 42, kind: 'script', script: 'id' }), null);
  // the only representable action is a no-egress brain look (kind:'watch' + a prompt)
  const ok = lib.normalizeWatch({ on: 'file', target: '/tmp/a', prompt: 'p' });
  assert.equal(ok.kind, 'watch');
  assert.equal('script' in ok, false);
});

test('normalizeWatch: clamps debounceMs and treats repeat as strictly boolean', () => {
  assert.equal(lib.normalizeWatch({ on: 'file', target: '/x', prompt: 'p', debounceMs: 1 }).debounceMs, 200);
  assert.equal(lib.normalizeWatch({ on: 'file', target: '/x', prompt: 'p', debounceMs: 999999 }).debounceMs, 60000);
  assert.equal(lib.normalizeWatch({ on: 'file', target: '/x', prompt: 'p', debounceMs: 'nope' }).debounceMs, 1000);
  assert.equal(lib.normalizeWatch({ on: 'file', target: '/x', prompt: 'p' }).repeat, false);
  assert.equal(lib.normalizeWatch({ on: 'file', target: '/x', prompt: 'p', repeat: true }).repeat, true);
  assert.equal(lib.normalizeWatch({ on: 'file', target: '/x', prompt: 'p', repeat: 'yes' }).repeat, false); // only literal true
});

test('normalizeWatch: a chained `then` is preserved as a normalized action', () => {
  const w = lib.normalizeWatch({ on: 'file', target: '/x', prompt: 'p', then: { prompt: 'follow up' } });
  assert.ok(w.then && w.then.kind === 'agent' && w.then.prompt === 'follow up');
});

// ── 2. debounce collapse (pure helper, injected clock) ───────────────────────
test('debounce-collapse: a burst of N events fires exactly once; a later event fires again', () => {
  let fires = 0;
  let scheduled = null;                        // fake single-slot timer
  const setT = (fn) => { scheduled = fn; return 1; };
  const clearT = () => { scheduled = null; };
  const d = scheduler.makeDebouncer(1000, () => fires++, setT, clearT);
  d(); d(); d(); d();                          // 4 rapid events collapse onto one pending timer
  assert.equal(fires, 0);                      // nothing fires until the quiet window elapses
  assert.ok(scheduled);
  scheduled();                                 // window elapses
  assert.equal(fires, 1);                      // exactly ONE fire for the whole burst
  d();                                         // a later event, after the window
  scheduled();
  assert.equal(fires, 2);                      // a second, independent fire
});

// ── 3. PID alive -> exited transition ────────────────────────────────────────
test('pid watch: alive->exited fires once; a one-shot removes itself from the store', () => {
  const dead = new Set();
  const fired = [];
  reset((w, meta) => fired.push({ id: w.id, meta }), (pid) => !dead.has(pid));
  const w = scheduler.addWatch({ on: 'pid', target: 999001, prompt: 'the build finished' });
  assert.ok(w);
  scheduler.tickWatch();                        // still alive -> no fire
  assert.equal(fired.length, 0);
  dead.add(999001);
  scheduler.tickWatch();                        // alive -> dead transition -> one fire
  assert.equal(fired.length, 1);
  assert.equal(fired[0].meta.exitPid, 999001);
  scheduler.tickWatch();                        // stays dead -> no re-fire
  assert.equal(fired.length, 1);
  assert.equal(scheduler.getWatch(w.id), null); // one-shot removed itself after firing
});

test('pid watch: a still-alive process never fires; a repeat watch survives its fire', () => {
  const dead = new Set();
  const fired = [];
  reset((w) => fired.push(w.id), (pid) => !dead.has(pid));

  const alive = scheduler.addWatch({ on: 'pid', target: 999010, prompt: 'p' });                 // stays alive
  const rep = scheduler.addWatch({ on: 'pid', target: 999011, prompt: 'p', repeat: true });     // will exit, repeats
  scheduler.tickWatch();
  assert.equal(fired.length, 0);

  dead.add(999011);
  scheduler.tickWatch();                        // only 999011 transitions
  assert.equal(fired.length, 1);
  assert.equal(fired[0], rep.id);
  assert.ok(scheduler.getWatch(rep.id), 'a repeat watch stays in the store after firing');
  assert.ok(scheduler.getWatch(alive.id), 'the still-alive watch is untouched');
  scheduler.tickWatch();                        // 999011 stays dead -> no re-fire (a pid never comes back)
  assert.equal(fired.length, 1);
});

// ── 4. store cap ─────────────────────────────────────────────────────────────
test('addWatch: the store is capped at MAX_ITEMS (a runaway loop cannot fill the disk)', () => {
  reset();
  let n = 0;
  for (let i = 0; i < 260; i++) { const r = scheduler.addWatch({ on: 'pid', target: 200000 + i, prompt: 'p' }); if (r) n++; else break; }
  assert.equal(n, 200);
  assert.equal(scheduler.addWatch({ on: 'pid', target: 999999, prompt: 'p' }), null);
});

// ── 5. NO-EGRESS fire routing ────────────────────────────────────────────────
// lib.watchFireArgs is the single source of truth for what a fired watch hands deliverCron; daemon's
// deliverWatch is a thin `deliverCron(job, opts)` forward of exactly this, so asserting it here proves the fire
// is pinned no-egress (Read/Grep/Glob) and never inherits the default cron toolset (WebFetch/WebSearch).
test('watch fire routing is NO-EGRESS: allowedTools is Read,Grep,Glob and the prompt carries the event', () => {
  const { job, opts } = lib.watchFireArgs(
    { id: 'w9', on: 'file', target: '/tmp/x', prompt: 'inspect the change', deliver: 'notify' },
    { path: '/tmp/x/changed.js' });
  assert.equal(opts.allowedTools, 'Read,Grep,Glob');
  assert.ok(!/WebFetch|WebSearch|Bash|Write|Edit/.test(opts.allowedTools), 'never a network/shell/write tool');
  assert.equal(opts.ev, 'watch_fire');
  assert.ok(job.prompt && job.prompt.length > 0, 'a non-empty prompt to frame');
  assert.match(job.prompt, /changed\.js/);      // the changed path rides in as content (framed untrusted by deliverCron)
  assert.equal(job.id, 'watch:w9');

  const pidFire = lib.watchFireArgs({ id: 'wp', on: 'pid', target: 4242, prompt: 'p' }, { exitPid: 4242 });
  assert.equal(pidFire.opts.allowedTools, 'Read,Grep,Glob');
  assert.match(pidFire.job.prompt, /4242/);
});

// ── CRUD round-trip over the store ──────────────────────────────────────────
test('addWatch / listWatch / getWatch / cancelWatch round-trip', () => {
  reset();
  const w = scheduler.addWatch({ on: 'pid', target: 424242, prompt: 'p' });
  assert.ok(w && w.id);
  assert.ok(scheduler.listWatch().some((x) => x.id === w.id));
  assert.equal(scheduler.getWatch(w.id).target, 424242);
  assert.equal(scheduler.cancelWatch(w.id), true);
  assert.equal(scheduler.getWatch(w.id), null);
  assert.equal(scheduler.cancelWatch('nope-nope'), false);
});
