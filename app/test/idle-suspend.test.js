'use strict';
// Idle-suspend guard: the opt-in, default-OFF scale-to-zero cadence for the OUTBOUND bridge pollers
// (URFAEL_IDLE_SUSPEND). This exercises the pure IdleGovernor state machine, the bridge-core gate + doorbell, and
// SOURCE-ASSERTS the load-bearing safety invariants that make this beat a gateway-suspending design:
//   • the DEFAULT poll paths are byte-identical (the OFF ternary resolves to the exact original POLL_SECS*1000);
//   • idle-governor.js is STRUCTURALLY incapable of touching the brain socket or the allowlist gate;
//   • the allowlist (resolvePrincipal) still runs before the brain (askDaemon) on a woken poll;
//   • the doorbell is fail-closed AND fail-safe — a missing/hostile mtime can only poll MORE, never drop a message;
//   • zero new dependency, no new inbound port.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { IdleGovernor } = require('../bridge/idle-governor');
const core = require('../bridge/bridge-core');
const pkg = require('../package.json');

const APP = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');
const GOV_SRC = read('bridge/idle-governor.js');
const IMSG_SRC = read('bridge/imessage-bridge.js');
const EMAIL_SRC = read('bridge/email-bridge.js');
const CORE_SRC = read('bridge/bridge-core.js');

// ── GOVERNOR STATE MACHINE ──────────────────────────────────────────────────────────────────────────────────
test('within idleAfterMs nextDelay() is activeMs and state() is active', () => {
  const g = new IdleGovernor({ activeMs: 4000, idleAfterMs: 300000, probeMs: 60000 });
  const base = Date.now(); g.markActivity(base);
  assert.equal(g.nextDelay(base + 1000), 4000);          // 1s after activity: still hot
  assert.equal(g.state(), 'active');
  assert.equal(g.suspended(), false);
  assert.equal(g.nextDelay(base + 299999), 4000);        // just under the window: still hot
  assert.equal(g.state(), 'active');
});

test('at/after idleAfterMs nextDelay() is probeMs and state() is suspended', () => {
  const g = new IdleGovernor({ activeMs: 4000, idleAfterMs: 300000, probeMs: 60000 });
  const base = Date.now(); g.markActivity(base);
  assert.equal(g.nextDelay(base + 300000), 60000);       // exactly at the window: suspended
  assert.equal(g.state(), 'suspended');
  assert.equal(g.suspended(), true);
  assert.equal(g.nextDelay(base + 900000), 60000);       // well past: still suspended
  assert.equal(g.state(), 'suspended');
});

test('probeMs is floored to Math.max(activeMs, probeMs) — idle is never faster than hot', () => {
  // A misconfigured probe SMALLER than the hot cadence must be raised to the hot cadence, never below it.
  const g = new IdleGovernor({ activeMs: 60000, idleAfterMs: 1000, probeMs: 4000 });
  assert.equal(g.probeMs, 60000);
  const base = Date.now(); g.markActivity(base);
  assert.equal(g.nextDelay(base + 5000), 60000);         // suspended, but never faster than the 60s hot cadence
  // when probe >= active, the probe value is kept as-is
  const g2 = new IdleGovernor({ activeMs: 4000, idleAfterMs: 1000, probeMs: 60000 });
  assert.equal(g2.probeMs, 60000);
});

test('markActivity() snaps a suspended governor back to the hot cadence', () => {
  const g = new IdleGovernor({ activeMs: 4000, idleAfterMs: 300000, probeMs: 60000 });
  const base = Date.now(); g.markActivity(base);
  assert.equal(g.nextDelay(base + 400000), 60000);       // suspended
  g.markActivity(base + 400000);                         // owner traffic
  assert.equal(g.nextDelay(base + 401000), 4000);        // hot again
  assert.equal(g.state(), 'active');
});

test('wakeAt(recent mtime) warms the poller; wakeAt(0/absent/stale) never suspends it longer', () => {
  const g = new IdleGovernor({ activeMs: 4000, idleAfterMs: 300000, probeMs: 60000 });
  const base = Date.now(); g.markActivity(base);
  assert.equal(g.nextDelay(base + 400000), 60000);       // suspended
  g.wakeAt(base + 400000);                               // doorbell mtime ~ now => warm
  assert.equal(g.nextDelay(base + 401000), 4000);        // hot again
  // a 0 / absent / stale (older) mtime folds via max() => cannot pull `last` backward, cannot deepen suspension
  const before = g.last;
  g.wakeAt(0); g.wakeAt(); g.wakeAt(base); // stale/absent
  assert.equal(g.last, before, 'a stale/absent doorbell mtime must never move last backward');
});

