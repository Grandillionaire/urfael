'use strict';
// Tests for the `urfael why` provenance-card renderer. Pure: identity colour fns → assert on plain text.
const { test } = require('node:test');
const assert = require('node:assert');
const { passName, fullDate, card } = require('../provenance');

const ID = { gold: (s) => s, dim: (s) => s };

test('passName: maps known commit prefixes to a human pass name', () => {
  assert.equal(passName('memory: distilled 3 facts'), 'distilled');
  assert.equal(passName('user-model: revised tone'), 'user-model');
  assert.equal(passName('forget: 2 line(s)'), 'forgotten');
  assert.equal(passName('init: seed'), 'seeded');
  assert.equal(passName('learn: promoted'), 'learned');
});

test('passName: unknown prefix falls back to the prefix; no prefix → "memory"; never throws', () => {
  assert.equal(passName('weird: thing'), 'weird');
  assert.equal(passName('no colon here'), 'memory');
  assert.equal(passName(''), 'memory');
  assert.equal(passName(null), 'memory');
});

test('fullDate: reformats a git %ci date to "10 June 2026" without leaking present time', () => {
  assert.equal(fullDate('2026-06-10 19:22:16 +0200'), '10 June 2026');
  assert.equal(fullDate('2026-01-01 00:00:00 +0000'), '1 January 2026');
  assert.equal(fullDate('2026-12-31 23:59:59 -0800'), '31 December 2026');
});

test('fullDate: malformed input falls back to the first 10 chars, never throws', () => {
  assert.equal(fullDate('not-a-date!!'), 'not-a-date');  // no YYYY-MM-DD match → first 10 chars
  assert.equal(fullDate(''), '');
  assert.doesNotThrow(() => fullDate(undefined));
});

test('card: renders a sourced citation per row with the SHA preserved', () => {
  const rows = [
    { sha: 'a1b2c3d', ci: '2026-06-10 19:22:16 +0200', subject: 'memory: distilled 3 facts' },
    { sha: 'e4f5g6h', ci: '2026-05-01 08:00:00 +0200', subject: 'user-model: first contact' },
  ];
  const out = card('I prefer execution over questions', rows, ID);
  assert.match(out, /Why I believe/);
  assert.match(out, /2 sources, newest first/);
  assert.match(out, /distilled on 10 June 2026/);
  assert.match(out, /user-model on 1 May 2026/);
  assert.match(out, /a1b2c3d/);          // SHA stays checkable
  assert.match(out, /git show e4f5g6h/); // paste-ready
});

test('card: singular "source" for a single row', () => {
  const out = card('x', [{ sha: 'deadbee', ci: '2026-06-01 00:00:00 +0000', subject: 'init: seed' }], ID);
  assert.match(out, /1 source, newest first/);
  assert.match(out, /seeded on 1 June 2026/);
});
