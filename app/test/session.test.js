'use strict';
// Direct unit tests for the warm-session turn machinery extracted from daemon.js into session.js. The live turn
// loop (the Session class + getSession) was previously reachable ONLY through a booted daemon over the socket
// (app/test/smoke-daemon.test.js) — structurally untestable at the unit level, which is exactly how the caretFor
// regression once shipped green. session.js now takes every collaborator as an INJECTED dependency, so here we hand
// it a FAKE spawn (an EventEmitter child we drive by hand) and exercise the four hard paths in isolation, with NO
// process, NO socket, NO network:
//   1. a queued turn is PROMOTED onto the same warm child the moment the in-flight turn completes,
//   2. a turn that never answers hits the watchdog and resolves as a RETRYABLE '(timed out)',
//   3. a brain that dies mid-turn RESOLVES the waiter with a classified hint (never hangs the queue),
//   4. a retryable failure leaves the Session in the exact state daemon.js/brain.ask reads to pick a FALLBACK model,
//      and getSession(fallback) hands back a distinct warm bucket that answers.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const lib = require('../lib');
const providerSessions = require('../provider-sessions');
const createSessionModule = require('../session');

// the exact house-style de-dasher daemon.js injects (so a result round-trips identically)
const deDash = (s) => String(s == null ? '' : s).replace(/\s*[–—]\s*/g, ', ');

// A hand-driven stand-in for the `claude` child. It speaks the same surface Session binds to (stdout/stderr
// EventEmitters, a writable stdin, .kill(), .pid, and its own exit/error events), so a test can feed it the
// stream-json lines the real CLI would emit — a delta, a terminal `result`, or an abrupt exit.
class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdinLines = [];
    this.stdin = { write: (s) => { this.stdinLines.push(s); return true; } };
  }
  kill() { this.killed = true; return true; }
  // ── test drivers ──
  emitLine(obj) { this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n')); }
  delta(text) { this.emitLine({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } }); }
  result(result, usage) { this.emitLine({ type: 'result', subtype: 'success', is_error: false, result, usage: usage || { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0 } }); }
  stderrData(s) { this.stderr.emit('data', Buffer.from(String(s))); }
  crash() { this.emit('exit'); }   // the process exits with no terminal `result` (a brain death mid-turn)
}

// Build a fresh session module wired to fakes. Returns the module plus the arrays a test inspects.
function makeModule(overrides = {}) {
  const spawned = [];
  const events = [];
  let pidSeq = 1000;
  const mod = createSessionModule({
    spawn: () => { const c = new FakeChild(++pidSeq); spawned.push(c); return c; },
    logEvent: () => {},
    sendThinking: (o) => events.push({ kind: 'thinking', ...o }),
    sendSay: (o) => events.push({ kind: 'say', ...o }),
    deDash,
    classifyError: lib.classifyError,
    segmentSentences: lib.segmentSentences,
    providerSessions,
    providerList: () => [],
    secretFor: () => undefined,
    recordBrainPid: () => {},
    getOverlay: () => null,
    pluginMcpArgs: () => [],
    CLAUDE_BIN: 'claude-fake',
    VAULT: '/tmp/urfael-session-test',
    MEMDIR_ADD: [],
    PERM_MODE: 'acceptEdits',
    MAX_SPOKEN_CHARS: 700,
    TURN_TIMEOUT_MS: 100000,   // effectively no watchdog unless a test overrides it small
    ...overrides,
  });
  return { mod, spawned, events };
}

test('a queued turn is promoted onto the same warm child once the in-flight turn completes', async () => {
  const { mod, spawned } = makeModule();
  const s = mod.getSession('sonnet');
  const p1 = s.ask('first');    // turn 1 becomes current → spawns the one warm child, writes stdin
  const p2 = s.ask('second');   // turn 2 is queued behind it (a serialized session, one turn at a time)
  assert.equal(spawned.length, 1, 'both turns share ONE warm child (never a second spawn)');
  assert.equal(s.current.text, 'first', 'turn 1 is in flight');
  assert.deepEqual(s.queue.map((q) => q.text), ['second'], 'turn 2 waits in the queue');
  const child = spawned[0];
  assert.equal(child.stdinLines.length, 1, 'only the in-flight turn has been sent so far');

  child.result('ANSWER1');                       // terminal result for turn 1
  assert.equal(await p1, 'ANSWER1');
  // On completion _next() must PROMOTE the queued turn onto the same warm child (not leave it hanging).
  assert.ok(s.current && s.current.text === 'second', 'the queued turn is promoted to current');
  assert.equal(s.queue.length, 0, 'the queue drained');
  assert.equal(child.stdinLines.length, 2, 'the promoted turn was written to the SAME warm child stdin');

  child.result('ANSWER2');
  assert.equal(await p2, 'ANSWER2');
  assert.equal(s.current, null, 'idle again after both turns');
});

