'use strict';
// Tests for natural-language model switching (lib.parseModelDirective). The hard part is precision:
// catch every way a person asks to switch, but NEVER hijack a real task that merely mentions a model.
const { test } = require('node:test');
const assert = require('node:assert');
const { parseModelDirective: p } = require('../lib');

test('pins Opus from many natural phrasings', () => {
  for (const s of ['switch to opus', 'use opus', 'go opus', 'switch me to opus please', 'make it opus',
                   'opus', 'use the powerful model', 'switch to the big model', 'give me the smartest one',
                   'talk to me with opus', 'change the model to opus', 'set model to opus', 'go with opus'])
    assert.deepEqual(p(s), { action: 'pin', model: 'opus' }, s);
});

test('pins Sonnet from many natural phrasings', () => {
  for (const s of ['switch to sonnet', 'use sonnet', 'use the fast model', 'go with the quick one',
                   'sonnet please', 'use the cheaper model', 'switch to the light model', 'sonnet'])
    assert.deepEqual(p(s), { action: 'pin', model: 'sonnet' }, s);
});

test('restores auto-routing / unpins', () => {
  for (const s of ['go back to auto', 'back to automatic', 'use auto-routing', 'stop pinning the model',
                   'unpin', 'you decide the model', 'pick the model yourself', 'automatic', 'auto'])
    assert.deepEqual(p(s), { action: 'auto' }, s);
});

test('reports the current model on a status question', () => {
  for (const s of ['what model are you using', 'which model is this', 'what model are you on',
                   'what model', 'whats the current model', 'which model are we on'])
    assert.deepEqual(p(s), { action: 'status' }, s);
});

test('does NOT hijack a real task that merely mentions a model', () => {
  for (const s of ['write a poem about opus the penguin', 'use opus to summarise this thread',
                   'what model should i use for coding', 'is sonnet good at code', 'you pick the restaurant',
                   'switch the lights to bright', 'summarise the sonnet by shakespeare', 'how fast is the fast model',
                   'tell me about your models', 'go to the store', 'set a reminder', 'use markdown please',
                   'what is the best approach', ''])
    assert.equal(p(s), null, s);
});

test('strips leading/trailing filler and trailing punctuation', () => {
  assert.deepEqual(p('hey, switch to opus please!'), { action: 'pin', model: 'opus' });
  assert.deepEqual(p('ok use sonnet from now on'), { action: 'pin', model: 'sonnet' });
  assert.deepEqual(p('could you go back to auto, thanks'), { action: 'auto' });
});

test('case-insensitive; ignores an over-long message (a real task, not a directive)', () => {
  assert.deepEqual(p('SWITCH TO OPUS'), { action: 'pin', model: 'opus' });
  assert.equal(p('use opus and then write me a very long detailed essay about the history of jazz music'), null);
});
