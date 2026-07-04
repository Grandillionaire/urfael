'use strict';
// Unit tests for LIVE PROVIDER FALLBACK's pure decision logic (engine/fallback.js). Two total, I/O-free helpers:
//
//   • classifyNativeError — is a failed native run worth retrying on ANOTHER provider? RETRYABLE only for transient
//     endpoint faults (network/timeout/overload/5xx/429/408); TERMINAL for 4xx/auth/bad-request, refused redirects,
//     config errors, over-cap responses, an OWNER abort, an ok:true run, and any unrecognized/malformed input. The
//     anti-spoof invariant: the HTTP status is read from the ANCHORED prefix, so a hostile body can't fake a class.
//   • nativeFallbackChain — the ordered fallback candidates, having dropped the primary (index 0), any CLI-only /
//     subscription provider (canEngine false), and — the FAIL-CLOSED rule — any provider whose OWN secret is absent
//     (hasSecret false). The load-bearing guarantee: it NEVER returns the primary and NEVER returns a keyless entry,
//     so a native retry can never run on the daemon's own credentials.
//
// Driven with fixture strings/objects + hand predicates — no network, no daemon, no live model.
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyNativeError, nativeFallbackChain } = require('../engine/fallback');

const retry = (err, extra) => classifyNativeError({ ok: false, error: err, ...(extra || {}) });

// ── classifyNativeError: RETRYABLE (transient, a DIFFERENT provider may succeed) ────────────────────
test('classifyNativeError — 5xx / overload statuses are RETRYABLE', () => {
  for (const e of ['HTTP 500', 'HTTP 502', 'HTTP 503: upstream unavailable', 'HTTP 504', 'HTTP 529']) {
    const c = retry(e);
    assert.equal(c.retryable, true, e);
    assert.equal(c.category, 'http_' + e.slice(5, 8));
  }
});
test('classifyNativeError — 429 (rate limit) and 408 (request timeout) are RETRYABLE cross-provider', () => {
  assert.equal(retry('HTTP 429: rate limited').retryable, true);
  assert.equal(retry('HTTP 408').retryable, true);
});
test('classifyNativeError — raw socket/DNS faults are RETRYABLE', () => {
  for (const e of ['connect ECONNREFUSED 127.0.0.1:443', 'getaddrinfo ENOTFOUND api.example.com',
    'read ECONNRESET', 'connect ETIMEDOUT', 'socket hang up']) {
    assert.equal(retry(e).retryable, true, e);
  }
});
test('classifyNativeError — timeouts and api-level Overloaded are RETRYABLE', () => {
  assert.equal(retry('turn timed out').retryable, true);
  assert.equal(retry('turn timed out').category, 'timeout');
  assert.equal(retry('api error: Overloaded').retryable, true);
  assert.equal(retry('api error: Overloaded').category, 'overload');
});

// ── classifyNativeError: TERMINAL (a different provider would fail the same way, or the user cancelled) ──
test('classifyNativeError — 4xx (bad request / auth / forbidden / not-found / unprocessable) are TERMINAL', () => {
  for (const e of ['HTTP 400: bad request', 'HTTP 401 unauthorized', 'HTTP 403 forbidden', 'HTTP 404', 'HTTP 422']) {
    const c = retry(e);
    assert.equal(c.retryable, false, e);
    assert.equal(c.category, 'http_' + e.slice(5, 8).trim());
  }
});
test('classifyNativeError — refused redirect / disallowed base URL / no model / over-cap are TERMINAL', () => {
  for (const e of ['redirect refused (301)', 'invalid or disallowed base URL', 'no model',
    'response text exceeded cap', 'tool-call arguments exceeded cap', 'api error: quota exceeded']) {
    assert.equal(retry(e).retryable, false, e);
  }
});
test('classifyNativeError — an OWNER abort is TERMINAL (never fight the user\'s cancel)', () => {
  assert.equal(classifyNativeError({ ok: false, stopReason: 'aborted', error: 'aborted' }).retryable, false);
  assert.equal(classifyNativeError({ ok: false, stopReason: 'aborted', error: 'aborted' }).category, 'aborted');
  // stopReason alone (no matching error text) still classifies aborted
  assert.equal(classifyNativeError({ ok: false, stopReason: 'aborted', error: 'HTTP 503' }).category, 'aborted');
});

