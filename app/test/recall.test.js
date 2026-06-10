'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { rank, tokenize } = require('../recall');

// helper: build an archive entry with a sortable timestamp.
function ent(t, user, urfael) { return { t, channel: 'local', user, urfael }; }

test('tokenizer: lowercase alnum, drops punctuation', () => {
  assert.deepEqual(tokenize("Push my Code, NOW! v2.0"), ['push', 'my', 'code', 'now', 'v2', '0']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});

test('exact term ranks above partial/unrelated', () => {
  const entries = [
    ent('2026-06-01T10:00:00', 'tell me about the kubernetes deployment', 'here is the kubernetes deployment plan'),
    ent('2026-06-02T10:00:00', 'what is for lunch today', 'pasta'),
    ent('2026-06-03T10:00:00', 'a passing mention of kube somewhere', 'nothing relevant here'),
  ];
  const out = rank(entries, 'kubernetes', 5);
  assert.equal(out[0].user, 'tell me about the kubernetes deployment'); // exact term wins
  assert.ok(out[0].score > 0);
  // the lunch turn has no query term at all -> excluded entirely
  assert.ok(!out.some((e) => e.user === 'what is for lunch today'));
});

test('multi-term: a doc with MORE query terms ranks above a doc with fewer', () => {
  const entries = [
    ent('2026-06-01T10:00:00', 'the gold serif runic identity of the orb', 'gold and serif and runic together'),
    ent('2026-06-02T10:00:00', 'gold mining in the mountains', 'just gold here'),
  ];
  const out = rank(entries, 'gold serif runic', 5);
  assert.equal(out[0].user, 'the gold serif runic identity of the orb');
});

test('recency tiebreak: identical text -> newer .t first', () => {
  const entries = [
    ent('2026-06-01T10:00:00', 'deploy the daemon', 'done'),
    ent('2026-06-05T10:00:00', 'deploy the daemon', 'done'),
    ent('2026-06-03T10:00:00', 'deploy the daemon', 'done'),
  ];
  const out = rank(entries, 'deploy daemon', 10);
  assert.deepEqual(out.map((e) => e.t), ['2026-06-05T10:00:00', '2026-06-03T10:00:00', '2026-06-01T10:00:00']);
});

test('[SPOKEN] tags are stripped before ranking (matches reply body, not the tag)', () => {
  const entries = [
    ent('2026-06-01T10:00:00', 'status?', '[SPOKEN]all good[/SPOKEN] the telemetry pipeline is healthy'),
  ];
  // the word inside the reply body is searchable; the tag text itself is not a term that breaks things
  const out = rank(entries, 'telemetry', 5);
  assert.equal(out.length, 1);
  assert.ok(out[0].score > 0);
});

test('empty query returns []', () => {
  const entries = [ent('2026-06-01T10:00:00', 'hello', 'hi')];
  assert.deepEqual(rank(entries, '', 5), []);
  assert.deepEqual(rank(entries, '   ', 5), []);
  assert.deepEqual(rank(entries, '!!!', 5), []); // no alnum tokens
});

test('empty corpus returns []', () => {
  assert.deepEqual(rank([], 'anything', 5), []);
  assert.deepEqual(rank(null, 'anything', 5), []);
});

test('no matches returns [] (every query term absent from corpus)', () => {
  const entries = [ent('2026-06-01T10:00:00', 'apples', 'oranges')];
  assert.deepEqual(rank(entries, 'zebra', 5), []);
});

test('k clamps: caps the number of results, never below 1 of available', () => {
  const entries = [];
  for (let i = 0; i < 10; i++) entries.push(ent('2026-06-0' + (i % 9 + 1) + 'T10:00:00', 'gold ' + i, 'gold reply ' + i));
  assert.equal(rank(entries, 'gold', 3).length, 3);   // clamp down to k
  assert.equal(rank(entries, 'gold', 0).length, 1);   // k<1 -> at least 1
  assert.equal(rank(entries, 'gold', 999).length, 10); // k>available -> all matches
  assert.equal(rank(entries, 'gold', 'x').length, 1); // non-numeric k -> at least 1
});

test('score is attached and strictly descending', () => {
  const entries = [
    ent('2026-06-01T10:00:00', 'gold gold gold serif runic', 'gold serif runic'),
    ent('2026-06-02T10:00:00', 'a single gold mention', 'plain'),
  ];
  const out = rank(entries, 'gold serif runic', 5);
  for (const e of out) assert.equal(typeof e.score, 'number');
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].score >= out[i].score);
});
