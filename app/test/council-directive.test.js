'use strict';
// Tests for natural-language SYNTHETIC-BRAIN switching (lib.parseCouncilDirective). Same hard part as the model/
// persona directives: catch every way a person asks to convene / dismiss / report the read-only Council brain, but
// NEVER hijack a real task that merely mentions a council, an ensemble, mixture-of-agents, or "moa" in a word.
// (This directive is only ever CONSULTED on a MoA-enabled install; here we test the pure parser in isolation.)
const { test } = require('node:test');
const assert = require('node:assert');
const { parseCouncilDirective: p } = require('../lib');

test('convenes the council (enable) from many natural phrasings — >=8', () => {
  for (const s of ['convene the council', 'council mode', 'use the council', 'use the council as my brain',
                   'use mixture of agents', 'use moa', 'switch to moa', 'ensemble mode',
                   'moa mode', 'enable council', 'activate the council', 'convene the council please',
                   'switch to the council', 'assemble the council', 'use mixture-of-agents'])
    assert.deepEqual(p(s), { action: 'brain', mode: 'council' }, s);
});

test('dismisses the council (disable) from many natural phrasings — >=5', () => {
  for (const s of ['single brain', 'solo', 'just you', 'leave the council', 'dismiss the council',
                   'default brain', 'disband the council', 'just yourself', 'solo mode', 'back to the solo brain'])
    assert.deepEqual(p(s), { action: 'brain', mode: 'default' }, s);
});

test('reports the current brain on a status question', () => {
  for (const s of ['which brain am i on', 'what brain are you on', 'which is the current brain',
                   'what brain are we on', 'which brain am i using'])
    assert.deepEqual(p(s), { action: 'brain-status' }, s);
});

test('NEVER hijacks a real task that merely mentions a council / ensemble / moa', () => {
  for (const s of ['summarize the council meeting notes', 'what is a mixture of agents', 'book the council chamber',
                   'the town council voted', 'the moabite kingdom', 'ensemble cast of the film',
                   'draft an email to the city council', 'explain how a mixture of experts works',
                   'the string quartet is an ensemble', 'moat defense in castles', 'councilman smith resigned',
                   'what are the council estate rules', 'is solo travel safe', 'just you and me then', ''])
    assert.equal(p(s), null, s);
});

test('is length-capped like its siblings (a long message is a real task, not a directive)', () => {
  assert.equal(p('please could you convene the council for me and then also do a bunch of other things'), null);
  assert.equal(p('x'.repeat(65)), null);
});

test('strips leading/trailing filler and trailing punctuation', () => {
  assert.deepEqual(p('hey, council mode please!'), { action: 'brain', mode: 'council' });
  assert.deepEqual(p('ok switch to moa from now on'), { action: 'brain', mode: 'council' });
  assert.deepEqual(p('urfael, single brain thanks'), { action: 'brain', mode: 'default' });
});

test('is pure + total: returns null or a well-shaped object, never throws', () => {
  for (const v of [null, undefined, 0, 42, {}, [], true, 'COUNCIL MODE', '  ']) {
    const r = p(v);
    assert.ok(r === null || (r && typeof r === 'object' && typeof r.action === 'string'), JSON.stringify(v));
    if (r && r.action === 'brain') assert.ok(r.mode === 'council' || r.mode === 'default');
  }
});
