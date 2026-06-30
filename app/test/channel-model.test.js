'use strict';
// PER-PRINCIPAL MODEL CAP — an owner-set ceiling on auto-routing, so a member/guest can never burn the expensive
// tier on a cost-DoS prompt. The cap can only LOWER classifyModel's choice, never raise it, and is opt-in: with no
// cap the behaviour is byte-identical to today. Pure, no I/O.
const { test } = require('node:test');
const assert = require('node:assert');
const { normPinModel, capModel, buildRoster, resolvePrincipal, addPrincipal, classifyModel, MODELS } = require('../lib');

// (1) normPinModel: ONLY the two real tiers, case-insensitively; everything sender-shaped → null.
test('cap: normPinModel accepts only opus/sonnet (case-insensitive); rejects junk + sender-shaped values', () => {
  assert.equal(normPinModel('opus'), 'opus');
  assert.equal(normPinModel('sonnet'), 'sonnet');
  assert.equal(normPinModel('OPUS'), 'opus');
  assert.equal(normPinModel(' Sonnet '), 'sonnet');
  for (const junk of ['', null, undefined, 0, 42, {}, [], ['opus'], 'haiku', 'gpt-5', 'opus; rm -rf', 'claude-opus-4-8', true])
    assert.equal(normPinModel(junk), null, JSON.stringify(junk));
});

// (2) buildRoster carries a valid cap and DROPS an invalid one; both entries still parse + apply.
test('cap: buildRoster carries a valid model cap and silently drops an invalid one (fail-soft)', () => {
  const r = buildRoster({ telegram: [{ id: '1', role: 'member', model: 'sonnet' }, { id: '2', role: 'member', model: 'haiku' }] }, {});
  assert.equal(r.telegram[0].model, 'sonnet');
  assert.equal(r.telegram[1].model, undefined, 'an invalid tier is dropped, not stored');
  assert.equal(r.telegram[0].role, 'member');
  assert.equal(r.telegram[1].role, 'member');
  // self-documenting `maxModel` key works too, and rosters with NO cap stay byte-identical (no model key)
  const m = buildRoster({ telegram: [{ id: '3', role: 'guest', maxModel: 'opus' }, { id: '4', role: 'guest' }] }, {});
  assert.equal(m.telegram[0].model, 'opus');
  assert.deepEqual(m.telegram[1], { id: '4', name: '4', role: 'guest' });
});

// (3) resolvePrincipal surfaces the validated cap; a roster without it is backward-compatible (undefined).
test('cap: resolvePrincipal surfaces the cap; absent cap → principal.model is undefined (backward compatible)', () => {
  const withCap = { telegram: [{ id: '1', role: 'member', model: 'sonnet' }] };
  assert.equal(resolvePrincipal(withCap, 'telegram', '1').model, 'sonnet');
  const noCap = { telegram: [{ id: '1', role: 'member' }] };
  assert.equal(resolvePrincipal(noCap, 'telegram', '1').model, undefined);
  assert.deepEqual(resolvePrincipal(noCap, 'telegram', '1'), { id: '1', name: '1', role: 'member' }, 'shape preserved when uncapped');
});

// (4) addPrincipal accepts a valid cap (canonical maxModel key) and strips an invalid one.
test('cap: addPrincipal stores a valid maxModel and strips an invalid one', () => {
  let { team, error } = addPrincipal({}, 'telegram', { id: '1', name: 'Sam', role: 'member', maxModel: 'sonnet' });
  assert.equal(error, null);
  assert.deepEqual(team.telegram[0], { id: '1', name: 'Sam', role: 'member', maxModel: 'sonnet' });
  // alias `model` is accepted; junk is stripped (no key written)
  ({ team } = addPrincipal(team, 'telegram', { id: '2', name: 'Lee', role: 'guest', model: 'opus' }));
  assert.equal(team.telegram[1].maxModel, 'opus');
  ({ team } = addPrincipal(team, 'telegram', { id: '3', name: 'Mo', role: 'guest', maxModel: 'haiku' }));
  assert.deepEqual(team.telegram[2], { id: '3', name: 'Mo', role: 'guest' }, 'invalid cap leaves no maxModel key');
  // re-adding the same id WITHOUT a cap clears a previously-set one
  ({ team } = addPrincipal(team, 'telegram', { id: '1', name: 'Sam', role: 'member' }));
  assert.equal(team.telegram[0].maxModel, undefined, 'cap cleared on re-add without one');
  // round-trips through buildRoster → resolvePrincipal as a live cap
  const roster = buildRoster(team, {});
  assert.equal(resolvePrincipal(roster, 'telegram', '2').model, 'opus');
});

// (5) capModel cost-DoS core: classifyModel can NEVER exceed the cap; the cap can only LOWER, never raise.
test('cap: capModel clamps DOWN only — opus auto-route blocked under a sonnet cap, never an upgrade', () => {
  assert.equal(capModel(MODELS.opus, 'sonnet'), MODELS.sonnet, 'opus escalation blocked by a sonnet cap');
  assert.equal(capModel(MODELS.sonnet, 'opus'), MODELS.sonnet, 'cap never RAISES a stranger-reachable tier');
  assert.equal(capModel(MODELS.opus, 'opus'), MODELS.opus, 'an equal cap is a no-op');
  assert.equal(capModel(MODELS.opus, null), MODELS.opus, 'no cap → auto-routing unchanged');
  assert.equal(capModel(MODELS.sonnet, ''), MODELS.sonnet, 'invalid cap → passthrough');
  assert.equal(capModel(MODELS.sonnet, 'haiku'), MODELS.sonnet, 'junk cap → passthrough, never injected');
});

// (6) Boundary: the ONLY path to a non-null cap is the owner-written roster — a sender-style string yields null.
test('cap: a cap is derivable ONLY from the owner roster, never from a sender-supplied string', () => {
  const roster = buildRoster({ telegram: [{ id: '1', role: 'guest', maxModel: 'sonnet' }] }, {});
  assert.equal(resolvePrincipal(roster, 'telegram', '1').model, 'sonnet', 'the cap comes from the roster entry');
  // anything a remote sender could shape that isn't a bare tier name validates to null — no path to a forged cap.
  for (const s of ['OPUS please', '../../opus', 'sonnet\nopus', '{"model":"opus"}', 'opus or sonnet'])
    assert.equal(normPinModel(s), null, s);
});

// (7) Integration shape: the exact askScoped line — a guest capped at sonnet cannot burn opus on a code prompt.
test('cap: a guest capped at sonnet cannot reach opus even on a classifyModel-opus prompt', () => {
  const principal = resolvePrincipal(buildRoster({ telegram: [{ id: '9', role: 'guest', maxModel: 'sonnet' }] }, {}), 'telegram', '9');
  // mirror daemon.askScoped: capModel(classifyModel(text), normPinModel(ctx.modelCap))
  const routed = capModel(classifyModel('debug this code and refactor the module'), normPinModel(principal.model));
  assert.equal(classifyModel('debug this code and refactor the module'), MODELS.opus, 'the phrase would auto-route to opus');
  assert.equal(routed, MODELS.sonnet, 'but the cap floors it back to sonnet');
});
