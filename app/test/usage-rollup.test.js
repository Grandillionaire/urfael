'use strict';
// Per-principal / per-channel usage-cost rollup — the PURE core. Mirrors test/lib.test.js style (node:test +
// node:assert, no deps). The daemon collects the {ev:'turn'|'remote_turn'} records from the bounded log tail and
// hands them to rollupUsage; everything checkable lives here. Cost is compared with a small epsilon (floats), token
// and turn counts exactly. Defaults match daemon.priceRates(): Sonnet $3 in / $15 out, Opus $5 in / $25 out per 1M.
const { test } = require('node:test');
const assert = require('node:assert');
const { rollupUsage, turnCostEst } = require('../lib');

const RATES = { sonnet: { in: 3, out: 15 }, opus: { in: 5, out: 25 } };          // daemon.priceRates() defaults
const RATES2 = { sonnet: { in: 6, out: 30 }, opus: { in: 10, out: 50 } };         // exactly 2x → models an env override
const approx = (a, b, eps) => assert.ok(Math.abs(a - b) <= (eps || 1e-9), 'expected ' + a + ' ≈ ' + b);

// a mix: two remote turns from the same principal, one from another, and one LOCAL turn (no principal/channel).
const RECS = [
  { ev: 'remote_turn', principal: 'telegram:alice', channel: 'telegram', model: 'opus', tokIn: 1000, tokOut: 500 },
  { ev: 'remote_turn', principal: 'telegram:alice', channel: 'telegram', model: 'opus', tokIn: 2000, tokOut: 1000 },
  { ev: 'remote_turn', principal: 'discord:bob', channel: 'discord', model: 'sonnet', tokIn: 500, tokOut: 200 },
  { ev: 'turn', model: 'sonnet', tokIn: 100, tokOut: 50, tokCache: 10 },
];

test('(a) by principal sums tokens + cost across multiple lines for the same principal', () => {
  const r = rollupUsage(RECS, RATES, { by: 'principal' });
  assert.equal(r.by, 'principal');
  const a = r.groups['telegram:alice'];
  assert.equal(a.turns, 2);
  assert.equal(a.tokIn, 3000);
  assert.equal(a.tokOut, 1500);
  assert.equal(a.tokCache, 0);
  // (1000*5 + 500*25)/1e6 + (2000*5 + 1000*25)/1e6 = 0.0175 + 0.035 = 0.0525
  approx(a.costUsd, 0.0525);
  assert.equal(r.groups['discord:bob'].turns, 1);
});

test('(b) a local {ev:"turn"} with no principal lands under "local" (and under "local" by channel too)', () => {
  const byP = rollupUsage(RECS, RATES, { by: 'principal' });
  assert.ok(byP.groups.local, 'a local turn must bucket under "local"');
  assert.equal(byP.groups.local.turns, 1);
  assert.equal(byP.groups.local.tokIn, 100);
  // sonnet: (100*3 + 10*3*0.1 + 50*15)/1e6 = (300 + 3 + 750)/1e6 = 0.001053
  approx(byP.groups.local.costUsd, 0.001053);
  const byC = rollupUsage(RECS, RATES, { by: 'channel' });
  assert.ok(byC.groups.local && byC.groups.local.turns === 1, 'a channel-less local turn buckets under "local" by channel');
});

test('(c) env-overridden rates are honored — doubling every rate doubles the cost exactly', () => {
  const base = rollupUsage(RECS, RATES, { by: 'principal' });
  const dbl = rollupUsage(RECS, RATES2, { by: 'principal' });
  approx(dbl.total.costUsd, base.total.costUsd * 2);
  approx(dbl.groups['telegram:alice'].costUsd, base.groups['telegram:alice'].costUsd * 2);
});

test('(d) INVARIANT: the sum of every group equals the total (cost + turns), the rollup is the whole', () => {
  for (const by of ['principal', 'channel']) {
    const r = rollupUsage(RECS, RATES, { by });
    let turns = 0, cost = 0, tokIn = 0, tokOut = 0;
    for (const k of Object.keys(r.groups)) { turns += r.groups[k].turns; cost += r.groups[k].costUsd; tokIn += r.groups[k].tokIn; tokOut += r.groups[k].tokOut; }
    assert.equal(turns, r.total.turns, 'turns must reconcile (' + by + ')');
    assert.equal(tokIn, r.total.tokIn);
    assert.equal(tokOut, r.total.tokOut);
    approx(cost, r.total.costUsd);
    assert.equal(r.total.turns, RECS.length);
  }
});

test('(e) turnCostEst: opus vs sonnet tier by model substring, cache billed at 0.1x the in-rate', () => {
  // opus, 1000 in / 500 out / 2000 cache → (1000*5 + 2000*5*0.1 + 500*25)/1e6 = (5000 + 1000 + 12500)/1e6 = 0.0185
  approx(turnCostEst({ model: 'opus', tokIn: 1000, tokOut: 500, tokCache: 2000 }, RATES), 0.0185);
  // a pinned id containing "opus" still resolves to the opus tier
  approx(turnCostEst({ model: 'claude-opus-4-8', tokIn: 1000, tokOut: 0 }, RATES), 0.005);
  // sonnet default tier: (1000*3 + 500*15)/1e6 = (3000 + 7500)/1e6 = 0.0105
  approx(turnCostEst({ model: 'sonnet', tokIn: 1000, tokOut: 500 }, RATES), 0.0105);
  // no tokens → no cost; missing rates → 0, never NaN/throw
  assert.equal(turnCostEst({ model: 'opus' }, RATES), 0);
  assert.equal(turnCostEst({ model: 'opus', tokIn: 10 }, undefined), 0);
});

test('(f) by channel groups telegram vs discord vs local correctly', () => {
  const r = rollupUsage(RECS, RATES, { by: 'channel' });
  assert.equal(r.by, 'channel');
  assert.equal(r.groups.telegram.turns, 2);
  assert.equal(r.groups.telegram.tokIn, 3000);
  assert.equal(r.groups.discord.turns, 1);
  assert.equal(r.groups.local.turns, 1);
});

test('(g) empty / garbage / non-array input → empty groups, zero total, never throws (fail-closed)', () => {
  for (const bad of [[], null, undefined, 'nope', 42, {}, [null, 1, 'x', {}], [{ ev: 'brain_exit' }]]) {
    const r = rollupUsage(bad, RATES, { by: 'principal' });
    assert.deepEqual(r.groups, {});
    assert.equal(r.total.turns, 0);
    assert.equal(r.total.costUsd, 0);
    assert.equal(r.total.tokIn, 0);
    assert.equal(r.by, 'principal');           // an unknown `by` still defaults sanely
    assert.ok(typeof r.note === 'string' && r.note.length);
  }
  // an unknown `by` value falls back to principal (never throws, never a stray dimension)
  assert.equal(rollupUsage(RECS, RATES, { by: 'nonsense' }).by, 'principal');
  assert.equal(rollupUsage(RECS, RATES).by, 'principal');   // missing opts
});
