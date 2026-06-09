'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyModel, segmentSentences, MODELS, resolveProfile } = require('../lib');

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
  assert.equal(p.permissionMode, null);   // daemon applies PERM_MODE / JARVIS_YOLO
  assert.equal(p.allowedTools, null);      // no restriction
  assert.equal(p.trustFraming, false);
});

test('profile: untrusted is sandboxed (no bypass, restricted tools, framed)', () => {
  const p = resolveProfile('untrusted');
  assert.equal(p.name, 'untrusted');
  assert.equal(p.permissionMode, 'acceptEdits');     // never bypassPermissions
  assert.ok(Array.isArray(p.allowedTools) && p.allowedTools.length);
  assert.ok(!p.allowedTools.includes('Bash'), 'no unrestricted Bash');
  assert.ok(!p.allowedTools.some((t) => t === 'Bash(*)' || /Bash\((?!git:)/.test(t)), 'only git Bash');
  assert.equal(p.trustFraming, true);
});

test('profile: FAIL-CLOSED — unknown/empty channel resolves to untrusted, never local', () => {
  for (const name of ['telegram', 'discord', 'whatsapp', '', 'LOCAL', 'admin', undefined, null, 'local '])
    assert.equal(resolveProfile(name).name, 'untrusted', JSON.stringify(name));
  // and the fail-closed result must never carry local's full power
  for (const name of ['telegram', 'nonsense', undefined])
    assert.notEqual(resolveProfile(name).permissionMode, null, JSON.stringify(name));
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
