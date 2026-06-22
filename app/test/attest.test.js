'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const at = require('../attest');

test('buildReport assembles the bundle with the honest scope attached', () => {
  const r = at.buildReport({ subject: 'host (Urfael)', ledger: { verified: true, count: 3, through: 2, head: 'abc123' },
    seal: { present: true, valid: true, fp: 'k1', seq: 2, headStillInChain: true }, posture: { noInboundPort: true } }, '2026-06-22T10:00:00Z');
  assert.equal(r.kind, 'urfael-attestation');
  assert.equal(r.version, 1);
  assert.equal(r.subject, 'host (Urfael)');
  assert.ok(Array.isArray(r.scope.proves) && r.scope.proves.length >= 3);
  assert.ok(Array.isArray(r.scope.doesNotProve) && r.scope.doesNotProve.length >= 2);
});

test('verdict reflects ledger + seal state', () => {
  assert.equal(at.verdict({ ledger: { verified: true }, seal: { present: true, valid: true, headStillInChain: true } }), 'ATTESTED');
  assert.equal(at.verdict({ ledger: { verified: true }, seal: { present: false } }), 'LEDGER INTACT (unsealed)');
  assert.equal(at.verdict({ ledger: { verified: false }, seal: { present: true, valid: true } }), 'NOT ATTESTED');
  assert.equal(at.verdict({ ledger: { verified: true }, seal: { present: true, valid: false } }), 'NOT ATTESTED');
  // a re-sealed-below-the-seal tamper is NOT attested even if both verify in isolation
  assert.equal(at.verdict({ ledger: { verified: true }, seal: { present: true, valid: true, headStillInChain: false } }), 'NOT ATTESTED');
});

test('fingerprint is deterministic and content-sensitive', () => {
  const a = at.buildReport({ ledger: { verified: true } }, '2026-06-22T10:00:00Z');
  const b = at.buildReport({ ledger: { verified: true } }, '2026-06-22T10:00:00Z');
  const c = at.buildReport({ ledger: { verified: false } }, '2026-06-22T10:00:00Z');
  assert.equal(at.fingerprint(a), at.fingerprint(b));
  assert.notEqual(at.fingerprint(a), at.fingerprint(c));
  assert.match(at.fingerprint(a), /^[0-9a-f]{64}$/);
});

test('render states what it proves AND what it does not, and never overclaims', () => {
  const r = at.buildReport({ subject: 'host (Urfael)', ledger: { verified: true, count: 5, through: 4, head: 'deadbeefcafef00d' },
    seal: { present: true, valid: true, fp: 'k9', seq: 4, headStillInChain: true }, posture: { noInboundPort: true, mode: 'Fortress' } }, '2026-06-22T10:00:00Z');
  const txt = at.render(r);
  assert.match(txt, /URFAEL ATTESTATION  ATTESTED/);
  assert.match(txt, /Ledger of Record/);
  assert.match(txt, /Sovereign Seal/);
  assert.match(txt, /What this proves/);
  assert.match(txt, /What this deliberately does NOT prove/);
  // the honesty guardrail: the report must NOT use absolute-guarantee language a researcher could break
  for (const banned of [/\bimpossible\b/i, /guarantee that nothing/i, /can never leave/i, /cannot be hacked/i, /100% secure/i, /unhackable/i]) {
    assert.ok(!banned.test(txt), 'attestation must not overclaim: matched ' + banned);
  }
});

test('render does not claim the chain re-check passed when it could not run', () => {
  const r = at.buildReport({ ledger: { verified: true }, seal: { present: true, valid: true, fp: 'k', seq: 1, headStillInChain: null } }, '2026-06-22T10:00:00Z');
  const txt = at.render(r);
  assert.match(txt, /chain-prefix re-check unavailable/);
  assert.ok(!/sealed head still matches/.test(txt), 'must not claim the head matched when the re-check was unavailable');
});
