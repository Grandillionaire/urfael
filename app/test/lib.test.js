'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyModel, segmentSentences, MODELS, resolveProfile, normalizeReminder, nextOccurrence } = require('../lib');

test('routing: code/dev → Opus', () => {
  for (const q of ['debug this python function', 'refactor the auth module', 'push my code to the repo', 'architect a caching layer'])
    assert.equal(classifyModel(q), MODELS.opus, q);
});

test('routing: chat/admin/writing → Sonnet', () => {
  for (const q of ['hey what is up', "what's on my calendar", 'draft an email to Alex', 'add a meeting tomorrow at 3pm'])
    assert.equal(classifyModel(q), MODELS.sonnet, q);
});

test('routing: "report" must not trip "repo"', () => {
  assert.equal(classifyModel('write a report on Q2'), MODELS.sonnet);
});

test('profile: local keeps full power (no tool allowlist, inherits permission mode)', () => {
  const p = resolveProfile('local');
  assert.equal(p.name, 'local');
  assert.equal(p.permissionMode, null);   // daemon applies PERM_MODE / URFAEL_YOLO
  assert.equal(p.allowedTools, null);      // no restriction
  assert.equal(p.trustFraming, false);
});

test('profile: untrusted is sandboxed (no bypass, READ-ONLY tools, framed)', () => {
  const p = resolveProfile('untrusted');
  assert.equal(p.name, 'untrusted');
  assert.equal(p.permissionMode, 'acceptEdits');     // never bypassPermissions
  assert.ok(Array.isArray(p.allowedTools) && p.allowedTools.length);
  // read-only, no network egress: exactly Read/Grep/Glob — no write, no shell, no web (exfil) tool
  assert.deepEqual([...p.allowedTools].sort(), ['Glob', 'Grep', 'Read']);
  for (const banned of ['Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'])
    assert.ok(!p.allowedTools.includes(banned), 'no ' + banned);
  assert.ok(!p.allowedTools.some((t) => /^Bash/.test(t)), 'no Bash at all (git can exec)');
  assert.equal(p.trustFraming, true);
});

test('profile: FAIL-CLOSED — unknown/empty/non-string channel resolves to untrusted, never local', () => {
  // strings that aren't exactly 'local'
  for (const name of ['telegram', 'discord', 'whatsapp', '', 'LOCAL', 'admin', undefined, null, 'local '])
    assert.equal(resolveProfile(name).name, 'untrusted', JSON.stringify(name));
  // type-coercion attacks: a non-string must NOT key-coerce its way to the local profile
  for (const name of [['local'], [['local']], { toString: () => 'local' }, 0, { name: 'local' }])
    assert.equal(resolveProfile(name).name, 'untrusted', JSON.stringify(name));
  // and every fail-closed result must carry the restricted controls (never local's nulls)
  for (const name of ['telegram', ['local'], { toString: () => 'local' }, undefined, 0]) {
    const p = resolveProfile(name);
    assert.notEqual(p.permissionMode, null, 'permMode set: ' + JSON.stringify(name));
    assert.ok(Array.isArray(p.allowedTools) && p.allowedTools.length, 'allowlist set: ' + JSON.stringify(name));
    assert.equal(p.trustFraming, true, 'framed: ' + JSON.stringify(name));
  }
});

test('segment: emits only complete sentences, keeps remainder', () => {
  const { sentences, rest } = segmentSentences('Hello there. How are you', false);
  assert.deepEqual(sentences, ['Hello there.']);
  assert.equal(rest, 'How are you');
});

test('segment: no premature break under the clause threshold', () => {
  const { sentences } = segmentSentences('a short clause with no terminator yet', false);
  assert.deepEqual(sentences, []);
});

test('segment: force flushes the trailing remainder', () => {
  const { sentences, rest } = segmentSentences('the final trailing bit', true);
  assert.deepEqual(sentences, ['the final trailing bit']);
  assert.equal(rest, '');
});

test('segment: multiple sentences in one buffer', () => {
  const { sentences } = segmentSentences('One. Two! Three? ', false);
  assert.deepEqual(sentences, ['One.', 'Two!', 'Three?']);
});

// ---- reminders ----
const NOW = Date.parse('2026-06-10T12:00:00Z');

test('reminder: inMins schedules relative to now', () => {
  const r = normalizeReminder({ text: 'call Stefan', inMins: 20 }, NOW);
  assert.equal(r.at, NOW + 20 * 60000);
  assert.equal(r.text, 'call Stefan');
  assert.equal(r.repeat, null);
});

test('reminder: absolute at (ISO) accepted', () => {
  const r = normalizeReminder({ text: 'standup', at: '2026-06-10T15:00:00Z' }, NOW);
  assert.equal(r.at, Date.parse('2026-06-10T15:00:00Z'));
});

test('reminder: fail-closed on garbage', () => {
  for (const bad of [null, 'x', [], { text: 'no time' }, { inMins: 5 }, { text: '', inMins: 5 },
    { text: 'bad date', at: 'not-a-date' }, { text: 'neg', inMins: NaN }])
    assert.equal(normalizeReminder(bad, NOW), null, JSON.stringify(bad));
});

test('reminder: one-shot in the past rejected; repeating in the past allowed (rolls forward)', () => {
  assert.equal(normalizeReminder({ text: 'late', at: '2026-06-10T10:00:00Z' }, NOW), null);
  const r = normalizeReminder({ text: 'daily', at: '2026-06-10T08:00:00Z', repeat: 'daily' }, NOW);
  assert.ok(r && r.repeat === 'daily');
  assert.ok(nextOccurrence(r, NOW));
  assert.ok(r.at > NOW && r.at <= NOW + 86400000);
});

test('reminder: bounds clamped — max 1y out, everyMins floored to 5', () => {
  assert.equal(normalizeReminder({ text: 'far', at: '2031-01-01T00:00:00Z' }, NOW), null);
  const r = normalizeReminder({ text: 'spam', inMins: 1, repeat: { everyMins: 1 } }, NOW);
  assert.equal(r.repeat.everyMins, 5);
});

test('reminder: nextOccurrence advances repeats past now, false for one-shots', () => {
  const one = { at: NOW - 1000, repeat: null };
  assert.equal(nextOccurrence(one, NOW), false);
  const wk = { at: NOW - 1000, repeat: 'weekly' };
  assert.ok(nextOccurrence(wk, NOW));
  assert.ok(wk.at > NOW && wk.at <= NOW + 604800000);
  const ev = { at: NOW - 10 * 3600000, repeat: { everyMins: 60 } };
  assert.ok(nextOccurrence(ev, NOW));
  assert.ok(ev.at > NOW && ev.at <= NOW + 3600000);
});
