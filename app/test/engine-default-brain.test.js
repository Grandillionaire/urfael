'use strict';
// Unit tests for the NATIVE DEFAULT BRAIN's pure decision + shape-mapper (engine/default-brain.js). This is the
// riskiest feature's core: when the owner pins a native provider as the default brain, the local voice/overlay turn
// (daemon.js brain.ask) routes through here. The load-bearing invariant is BYTE-IDENTICAL-WHEN-UNPINNED — with no pin
// the guard is never entered and runNativeTurn is never called — plus a fail-closed/fail-soft floor that returns null
// (⇒ brain.ask falls through UNCHANGED to the CLI subscription) on ANY miss, so a turn is never dropped and never runs
// on the wrong tier. Driven entirely with hand-built fakes — no daemon, no socket, no network, no live model (matching
// the "no API key" verification bar): the real runNativeTurn is STUBBED so the routing/shape logic is exercised alone.
const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeBrainId, nativeDefaultResult } = require('../engine/default-brain');

// a keyed native provider (has an adapter, needs a secret we DO hold)
const KEYED = { id: 'openai', big_model: 'gpt-5', small_model: 'gpt-5-mini' };
// a CLI-only / subscription entry (pickAdapter returns null for it)
const SUBSCRIPTION = { id: 'claude' };

// Build the injected deps with sane defaults, overridable per test. runNativeTurn records that it was called and
// returns a canned native result; the resolver knows exactly one keyed provider and the subscription.
function mkDeps(over = {}) {
  const calls = { run: 0, reset: 0 };
  const deps = {
    routeOverride: () => null,
    providers: () => [KEYED, SUBSCRIPTION],
    findProvider: (list, id) => list.find((p) => p.id === id) || null,
    pickAdapter: (e) => (e && e.id === SUBSCRIPTION.id ? null : { adapter: {}, baseUrl: '' }),
    secretNeeded: (e) => (e && e.id === KEYED.id ? { env: 'ANTHROPIC_AUTH_TOKEN' } : null),
    hasSecret: () => true,
    resetStream: () => { calls.reset++; },
    now: (() => { let t = 1000; return () => (t += 5); })(),
    onDelta: () => {},
    onThinking: () => {},
    runNativeTurn: async () => { calls.run++; return { ok: true, text: 'native answer', model: 'gpt-5', usage: { inTok: 11, outTok: 22 }, steps: 2 }; },
    ...over,
  };
  return { deps, calls };
}

// ── the load-bearing invariant: UNPINNED ⇒ never entered ────────────────────────────────────────────
test('nativeDefault=null → returns null and NEVER touches runNativeTurn (unpinned path is byte-identical)', async () => {
  const { deps, calls } = mkDeps();
  const r = await nativeDefaultResult(null, 'hello', deps);
  assert.equal(r, null);
  assert.equal(calls.run, 0, 'the native engine must not be reached when no provider is pinned');
  assert.equal(calls.reset, 0, 'no overlay reset when the guard is not entered');
});

// ── fall-through cases: every miss returns null so brain.ask uses the CLI subscription path ──────────
test('an explicit per-turn /model override → null (that override wins the subscription tier for THIS turn)', async () => {
  const { deps, calls } = mkDeps({ routeOverride: () => ({ model: 'opus', text: 'refactor' }) });
  assert.equal(await nativeDefaultResult('openai', '/opus refactor', deps), null);
  assert.equal(calls.run, 0);
});

test('an unknown / unresolvable pin → null (the pin is no longer in the registry)', async () => {
  const { deps, calls } = mkDeps();
  assert.equal(await nativeDefaultResult('ghost-provider', 'hi', deps), null);
  assert.equal(calls.run, 0);
});

test('a CLI-only / subscription entry (pickAdapter null) → null (the subscription can never be the native brain)', async () => {
  const { deps, calls } = mkDeps();
  assert.equal(await nativeDefaultResult('claude', 'hi', deps), null);
  assert.equal(calls.run, 0, 'a subscription pin must fall through, never build a native engine');
});

test('a keyed provider with NO stored key → null (degrades to the subscription until a key is set — never daemon creds)', async () => {
  const { deps, calls } = mkDeps({ hasSecret: () => false });
  assert.equal(await nativeDefaultResult('openai', 'hi', deps), null);
  assert.equal(calls.run, 0, 'a keyless pin must not attempt a run');
});

