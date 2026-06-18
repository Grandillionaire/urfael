'use strict';
// Tests for the terminal-craft helpers: did-you-mean (editDistance + suggestCommand) and the status sparkline.
const { test } = require('node:test');
const assert = require('node:assert');
const { editDistance, suggestCommand, sparkline } = require('../lib');

const COMMANDS = ['status', 'doctor', 'help', 'why', 'forget', 'seal', 'logo', 'setup', 'drift', 'learn', 'jobs', 'job', 'team', 'audit', 'cron', 'hook', 'tui', 'health', 'serve'];

test('editDistance: identical / empty / single edits', () => {
  assert.equal(editDistance('status', 'status'), 0);
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('abc', ''), 3);
  assert.equal(editDistance('staus', 'status'), 1);   // one insertion
  assert.equal(editDistance('statuz', 'status'), 1);  // one substitution
});

test('editDistance: an adjacent transposition counts as ONE mistake (OSA), like a human reads it', () => {
  assert.equal(editDistance('stauts', 'status'), 1);  // ut→tu swap
  assert.equal(editDistance('hlep', 'help'), 1);      // le→el swap
});

test('suggestCommand: catches obvious one-mistake typos', () => {
  assert.equal(suggestCommand('stauts', COMMANDS), 'status');
  assert.equal(suggestCommand('staus', COMMANDS), 'status');
  assert.equal(suggestCommand('doctr', COMMANDS), 'doctor');
  assert.equal(suggestCommand('aduit', COMMANDS), 'audit');
  assert.equal(suggestCommand('helo', COMMANDS), 'help');
  assert.equal(suggestCommand('sel', COMMANDS), 'seal');
});

test('suggestCommand: real one-word QUESTIONS still reach the brain (no false hijack)', () => {
  // "hello"→"help" is TWO edits, so it must NOT be intercepted; bare greetings/questions pass through.
  for (const w of ['hello', 'weather', 'hi', 'ok', 'thanks', 'yes', 'remind']) // 'remind' is itself a command-ish word but ≥2 from any single cmd here
    assert.equal(suggestCommand(w, COMMANDS), '', w);
});

test('suggestCommand: an exact command is never flagged as a typo', () => {
  for (const c of COMMANDS) assert.equal(suggestCommand(c, COMMANDS), '');
});

test('suggestCommand: too-short / non-alpha tokens are ignored (they are not command-shaped)', () => {
  assert.equal(suggestCommand('a', COMMANDS), '');
  assert.equal(suggestCommand('wy', COMMANDS), '');   // 2 letters — below the floor
  assert.equal(suggestCommand('3pm', COMMANDS), '');
  assert.equal(suggestCommand('', COMMANDS), '');
});

test('sparkline: all-zero series is a flat floor; a ramp climbs; length is preserved', () => {
  assert.equal(sparkline([0, 0, 0, 0, 0, 0, 0]), '▁▁▁▁▁▁▁');
  assert.equal(sparkline([]).length, 0);
  const ramp = sparkline([0, 1, 2, 4, 8, 16, 32]);
  assert.equal(ramp.length, 7);
  assert.equal(ramp[0], '▁');          // min maps to the floor
  assert.equal(ramp[ramp.length - 1], '▇'); // max maps to the ceiling
  // monotonic non-decreasing for a non-decreasing input
  for (let i = 1; i < ramp.length; i++) assert.ok(ramp.codePointAt(i) >= ramp.codePointAt(i - 1));
});

test('sparkline: negatives are floored to zero, never throw', () => {
  assert.doesNotThrow(() => sparkline([-5, 3, -1]));
  assert.equal(sparkline([-5, -5, -5]), '▁▁▁');
});