test('a turn that never answers hits the watchdog and resolves as a retryable "(timed out)"', async () => {
  const { mod, spawned } = makeModule({ TURN_TIMEOUT_MS: 20 });
  const s = mod.getSession('sonnet');
  const reply = await s.ask('hang forever, no result line will come');   // the fake child never emits a result
  assert.equal(reply, '(timed out)', 'the watchdog resolves the waiter, it never hangs');
  assert.equal(s.lastFailed, true, 'the turn is flagged failed so the daemon fallback gate can fire');
  assert.equal(s.errBuf, 'timed out', 'a RETRYABLE reason is recorded for classification');
  const cls = lib.classifyError(s.errBuf);
  assert.equal(cls.category, 'timeout');
  assert.equal(cls.retryable, true, 'the recorded reason classifies as retryable (this is what drives the fallback)');
  assert.equal(cls.hint, 'the turn timed out', 'the classified hint the daemon surfaces');
  assert.ok(spawned[0].killed, 'the hung child is SIGKILLed');
  assert.equal(s.proc, null, 'and discarded, so the next ask re-spawns a clean child');
});

test('a brain that dies mid-turn resolves the waiter with a classified hint (never hangs the queue)', async () => {
  const { mod, spawned } = makeModule();
  const s = mod.getSession('opus');
  const p = s.ask('do a long thing');
  assert.equal(s.current.text, 'do a long thing', 'the turn is in flight');
  // stderr carries WHY it died; then the process exits without ever sending a terminal result.
  spawned[0].stderrData('Error: model is overloaded (529 capacity)');
  spawned[0].crash();
  assert.equal(await p, '(the model is overloaded; try again)', 'the exit handler resolves with the classified stderr hint');
  assert.equal(s.lastFailed, true);
  assert.equal(s.current, null, 'the in-flight slot is cleared, not stuck');

  // and with NO diagnostic on stderr it still resolves (never hangs) with the generic restart hint.
  const s2 = mod.getSession('sonnet');
  const p2 = s2.ask('another');
  spawned[spawned.length - 1].crash();
  assert.equal(await p2, '(restarted, try again)', 'a bare crash still resolves the waiter');
});

test('a retryable failure makes the Session fallback-eligible and getSession(fallback) answers on a distinct bucket', async () => {
  const { mod, spawned } = makeModule({ TURN_TIMEOUT_MS: 20 });
  const primaryModel = lib.MODELS.sonnet;
  const s = mod.getSession(primaryModel);
  const first = await s.ask('please answer');   // times out → a retryable failure on the primary tier
  assert.equal(first, '(timed out)');

  // This is the EXACT gate daemon.js/brain.ask evaluates to decide a one-shot fallback to the other tier.
  const eligible = s.lastFailed && lib.classifyError(s.errBuf).retryable;
  assert.equal(eligible, true, 'a classified retryable error makes the turn fallback-eligible');

  const fb = lib.fallbackModelFor(primaryModel);
  assert.ok(fb && fb !== primaryModel, 'there is a distinct fallback tier');
  const fbSession = mod.getSession(fb);
  assert.notEqual(fbSession, s, 'the fallback runs on a DIFFERENT warm session bucket (getSession keys by model)');

  const fbPromise = fbSession.ask('please answer');
  spawned[spawned.length - 1].result('FALLBACK_ANSWER');   // the fallback tier actually succeeds
  assert.equal(await fbPromise, 'FALLBACK_ANSWER');
  assert.equal(fbSession.lastFailed, false, 'the fallback succeeded, so the daemon would adopt its reply + model');
});

test('getSession is memoized per model+provider and getSessionByKey buckets an explicit chat tile separately', () => {
  const { mod } = makeModule();
  const a = mod.getSession('sonnet');
  const b = mod.getSession('sonnet');
  assert.equal(a, b, 'the same model returns the SAME warm session (one warm child per bucket)');
  assert.notEqual(mod.getSession('opus'), a, 'a different model is a different bucket');
  const tile = mod.getSessionByKey('chat:xyz', 'sonnet', '');
  assert.notEqual(tile, a, 'an explicit-key tile is its own child, never the shared main-brain bucket');
  assert.equal(mod.getSessionByKey('chat:xyz', 'sonnet', ''), tile, 'and is itself memoized by key');
});
