'use strict';
// Tests for natural-language persona switching (lib.parsePersonaDirective). Like the model directive, the
// hard part is precision: catch every way a person asks to change voice, never hijack a real task.
const { test } = require('node:test');
const assert = require('node:assert');
const { parsePersonaDirective } = require('../lib');
const IDS = ['urfael', 'architect', 'sage', 'operator', 'muse', 'analyst'];
const p = (s) => parsePersonaDirective(s, IDS);

test('SET a built-in persona from many phrasings', () => {
  const cases = { architect: 'architect', 'be the architect': 'architect', 'become the sage': 'sage',
    'switch to the operator': 'operator', 'act as the muse': 'muse', 'speak as the analyst': 'analyst',
    'the analyst voice': 'analyst', 'use the architect persona': 'architect', 'put on the operator hat': 'operator',
    'talk like the sage': 'sage', 'channel the muse': 'muse', 'give me the analyst': 'analyst', 'the operator': 'operator',
    'hey, become the architect please': 'architect', 'wear the sage hat': 'sage' };
  for (const [s, id] of Object.entries(cases)) assert.deepEqual(p(s), { action: 'set', id }, s);
});

test('RESET to the anchor (urfael)', () => {
  for (const s of ['back to urfael', 'go back to normal', 'be yourself', 'reset the persona', 'drop the persona',
                   'just be urfael', 'back to default', 'clear the voice', 'stop the persona', 'be the butler'])
    assert.deepEqual(p(s), { action: 'reset' }, s);
});

test('LIST the roster', () => {
  for (const s of ['list personas', 'show me the personas', 'what personas do you have',
                   'which personas can i use', 'persona list', 'name the personas'])
    assert.deepEqual(p(s), { action: 'list' }, s);
});

test('STATUS — which persona am I', () => {
  for (const s of ['what persona are you', 'which persona is this', 'what persona am i using',
                   'whats the current persona', 'which voice are you using', 'what stance are you on'])
    assert.deepEqual(p(s), { action: 'status' }, s);
});

test('NEVER hijacks a real task that merely mentions a persona word', () => {
  for (const s of ['analyze this for me', 'muse on the meaning of life', 'is the operator pattern good here',
                   'write a sage piece of advice', 'the architect designed a great building', 'i need an operator for the crane',
                   'draft an email to the analyst', 'who is the architect of this plan', 'use opus', 'switch to opus',
                   'be nice', 'summarize this', 'tell me about your personas and how each of them actually works in detail', ''])
    assert.equal(p(s), null, s);
});

test('an AUTHORED id is switchable by name; an unknown id falls through to null', () => {
  assert.deepEqual(parsePersonaDirective('become the pirate', [...IDS, 'pirate']), { action: 'set', id: 'pirate' });
  assert.equal(parsePersonaDirective('become the pirate', IDS), null);   // not in the roster → not a directive
});
