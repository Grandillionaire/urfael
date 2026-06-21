'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const r = require('../router');

// a small synthetic registry covering the axes
const PROV = [
  { id: 'claude', label: 'Claude', kind: 'anthropic', authKind: 'none', verified: true, flatRate: true, proxy: 'none', cost: 5, speed: 4, quality: 5 },
  { id: 'deepseek', label: 'DeepSeek', kind: 'openai', authKind: 'key', proxy: 'router', cost: 1, speed: 3, quality: 3 },
  { id: 'groq', label: 'Groq', kind: 'openai', authKind: 'key', proxy: 'router', cost: 2, speed: 5, quality: 3 },
  { id: 'ollama', label: 'Ollama', kind: 'ollama', authKind: 'local', proxy: 'router', cost: 1, speed: 2, quality: 2 },
  { id: 'gpt', label: 'OpenAI', kind: 'openai', authKind: 'key', proxy: 'router', verified: true, cost: 4, speed: 4, quality: 5,
    models: [{ id: 'big', role: 'big', ctx: 200000, tools: true, cost: 4, speed: 4, quality: 5 }, { id: 'small', role: 'small', ctx: 128000, tools: true, cost: 2, speed: 5, quality: 3 }] },
];

// ── candidates: one row per (provider, model); a model-less provider yields one big-role candidate ──
test('candidates flattens providers and models, falling back to provider tiers', () => {
  const c = r.candidates(PROV);
  assert.equal(c.length, 4 + 2);                         // 4 model-less + gpt's 2 models
  assert.ok(c.find((x) => x.providerId === 'ollama' && x.local === true));
  const gptSmall = c.find((x) => x.providerId === 'gpt' && x.role === 'small');
  assert.equal(gptSmall.ctx, 128000);
  assert.equal(gptSmall.cost, 2);
});

// ── routing picks the right provider for each priority ──
test('route honours the priority axis', () => {
  assert.equal(r.route(PROV, { priority: 'cost' }).pick.providerId, 'deepseek');     // cheapest (cost 1, decent quality)
  assert.equal(r.route(PROV, { priority: 'speed' }).pick.speed, 5);                  // a speed-5 model (groq/gpt-small tie → verified wins)
  assert.equal(r.route(PROV, { priority: 'quality' }).pick.quality, 5);              // a top-quality model
  assert.equal(r.route(PROV, { priority: 'privacy' }).pick.local, true);             // only local survives
  assert.equal(r.route(PROV, { priority: 'privacy' }).pick.providerId, 'ollama');
});

// ── filters ──
test('filters narrow by role, tools, context, local', () => {
  assert.ok(r.route(PROV, { role: 'small' }).pick.role === 'small');
  assert.equal(r.route(PROV, { minCtx: 150000, role: 'small' }).considered, 0);      // gpt-small ctx 128k < 150k → excluded
  // gpt-big 200000 ok; the model-less providers have ctx 0 (unknown, not excluded)
  const hi = r.route(PROV, { minCtx: 150000 });
  assert.ok(hi.pick.ctx === 0 || hi.pick.ctx >= 150000);
  assert.equal(r.route(PROV, { localOnly: true }).considered, 1);
  assert.equal(r.route(PROV, { role: 'nonsense', needsTools: true }).pick != null, true);
});

// ── Pareto frontier: dominated options are excluded; a non-dominated cheap-but-weak stays ──
test('pareto returns only non-dominated candidates', () => {
  const cands = r.candidates(PROV);
  const front = r.pareto(cands);
  // the cheapest (deepseek/ollama, cost 1) and a fastest (groq/gpt-small, speed 5) are non-dominated; claude at cost
  // tier 5 is DOMINATED by gpt-big (cost 4, same speed+quality), which is correct on these per-token tiers.
  assert.ok(front.some((c) => c.cost === 1));
  assert.ok(front.some((c) => c.speed === 5));
  assert.ok(!front.some((c) => c.providerId === 'claude'), 'cost-5 claude is dominated by the cheaper-tier gpt-big');
  assert.ok(front.length < cands.length); // at least claude is pruned
  // dominates is correct: a cheaper+faster+better candidate dominates a worse one
  assert.equal(r.dominates({ cost: 1, speed: 5, quality: 5 }, { cost: 3, speed: 3, quality: 3 }), true);
  assert.equal(r.dominates({ cost: 3, speed: 3, quality: 3 }, { cost: 1, speed: 5, quality: 5 }), false);
});

// ── explainability + honesty: the reason names the tiers and nudges toward the flat-rate default on cost ──
test('route explains the pick and stays honest about flat-rate + unknown tiers', () => {
  const cost = r.route(PROV, { priority: 'cost' });
  assert.match(cost.why, /cheapest/);
  assert.match(cost.why, /cost 1\/5/);
  assert.match(cost.why, /Claude subscription is \$0 marginal|may be cheaper/);     // honest nudge
  const unknown = r.route([{ id: 'x', label: 'X', kind: 'openai', authKind: 'key', proxy: 'router' }], { priority: 'quality' });
  assert.match(unknown.why, /unknown|estimated/);
});

// ── empty / junk safe ──
test('route is total on empty and junk input', () => {
  assert.equal(r.route([], {}).pick, null);
  assert.doesNotThrow(() => r.route(null, null));
  assert.equal(r.route([{ id: 'only-local', authKind: 'local', quality: 2 }], { priority: 'privacy' }).pick.providerId, 'only-local');
});
