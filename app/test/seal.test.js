'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const seal = require('../seal');

test('seal: a valid signature verifies; a tampered message or wrong key does NOT', () => {
  const kp = seal.generateKeypair();
  assert.match(kp.publicPem, /BEGIN PUBLIC KEY/);
  assert.match(kp.privatePem, /BEGIN PRIVATE KEY/);
  const msg = seal.sealMessage({ chainHead: 'a'.repeat(64), seq: 42, t: '2026-06-16T00:00:00Z', fp: 'deadbeefdeadbeef' });
  const sig = seal.sign(kp.privatePem, msg);
  assert.equal(seal.verify(kp.publicPem, msg, sig), true);                          // right key + right message
  assert.equal(seal.verify(kp.publicPem, msg + 'x', sig), false);                   // message tampered
  const sb = Buffer.from(sig, 'base64'); sb[10] = sb[10] ^ 0xff;                     // flip a real signature byte
  assert.equal(seal.verify(kp.publicPem, msg, sb.toString('base64')), false);       // sig tampered
  const other = seal.generateKeypair();
  assert.equal(seal.verify(other.publicPem, msg, sig), false);                      // wrong key
});

test('seal: fingerprint is a stable 16-hex id derived from the public key', () => {
  const kp = seal.generateKeypair();
  const fp = seal.fingerprint(kp.publicPem);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(seal.fingerprint(kp.publicPem), fp);                                 // stable
  assert.notEqual(seal.fingerprint(seal.generateKeypair().publicPem), fp);          // distinct per key
  assert.equal(seal.fingerprint('not a key'), '');                                  // fail-closed
});

test('seal: a signature is bound to its chainHead/seq — can\'t be replayed onto a different head', () => {
  const kp = seal.generateKeypair();
  const m1 = seal.sealMessage({ chainHead: 'a'.repeat(64), seq: 1, t: 'T', fp: 'f' });
  const m2 = seal.sealMessage({ chainHead: 'b'.repeat(64), seq: 1, t: 'T', fp: 'f' });
  const sig1 = seal.sign(kp.privatePem, m1);
  assert.equal(seal.verify(kp.publicPem, m1, sig1), true);
  assert.equal(seal.verify(kp.publicPem, m2, sig1), false);                         // a different head won't verify with m1's sig
});

test('seal: verify never throws on garbage', () => {
  for (const args of [[null, 'm', 's'], ['', '', ''], ['notpem', 'm', 'sig'], [undefined, undefined, undefined]])
    assert.equal(seal.verify(...args), false, JSON.stringify(args));
});