test('a stale/hostile FUTURE doorbell mtime can only push the poller HOT, never suspend it longer', () => {
  const g = new IdleGovernor({ activeMs: 4000, idleAfterMs: 300000, probeMs: 60000 });
  const base = Date.now(); g.markActivity(base);
  g.wakeAt(base + 10_000_000);                           // a hostile far-future mtime
  // even far in the "future" relative to base, the poller is HOT (worst case: it polls MORE) — never dropped
  assert.equal(g.nextDelay(base + 20000), 4000);
  assert.equal(g.state(), 'active');
});

test('timestamps are max()-guarded: a backward clock jump only keeps the governor hot', () => {
  const g = new IdleGovernor({ activeMs: 4000, idleAfterMs: 300000, probeMs: 60000 });
  const base = Date.now(); g.markActivity(base);
  // clock jumps BACKWARD: now < last. (now-last) is negative => below idleAfterMs => hot. Never suspends on skew.
  assert.equal(g.nextDelay(base - 500000), 4000);
  assert.equal(g.state(), 'active');
});

test('the governor never throws on junk input (undefined/NaN/negative/null/strings)', () => {
  assert.doesNotThrow(() => {
    for (const bad of [undefined, null, NaN, -5, 'x', {}, [], { activeMs: NaN, idleAfterMs: -1, probeMs: 'no' }]) {
      const g = new IdleGovernor(bad);
      g.nextDelay(undefined); g.nextDelay(NaN); g.nextDelay(-1); g.nextDelay('z');
      g.markActivity(undefined); g.markActivity(null); g.markActivity(NaN); g.markActivity(-9);
      g.wakeAt(undefined); g.wakeAt(null); g.wakeAt(NaN); g.wakeAt(-9); g.wakeAt('nope');
      g.state(); g.suspended();
      assert.ok(g.activeMs > 0 && g.probeMs >= g.activeMs, 'sanitized knobs stay sane');
    }
  });
});

// ── GATE PARSING (reuses lib.envOn) ─────────────────────────────────────────────────────────────────────────
test('idleSuspendGate returns null for unset/0/no/false/junk (default OFF)', () => {
  assert.equal(core.idleSuspendGate({}), null);
  for (const v of ['0', 'no', 'false', 'off', 'yes-please', '', 'nope', '2']) {
    assert.equal(core.idleSuspendGate({ URFAEL_IDLE_SUSPEND: v }), null, 'must be OFF for ' + JSON.stringify(v));
  }
});

test('idleSuspendGate returns the defaults (5min/60s) for 1/on/true with knobs unset', () => {
  for (const v of ['1', 'on', 'true', 'TRUE', 'On']) {
    assert.deepEqual(core.idleSuspendGate({ URFAEL_IDLE_SUSPEND: v }), { idleAfterMs: 300000, probeMs: 60000 });
  }
});

test('idleSuspendGate honors URFAEL_IDLE_AFTER_MIN and URFAEL_IDLE_PROBE_SECS overrides', () => {
  const g = core.idleSuspendGate({ URFAEL_IDLE_SUSPEND: '1', URFAEL_IDLE_AFTER_MIN: '10', URFAEL_IDLE_PROBE_SECS: '120' });
  assert.deepEqual(g, { idleAfterMs: 600000, probeMs: 120000 });
});

test('idleSuspendGate falls back to the defaults on invalid numeric knobs', () => {
  for (const bad of ['abc', '-5', '0', '', 'NaN']) {
    const g = core.idleSuspendGate({ URFAEL_IDLE_SUSPEND: '1', URFAEL_IDLE_AFTER_MIN: bad, URFAEL_IDLE_PROBE_SECS: bad });
    assert.deepEqual(g, { idleAfterMs: 300000, probeMs: 60000 }, 'bad knob ' + JSON.stringify(bad) + ' must fall back');
  }
});

// ── ZERO-DEP + NO NEW PORT ──────────────────────────────────────────────────────────────────────────────────
test('app/package.json dependencies stays {} (Node built-ins only)', () => {
  assert.deepStrictEqual(pkg.dependencies || {}, {});
});

