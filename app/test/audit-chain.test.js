'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const chain = require('../audit-chain');

// build a known-good chain of N entries
function buildChain(payloads) {
  const lines = []; let prevH = chain.GENESIS;
  payloads.forEach((p, i) => {
    const e = chain.makeEntry({ seq: i, t: '2026-06-16T00:00:0' + i, kind: p.kind, payload: p.payload }, prevH);
    lines.push(JSON.stringify(e)); prevH = e.h;
  });
  return lines;
}
const GOOD = buildChain([
  { kind: 'turn', payload: { model: 'sonnet', in: 10, out: 20 } },
  { kind: 'remote_turn', payload: { channel: 'telegram', principal: 'sam', role: 'guest' } },
  { kind: 'cron_fire', payload: { id: 'c1', deliver: 'notify' } },
  { kind: 'learn_verify', payload: { trusted: 1, rejected: 0 } },
]);

test('chain: a valid chain verifies clean through the last seq', () => {
  const r = chain.verify(GOOD);
  assert.equal(r.ok, true);
  assert.equal(r.through, 3);
  assert.equal(r.count, 4);
  assert.match(r.head, /^[0-9a-f]{64}$/);
});

test('chain: canonicalJSON is key-order-independent (so payload order cannot change a digest)', () => {
  assert.equal(chain.canonicalJSON({ a: 1, b: 2 }), chain.canonicalJSON({ b: 2, a: 1 }));
  assert.equal(chain.digest(chain.canonicalJSON({ x: [1, 2], y: 'q' })), chain.digest(chain.canonicalJSON({ y: 'q', x: [1, 2] })));
  assert.notEqual(chain.canonicalJSON({ a: [1, 2] }), chain.canonicalJSON({ a: [2, 1] })); // arrays keep order
});

test('chain: a flipped byte in a payload digest breaks exactly that link', () => {
  const t = GOOD.slice();
  const e = JSON.parse(t[2]); e.payloadDigest = e.payloadDigest.replace(/.$/, (c) => c === 'a' ? 'b' : 'a'); t[2] = JSON.stringify(e);
  const r = chain.verify(t);
  assert.equal(r.ok, false);
  assert.equal(r.brokenSeq, 2);
  assert.equal(r.brokenLine, 3);
  assert.equal(r.reason, 'hash_mismatch');
});

test('chain: a DELETED entry is detected (seq gap)', () => {
  const t = [GOOD[0], GOOD[1], GOOD[3]]; // dropped seq 2
  const r = chain.verify(t);
  assert.equal(r.ok, false);
  assert.equal(r.brokenSeq, 2);          // the 3rd line now claims seq 3
  assert.equal(r.reason, 'seq_gap');
});

test('chain: a REORDERED pair is detected', () => {
  const t = [GOOD[0], GOOD[2], GOOD[1], GOOD[3]]; // swap seq 1 and 2
  const r = chain.verify(t);
  assert.equal(r.ok, false);
  assert.ok(r.brokenSeq >= 1 && !r.ok);
});

test('chain: a tampered timestamp breaks the link (content is committed)', () => {
  const t = GOOD.slice();
  const e = JSON.parse(t[1]); e.t = '2099-01-01T00:00:00'; t[1] = JSON.stringify(e);
  const r = chain.verify(t);
  assert.equal(r.ok, false);
  assert.equal(r.brokenSeq, 1);
  assert.equal(r.reason, 'hash_mismatch');
});

test('chain: garbage / empty inputs are fail-closed, never throw', () => {
  assert.equal(chain.verify([]).ok, true);                 // empty chain is trivially intact
  assert.equal(chain.verify(['{not json']).ok, false);
  assert.equal(chain.verify('nope').ok, false);
  assert.equal(chain.verify(null).ok, false);
});
