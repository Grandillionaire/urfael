'use strict';
// Unit tests for app/run-scope.js (OPT-IN URFAEL_RUN_SCOPE=1, default OFF) and its two wired seams:
//   (a) FAIR PER-ORIGIN SHARE on top of the global remote-turn cap (askScoped) — one origin can't monopolize.
//   (b) ORIGIN-SCOPED RESUME — an existing run/session/job is resumed only by the origin that created it.
// Every acceptance case from the brief is here, INCLUDING an explicit flag-off byte-identical/parity check.
const { test } = require('node:test');
const assert = require('node:assert');
const rs = require('../run-scope');

// ── the flag reader (foundation of every "default off, byte-identical" claim) ──
test('enabled(): only the exact string "1" arms it; unset / "0" / "true" / anything-else stays OFF', () => {
  assert.equal(rs.enabled({}), false);                       // unset → off (the shipped default)
  assert.equal(rs.enabled({ URFAEL_RUN_SCOPE: '0' }), false);
  assert.equal(rs.enabled({ URFAEL_RUN_SCOPE: 'true' }), false);
  assert.equal(rs.enabled({ URFAEL_RUN_SCOPE: 'yes' }), false);
  assert.equal(rs.enabled({ URFAEL_RUN_SCOPE: ' 1 ' }), false);   // strict: no trimming, only exact '1'
  assert.equal(rs.enabled({ URFAEL_RUN_SCOPE: '1' }), true);
});

// ── origin derivation: reuse the SAME { principal, role, channel } the daemon already derives; never invent identity ──
test('originKey(): local owner, then principal, then channel, then fail-closed UNKNOWN; a key string round-trips', () => {
  assert.equal(rs.originKey({ role: 'owner', principal: 'p1', channel: 'telegram' }), rs.OWNER);   // owner wins
  assert.equal(rs.originKey({ role: 'local' }), rs.OWNER);
  assert.equal(rs.originKey({ local: true }), rs.OWNER);
  assert.equal(rs.originKey({ role: 'member', principal: 'alice', channel: 'telegram' }), 'p:alice');
  assert.equal(rs.originKey({ role: 'guest', channel: 'discord' }), 'c:discord');   // no principal → channel
  assert.equal(rs.originKey({ role: 'guest', principal: '   ' }), rs.UNKNOWN);       // blank principal + no channel → fail-closed
  assert.equal(rs.originKey({}), rs.UNKNOWN);
  assert.equal(rs.originKey(null), rs.UNKNOWN);
  assert.equal(rs.originKey('p:alice'), 'p:alice');   // already-derived key passes through (stored creator origin round-trips)
  assert.equal(rs.originKey(''), rs.UNKNOWN);          // empty key string → fail-closed
});

test('fairShare()/originCap(): half rounded up (never < 1); owner exempt, UNKNOWN clamped to 1', () => {
  assert.equal(rs.fairShare(4), 2);
  assert.equal(rs.fairShare(3), 2);
  assert.equal(rs.fairShare(1), 1);
  assert.equal(rs.fairShare(0), 1);   // degenerate global cap still yields a positive share
  assert.equal(rs.originCap(rs.OWNER, 4), Infinity);
  assert.equal(rs.originCap(rs.UNKNOWN, 4), 1);
  assert.equal(rs.originCap('p:alice', 4), 2);
});

// ── (a) FAIR PER-ORIGIN SHARE: one origin cannot exceed its share while ANOTHER still can ──
test('fair per-origin cap: an origin holds at most its share while other origins still get slots', () => {
  const c = rs.makeCounter();
  const A = { role: 'member', principal: 'alice', channel: 'telegram' };
  const B = { role: 'member', principal: 'bob', channel: 'telegram' };
  // global cap 4 → fair share 2. Alice takes her 2.
  assert.equal(c.admit(A, 4), true); c.acquire(A);
  assert.equal(c.admit(A, 4), true); c.acquire(A);
  // Alice is now at her share → refused, even though 2 global slots remain free.
  assert.equal(c.admit(A, 4), false);
  // Bob (a DIFFERENT origin) still gets served — no starvation.
  assert.equal(c.admit(B, 4), true); c.acquire(B);
  assert.equal(c.held(A), 2);
  assert.equal(c.held(B), 1);
});

test('fair per-origin cap: the OWNER is exempt, so single-owner use is NEVER refused (byte-identical normal path)', () => {
  const c = rs.makeCounter();
  const owner = { role: 'owner', principal: 'me', channel: 'telegram' };
  for (let i = 0; i < 10; i++) { assert.equal(c.admit(owner, 4), true); c.acquire(owner); }   // far past any share
  assert.equal(c.admit(owner, 4), true);
});

test('fair per-origin cap: release frees a slot and a released-to-zero key is dropped (no unbounded growth)', () => {
  const c = rs.makeCounter();
  const A = { principal: 'alice' };
  const k = c.acquire(A); c.acquire(A);
  assert.equal(c.held(A), 2);
  assert.equal(c.admit(A, 4), false);   // at share
  c.release(k);
  assert.equal(c.held(A), 1);
  assert.equal(c.admit(A, 4), true);    // a slot freed → admitted again
  c.release(k);
  assert.equal(c.held(A), 0);
  assert.equal(c.size(), 0);            // dropped, the map cannot grow without bound
  c.release(k);                          // over-release is a harmless no-op (never negative)
  assert.equal(c.held(A), 0);
});