test('no new inbound port: the idle-suspend code opens no listener (no listen/createServer/net.Server)', () => {
  assert.doesNotMatch(GOV_SRC, /\blisten\s*\(|createServer|net\.Server|socketPath/, 'idle-governor.js must open no port and reference no socketPath');
  // the two changed bridges add no server primitive; WAKEF is a plain fs file (stat/write/utimes), never a socket
  for (const [name, src] of [['imessage', IMSG_SRC], ['email', EMAIL_SRC], ['bridge-core', CORE_SRC]]) {
    assert.doesNotMatch(src, /\blisten\s*\(|createServer|net\.Server/, name + ' must not open a new inbound port');
  }
  assert.match(CORE_SRC, /fs\.writeFileSync\(WAKEF, ''/, 'WAKEF must be a plain fs file');
  assert.match(CORE_SRC, /fs\.statSync\(WAKEF\)/, 'wakeMtime must stat a plain fs file');
});

// ── STRUCTURAL SOCKET/ALLOWLIST ISOLATION (the core Hermes-beating invariant) ───────────────────────────────
test('idle-governor.js is structurally isolated from the brain socket and the allowlist gate', () => {
  assert.doesNotMatch(GOV_SRC, /daemon\.sock|\bSOCK\b|socketPath|askDaemon|resolvePrincipal|\/ask\b/,
    'the suspension module must not reference the brain socket, the /ask path, or the allowlist gate');
  // and it requires none of the brain plumbing (no require of bridge-core / the socket)
  assert.doesNotMatch(GOV_SRC, /require\((['"])[^'"]*bridge-core\1\)/, 'governor must not require bridge-core');
});

// ── DEFAULT BYTE-IDENTICAL OFF PATH ─────────────────────────────────────────────────────────────────────────
test('the imessage loop sleep is the exact OFF-path literal (flag off => POLL_SECS*1000, byte-identical)', () => {
  assert.ok(IMSG_SRC.includes('await sleep(gov ? gov.nextDelay() : POLL_SECS * 1000);'),
    'imessage loop must sleep on the exact ternary so the OFF branch is the original POLL_SECS*1000');
  // the governor is only ever constructed when the gate is non-null
  assert.match(IMSG_SRC, /const gov = idleCfg \? new IdleGovernor\(\{ activeMs: POLL_SECS \* 1000, \.\.\.idleCfg \}\) : null;/);
});

test('the email non-IDLE fallback sleep is the exact OFF-path literal (byte-identical)', () => {
  assert.ok(EMAIL_SRC.includes('await sleep(gov ? gov.nextDelay() : POLL_SECS * 1000);'),
    'email non-IDLE fallback must sleep on the exact ternary so the OFF branch is the original POLL_SECS*1000');
  assert.match(EMAIL_SRC, /const gov = idleCfg \? new IdleGovernor\(\{ activeMs: POLL_SECS \* 1000, \.\.\.idleCfg \}\) : null;/);
});

test('the email governor is constructed in main() (survives serve reconnects), not inside serve()', () => {
  // the construction must sit BEFORE the reconnect for(;;) and serve() must be threaded the shared governor
  const govIdx = EMAIL_SRC.indexOf('const gov = idleCfg ? new IdleGovernor');
  const loopIdx = EMAIL_SRC.indexOf('for (;;) {', EMAIL_SRC.indexOf('let backoff = 1000;'));
  assert.ok(govIdx > 0 && loopIdx > govIdx, 'the governor must be created before the reconnect loop');
  assert.match(EMAIL_SRC, /await serve\(conn, gov\)/, 'serve() must receive the shared governor');
  assert.match(EMAIL_SRC, /async function serve\(\{ imap, sock, hasIdle \}, gov\)/);
  // and serve must NOT construct its own governor (that would reset to hot every reconnect)
  const serveBody = EMAIL_SRC.slice(EMAIL_SRC.indexOf('async function serve('), EMAIL_SRC.indexOf('async function main('));
  assert.doesNotMatch(serveBody, /new IdleGovernor/, 'serve() must not construct a governor');
});

// ── ALLOWLIST UNCHANGED + RE-RUN ON WAKE ────────────────────────────────────────────────────────────────────
test('the allowlist (resolvePrincipal) still runs before the brain (askDaemon) on the imessage wake path', () => {
  // handle() is the only caller of askDaemon in this bridge; it is invoked only AFTER the principal is resolved.
  const idxResolve = IMSG_SRC.indexOf("core.resolvePrincipal('imessage', HANDLE)");
  const idxHandleCall = IMSG_SRC.indexOf('handle(r.text, principal)');
  assert.ok(idxResolve > 0 && idxHandleCall > idxResolve, 'resolvePrincipal must precede the brain hand-off');
  assert.match(IMSG_SRC, /const reply = core\.stripSpoken\(await core\.askDaemon\(text, 'imessage', principal\)\)/,
    'askDaemon is reached only through handle(text, principal), after the allowlist gate');
});

test('a non-roster woken poll audits imessage_drop and never reaches the brain (askDaemon)', () => {
  // the drop guard sits AFTER wakeAt() and BEFORE the drain loop: an unrostered handle continues (drop) without
  // ever calling handle()/askDaemon or snapping the governor active. Suspension changes cadence, never the gate.
  const idxWake = IMSG_SRC.indexOf('gov && gov.wakeAt(core.wakeMtime())');
  const idxDrop = IMSG_SRC.indexOf("core.audit({ ev: 'imessage_drop', from: HANDLE }); continue;");
  const idxHandleCall = IMSG_SRC.indexOf('handle(r.text, principal)');
  const idxMark = IMSG_SRC.indexOf('gov.markActivity()');
  assert.ok(idxWake > 0 && idxDrop > idxWake, 'the drop guard must run on the woken poll');
  assert.ok(idxHandleCall > idxDrop, 'the brain hand-off must be after the drop guard');
  assert.ok(idxMark > idxDrop, 'markActivity/idle_wake must be after the drop guard (a dropped poll never snaps active)');
});

// ── DOORBELL: FAIL-CLOSED + FAIL-SAFE + GATED ───────────────────────────────────────────────────────────────
test('wakeMtime() is fail-closed: never throws and returns a number (0 when the doorbell is absent)', () => {
  const hadWake = fs.existsSync(core.WAKEF);
  const savedMs = hadWake ? fs.statSync(core.WAKEF).mtimeMs : null;
  try {
    try { fs.unlinkSync(core.WAKEF); } catch {}
    assert.equal(typeof core.wakeMtime(), 'number');
    assert.equal(core.wakeMtime(), 0, 'an absent doorbell reads as 0 (=> the governor keeps its probe cadence)');
  } finally {
    if (hadWake) { try { fs.writeFileSync(core.WAKEF, '', { mode: 0o600 }); fs.utimesSync(core.WAKEF, new Date(savedMs), new Date(savedMs)); } catch {} }
  }
});

test('touchWake() is a no-op when the flag is off (no WAKEF) and writes a 0600 mtime-only file when on', () => {
  const hadWake = fs.existsSync(core.WAKEF);
  const savedMs = hadWake ? fs.statSync(core.WAKEF).mtimeMs : null;
  const savedFlag = process.env.URFAEL_IDLE_SUSPEND;
  try {
    try { fs.unlinkSync(core.WAKEF); } catch {}
    // OFF: no-op, WAKEF never created (notifyAll behavior stays byte-identical)
    delete process.env.URFAEL_IDLE_SUSPEND;
    core.touchWake();
    assert.equal(fs.existsSync(core.WAKEF), false, 'flag OFF => touchWake must not create WAKEF');
    // ON: creates a 0600, EMPTY file (mtime-only doorbell, no secret) and wakeMtime reads a positive mtime
    process.env.URFAEL_IDLE_SUSPEND = '1';
    core.touchWake();
    assert.equal(fs.existsSync(core.WAKEF), true, 'flag ON => touchWake creates WAKEF');
    const st = fs.statSync(core.WAKEF);
    assert.equal(st.size, 0, 'WAKEF holds NO secret (mtime-only)');
    if (process.platform !== 'win32') assert.equal(st.mode & 0o777, 0o600, 'WAKEF must be mode 0600 (POSIX; profile ACL covers win32)');
    assert.ok(core.wakeMtime() > 0, 'wakeMtime reads the doorbell after touchWake');
  } finally {
    if (savedFlag === undefined) delete process.env.URFAEL_IDLE_SUSPEND; else process.env.URFAEL_IDLE_SUSPEND = savedFlag;
    try { fs.unlinkSync(core.WAKEF); } catch {}
    if (hadWake) { try { fs.writeFileSync(core.WAKEF, '', { mode: 0o600 }); fs.utimesSync(core.WAKEF, new Date(savedMs), new Date(savedMs)); } catch {} }
  }
});

test('notifyAll rings the doorbell at its TOP so a scheduled/heartbeat push warms the pollers (zero daemon.js edits)', () => {
  // the doorbell lives entirely in bridge-core.notifyAll (already invoked from daemon.js:1356 + bridge/notify.js),
  // so no line of daemon.js changes. Assert touchWake() is the first statement of notifyAll and is flag-gated.
  const body = CORE_SRC.slice(CORE_SRC.indexOf('async function notifyAll(text) {'));
  assert.match(body.slice(0, 120), /async function notifyAll\(text\) \{\s*\n\s*touchWake\(\);/, 'touchWake() must be the first statement in notifyAll');
  assert.match(CORE_SRC, /function touchWake\(\) \{\s*\n\s*if \(!lib\.envOn\(process\.env\.URFAEL_IDLE_SUSPEND\)\) return;/, 'touchWake must be gated on the master flag');
});

// ── ORIGIN-CLEAN ────────────────────────────────────────────────────────────────────────────────────────────
test('idle-governor.js carries no origin-reveal comment', () => {
  assert.ok(!GOV_SRC.includes('NousResearch' + '/hermes-agent'), 'no origin-reveal slug in idle-governor.js');
});