// ── classifyNativeError: the ANTI-SPOOF invariant + totality ────────────────────────────────────────
test('classifyNativeError — status read from the ANCHORED prefix, NOT the body (anti-spoof)', () => {
  // a genuine 4xx whose BODY happens to echo "503 overloaded rate limit" must stay TERMINAL — otherwise a hostile
  // endpoint could spoof a retry loop across every one of the user's keys.
  const c = classifyNativeError({ ok: false, error: 'HTTP 400: {"message":"503 overloaded rate limit"}' });
  assert.equal(c.retryable, false);
  assert.equal(c.category, 'http_400');
});
test('classifyNativeError — success and malformed inputs are TERMINAL and NEVER throw', () => {
  assert.equal(classifyNativeError({ ok: true, text: 'hi' }).retryable, false);
  assert.equal(classifyNativeError({ ok: true, text: 'hi' }).category, 'ok');
  for (const bad of [{}, null, undefined, 42, 'a string', [], { ok: false }, { ok: false, error: null }]) {
    let c;
    assert.doesNotThrow(() => { c = classifyNativeError(bad); });
    assert.equal(c.retryable, false, JSON.stringify(bad));
  }
});

// ── nativeFallbackChain: the ordered, fail-closed candidate list ─────────────────────────────────────
const P = { id: 'primary' }, A = { id: 'a' }, B = { id: 'b' }, C = { id: 'c' };

test('nativeFallbackChain — keyless providers are DROPPED; the primary is never returned', () => {
  const out = nativeFallbackChain({
    chain: [P, A, B, C],
    canEngine: () => true,
    hasSecret: (e) => e.id !== 'b',          // B has no stored secret
  });
  assert.deepEqual(out.map((e) => e.id), ['a', 'c']);       // keyless B skipped, primary excluded
  assert.ok(!out.includes(P), 'the primary is never a fallback candidate');
  assert.ok(out.every((e) => e.id !== 'b'), 'a keyless provider is never attempted (fail-closed)');
});
test('nativeFallbackChain — a non-engineable (subscription/CLI-only) provider is DROPPED', () => {
  const out = nativeFallbackChain({
    chain: [P, A, B, C],
    canEngine: (e) => e.id !== 'a',          // A can't run on the native engine
    hasSecret: () => true,
  });
  assert.deepEqual(out.map((e) => e.id), ['b', 'c']);
});
test('nativeFallbackChain — empty / single-element chains yield NO fallbacks', () => {
  assert.deepEqual(nativeFallbackChain({ chain: [], canEngine: () => true, hasSecret: () => true }), []);
  assert.deepEqual(nativeFallbackChain({ chain: [P], canEngine: () => true, hasSecret: () => true }), []);
});
test('nativeFallbackChain — falsy/holey entries are skipped', () => {
  const out = nativeFallbackChain({
    chain: [P, null, A, undefined, 0, C],
    canEngine: () => true,
    hasSecret: () => true,
  });
  assert.deepEqual(out.map((e) => e.id), ['a', 'c']);
});
test('nativeFallbackChain — a THROWING predicate fails CLOSED (that entry is skipped)', () => {
  const outEng = nativeFallbackChain({
    chain: [P, A, B],
    canEngine: (e) => { if (e.id === 'a') throw new Error('boom'); return true; },
    hasSecret: () => true,
  });
  assert.deepEqual(outEng.map((e) => e.id), ['b'], 'a canEngine throw drops that provider');
  const outSec = nativeFallbackChain({
    chain: [P, A, B],
    canEngine: () => true,
    hasSecret: (e) => { if (e.id === 'a') throw new Error('boom'); return true; },
  });
  assert.deepEqual(outSec.map((e) => e.id), ['b'], 'a hasSecret throw drops that provider');
});
test('nativeFallbackChain — malformed input NEVER throws; missing predicates default permissive but still exclude the primary', () => {
  for (const bad of [undefined, null, {}, { chain: null }, { chain: 42 }, 'x']) {
    let out;
    assert.doesNotThrow(() => { out = nativeFallbackChain(bad); });
    assert.deepEqual(out, []);
  }
  // with predicates omitted they default to permissive, but index 0 (primary) is ALWAYS excluded
  const out = nativeFallbackChain({ chain: [P, A, B] });
  assert.deepEqual(out.map((e) => e.id), ['a', 'b']);
  assert.ok(!out.includes(P));
});
test('nativeFallbackChain — combined engine + secret gates (the daemon\'s real predicate shape)', () => {
  // mirror the daemon: canEngine=pickAdapter truthiness, hasSecret= no-key OR key-present
  const chain = [
    { id: 'primary', authKind: 'key', key: true },
    { id: 'sub', authKind: 'none', engine: false },      // subscription: not engineable
    { id: 'nokey', authKind: 'key', key: false },        // key provider with NO stored secret
    { id: 'local', authKind: 'local', key: false },      // local endpoint: no secret needed -> kept
    { id: 'good', authKind: 'key', key: true },          // engineable + keyed -> kept
  ];
  const out = nativeFallbackChain({
    chain,
    canEngine: (e) => e.engine !== false,
    hasSecret: (e) => e.authKind !== 'key' || e.key === true,
  });
  assert.deepEqual(out.map((e) => e.id), ['local', 'good']);
});