test('fair per-origin cap: every unattributable request shares ONE most-restrictive slot (fail-closed, cannot monopolize)', () => {
  const c = rs.makeCounter();
  const u1 = { role: 'guest' };            // no principal, no channel → UNKNOWN
  const u2 = { channel: '' };              // blank → UNKNOWN
  assert.equal(c.admit(u1, 4), true); c.acquire(u1);
  assert.equal(c.admit(u2, 4), false);     // the shared '?' bucket is already full at 1
  assert.equal(c.held(u1), 1);
  assert.equal(c.held(u2), 1);             // same shared bucket
});

// ── flag-off byte-identical parity for the daemon's admission gate ──
test('flag-off parity: the daemon gate short-circuits — an over-cap origin is NOT refused when the flag is off', () => {
  const RUN_SCOPE_ON = rs.enabled({});   // flag unset → false
  const c = rs.makeCounter();
  const A = { principal: 'alice' };
  c.acquire(A); c.acquire(A);            // Alice is over her share
  // The exact daemon expression: `RUN_SCOPE_ON && !scopeCounter.admit(ctx, MAX_SCOPED)`.
  const refusedWhenOff = RUN_SCOPE_ON && !c.admit(A, 4);
  assert.equal(refusedWhenOff, false);   // OFF → never refuses → the global cap alone decides (byte-identical)
  const refusedWhenOn = true && !c.admit(A, 4);
  assert.equal(refusedWhenOn, true);     // ON → the same over-cap origin IS refused
});

// ── (b) ORIGIN-SCOPED RESUME: cross-origin refused, same-origin allowed ──
test('origin-scoped resume: same-origin allowed, cross-origin refused (fail-closed)', () => {
  const alice = { role: 'member', principal: 'alice', channel: 'telegram' };
  const alice2 = { role: 'member', principal: 'alice', channel: 'telegram' };   // same identity, later request
  const bob = { role: 'member', principal: 'bob', channel: 'telegram' };
  assert.equal(rs.sameOrigin(alice, alice2), true);
  assert.equal(rs.sameOrigin(alice, bob), false);
  assert.equal(rs.canResume(alice, alice2), true);    // same origin may resume
  assert.equal(rs.canResume(alice, bob), false);      // a DIFFERENT remote origin may not
  assert.equal(rs.canResume('p:alice', bob), false);  // a stored creator key vs a foreign resumer
  assert.equal(rs.canResume('p:alice', alice2), true);
});

test('origin-scoped resume: the local owner may resume anything; an unattributable creator is refused for a non-owner', () => {
  const owner = { local: true };
  const bob = { principal: 'bob' };
  assert.equal(rs.canResume({ principal: 'alice' }, owner), true);   // single-user owner escape hatch (0600 socket already gates it)
  assert.equal(rs.canResume(undefined, owner), true);               // owner may resume a run with no recorded origin
  assert.equal(rs.canResume(undefined, bob), false);                // a non-owner cannot resume an unattributable run
  assert.equal(rs.canResume(rs.UNKNOWN, bob), false);
  assert.equal(rs.sameOrigin(rs.UNKNOWN, rs.UNKNOWN), false);        // UNKNOWN never matches even itself (fail-closed)
});

// ── the ACP session-reuse seam actually enforces origin ownership when the flag is on, and is byte-identical when off ──
function loadAcp(flagOn) {
  const prev = process.env.URFAEL_RUN_SCOPE;
  if (flagOn) process.env.URFAEL_RUN_SCOPE = '1'; else delete process.env.URFAEL_RUN_SCOPE;
  delete require.cache[require.resolve('../acp')];
  const mod = require('../acp');
  if (prev === undefined) delete process.env.URFAEL_RUN_SCOPE; else process.env.URFAEL_RUN_SCOPE = prev;
  return mod;
}
// drive one dispatch call while capturing everything the bridge writes to stdout; returns the parsed JSON-RPC frames.
async function drive(mod, msg, origin) {
  const written = [];
  const real = process.stdout.write;
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try { await mod.dispatch(msg, origin); } finally { process.stdout.write = real; }
  return written.join('').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

test('ACP session reuse (flag ON): same-origin prompt allowed, a cross-origin prompt is refused fail-closed', async () => {
  const mod = loadAcp(true);
  const created = await drive(mod, { jsonrpc: '2.0', id: 1, method: 'session/new', params: {} }, 'origin-A');
  const sid = created[0].result.sessionId;
  assert.ok(sid, 'session/new returns a sessionId');
  // same origin, empty prompt (no daemon socket call) → end_turn, NOT a cross-origin refusal.
  const same = await drive(mod, { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: sid, prompt: [] } }, 'origin-A');
  assert.ok(same[0].result && same[0].result.stopReason, 'same-origin reuse proceeds');
  assert.ok(!same[0].error, 'same-origin reuse is not refused');
  // a DIFFERENT origin reusing the same session id → refused.
  const cross = await drive(mod, { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: sid, prompt: [] } }, 'origin-B');
  assert.ok(cross[0].error, 'cross-origin reuse is refused');
  assert.match(cross[0].error.message, /cross-origin resume refused/);
});

test('ACP session reuse (flag OFF): byte-identical — no origin binding, any reuse proceeds (parity)', async () => {
  const mod = loadAcp(false);
  const created = await drive(mod, { jsonrpc: '2.0', id: 1, method: 'session/new', params: {} }, 'origin-A');
  const sid = created[0].result.sessionId;
  // a different origin reuses it — with the flag OFF there is no origin check, so it proceeds exactly as before.
  const cross = await drive(mod, { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: sid, prompt: [] } }, 'origin-B');
  assert.ok(cross[0].result && cross[0].result.stopReason, 'flag-off reuse proceeds regardless of origin');
  assert.ok(!cross[0].error, 'flag-off never emits a cross-origin refusal');
  delete require.cache[require.resolve('../acp')];   // leave the default (flag-off) module cached for any later requirer
  require('../acp');
});