// ── the success path: exact brain.ask contract + one-time overlay reset ──────────────────────────────
test('a valid keyed provider with a successful native run → the exact brain.ask shape (usage remapped)', async () => {
  const { deps, calls } = mkDeps();
  const r = await nativeDefaultResult('openai', 'do the thing', deps);
  assert.ok(r && typeof r === 'object');
  assert.equal(r.text, 'native answer');
  assert.equal(r.model, 'gpt-5');
  assert.equal(r.aborted, false);
  assert.equal(typeof r.ms, 'number');
  assert.ok(r.ms >= 0);
  // the load-bearing remap: inTok→input_tokens, outTok→output_tokens, cache_read_input_tokens pinned to 0
  assert.deepEqual(r.usage, { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 0 });
  assert.equal(calls.run, 1);
  assert.equal(calls.reset, 1, 'the overlay stream is reset exactly once, after the guards pass and before the run');
  // the returned object must carry ONLY the brain.ask fields — no leaked native internals (steps/engine/error/ok)
  assert.deepEqual(Object.keys(r).sort(), ['aborted', 'model', 'ms', 'text', 'usage']);
});

test('missing native usage fields default to 0 (no NaN leaks into the token counters)', async () => {
  const { deps } = mkDeps({ runNativeTurn: async () => ({ ok: true, text: 'ok', model: 'm' }) });
  const r = await nativeDefaultResult('openai', 'x', deps);
  assert.deepEqual(r.usage, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 });
});

// ── native error / degenerate results all fall through (fail-soft), and NOTHING throws ───────────────
test('a failing native run (ok:false) → null (fall through to the CLI, no throw)', async () => {
  const { deps, calls } = mkDeps({ runNativeTurn: async () => ({ ok: false, error: 'HTTP 500', text: '' }) });
  assert.equal(await nativeDefaultResult('openai', 'x', deps), null);
  assert.equal(calls.reset, 1, 'the reset already fired before the run — the fall-through is post-run');
});

test('an ok:true run with EMPTY text → null (never return an empty native answer over a real CLI one)', async () => {
  const { deps } = mkDeps({ runNativeTurn: async () => ({ ok: true, text: '', model: 'm' }) });
  assert.equal(await nativeDefaultResult('openai', 'x', deps), null);
});

test('a runNativeTurn that THROWS → null (never throws into the shared turn chain)', async () => {
  const { deps } = mkDeps({ runNativeTurn: async () => { throw new Error('boom'); } });
  await assert.doesNotReject(async () => {
    const r = await nativeDefaultResult('openai', 'x', deps);
    assert.equal(r, null);
  });
});

test('a runNativeTurn returning null/undefined → null (defensive)', async () => {
  const { deps: d1 } = mkDeps({ runNativeTurn: async () => null });
  const { deps: d2 } = mkDeps({ runNativeTurn: async () => undefined });
  assert.equal(await nativeDefaultResult('openai', 'x', d1), null);
  assert.equal(await nativeDefaultResult('openai', 'x', d2), null);
});

// ── the persisted-pin sanitizer: only ever a clean id string, empty ⇒ null ───────────────────────────
test('sanitizeBrainId strips everything but [a-z0-9-] and returns a usable id', () => {
  assert.equal(sanitizeBrainId('openai'), 'openai');
  assert.equal(sanitizeBrainId('claude-bedrock'), 'claude-bedrock');
  // a hostile value can never smuggle a path / flag / newline into the state file
  assert.equal(sanitizeBrainId('../evil id!'), 'evilid');
  assert.equal(sanitizeBrainId('ollama\n'), 'ollama');
  assert.equal(sanitizeBrainId('a/b/c;rm -rf'), 'abcrm-rf');
  // case-sensitive by design: registry ids are already slugified lowercase, so an uppercase char is dropped, never
  // silently case-folded — a value that is all-uppercase sanitizes to nothing (⇒ null, the byte-identical default).
  assert.equal(sanitizeBrainId('OLLAMA'), null);
});

test('sanitizeBrainId returns null for empty / non-string / all-stripped input (⇒ no pin, the byte-identical default)', () => {
  assert.equal(sanitizeBrainId(''), null);
  assert.equal(sanitizeBrainId('!!!'), null);
  assert.equal(sanitizeBrainId('/ / /'), null);
  assert.equal(sanitizeBrainId(null), null);
  assert.equal(sanitizeBrainId(undefined), null);
  assert.equal(sanitizeBrainId(42), null);
  assert.equal(sanitizeBrainId({}), null);
});
