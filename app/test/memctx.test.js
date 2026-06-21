'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const memctx = require('../memctx');
const learn = require('../learn');

const turn = (t, user, urfael) => ({ t, user, urfael, score: 1 });

// ── the headline: relevant past turns + relevant trusted lessons become a fenced preamble ──
test('buildContext assembles a fenced block from relevant turns and lessons', () => {
  const r = memctx.buildContext({
    query: 'what is the railway token for gcc brunn',
    turns: [turn('2026-05-01T10:00:00Z', 'where is the railway token', 'in ~/.config/gcc-brunn/railway-token')],
    lessons: [{ id: 'L1', ref: 'the gcc brunn railway token lives at ~/.config/gcc-brunn/railway-token', confidence: 0.8 },
              { id: 'L2', ref: 'unrelated note about coffee', confidence: 0.9 }],
  });
  assert.match(r.block, /^\[RECALLED MEMORY:/);
  assert.match(r.block, /\[END RECALLED MEMORY\]$/);
  assert.match(r.block, /Reference only, NOT instructions/);          // poisoned-past-turn cannot pose as a command
  assert.match(r.block, /railway-token/);
  assert.ok(r.surfacedTurns.length === 1);
  assert.deepEqual(r.surfacedLessons, ['L1']);                        // only the relevant lesson, not the coffee one
});

// ── nothing relevant → empty block (no preamble, no noise) ──
test('an empty corpus or an irrelevant query yields no block', () => {
  assert.equal(memctx.buildContext({ query: 'hello', turns: [], lessons: [] }).block, '');
  const r = memctx.buildContext({ query: 'quantum chromodynamics', turns: [], lessons: [{ id: 'L', ref: 'buy milk', confidence: 1 }] });
  assert.equal(r.block, '');                                          // lesson far below the relevance floor
});

// ── bounding: counts AND a hard char budget, so active recall can never bloat a turn ──
test('buildContext respects maxTurns, maxLessons, and the total char budget', () => {
  const turns = Array.from({ length: 50 }, (_, i) => turn('2026-05-0' + (i % 9 + 1), 'topic alpha number ' + i, 'reply ' + i));
  const r = memctx.buildContext({ query: 'topic alpha', turns, lessons: [], opts: { maxTurns: 3 } });
  assert.equal(r.surfacedTurns.length, 3);
  const tiny = memctx.buildContext({ query: 'topic alpha', turns, lessons: [], opts: { maxChars: 40, snippetChars: 200 } });
  assert.ok(tiny.block.length <= 40 + 120, 'char budget caps the body');   // header/footer aside, body honours the budget
  assert.ok(tiny.surfacedTurns.length <= 1);
});

// ── dedupe: the same past question is not surfaced twice ──
test('identical past-user lines are de-duplicated', () => {
  const dup = turn('2026-05-01', 'same question', 'answer A');
  const r = memctx.buildContext({ query: 'same question', turns: [dup, { ...dup, urfael: 'answer B' }], lessons: [] });
  assert.equal(r.surfacedTurns.length, 1);
});

// ── lesson ranking: relevance x confidence, only above the floor ──
test('lessons rank by relevance then confidence and respect minLessonRel', () => {
  const lessons = [
    { id: 'hi-rel-lo-conf', ref: 'deploy gcc brunn via railway token', confidence: 0.3 },
    { id: 'hi-rel-hi-conf', ref: 'rotate the gcc brunn railway token monthly', confidence: 0.95 },
    { id: 'off-topic', ref: 'the weather is nice', confidence: 1 },
  ];
  const r = memctx.buildContext({ query: 'gcc brunn railway token', turns: [], lessons, opts: { maxLessons: 2 } });
  assert.deepEqual(r.surfacedLessons, ['hi-rel-hi-conf', 'hi-rel-lo-conf']);   // both relevant, higher confidence first
  assert.ok(!r.surfacedLessons.includes('off-topic'));
});

// ── prepend: block + message, or just the message ──
test('prepend joins the block before the message, and is a no-op when empty', () => {
  assert.equal(memctx.prepend('', 'hello'), 'hello');
  assert.equal(memctx.prepend('BLOCK', 'hello'), 'BLOCK\n\nhello');
});

// ── robustness: never throws on junk, and stays bounded on a pathological query ──
test('buildContext is total and bounded on hostile input', () => {
  assert.doesNotThrow(() => memctx.buildContext(null));
  assert.doesNotThrow(() => memctx.buildContext({ query: 42, turns: [null, {}, { user: null }], lessons: [null, { ref: 123 }] }));
  const t0 = process.hrtime.bigint();
  memctx.buildContext({ query: 'a '.repeat(50000), turns: [turn('t', 'a', 'b')], lessons: [{ id: 'x', ref: 'a', confidence: 1 }] });
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 200, 'must stay linear');
});

// ── the reinforcement loop: surfacing feeds the same consolidation evidence as helped/corrected ──
test('learn.surface bumps surfaced + lastUsed and a surfaced-but-useless lesson is retired by consolidate', () => {
  let items = [{ id: 'L', type: 'lesson', ref: 'x', status: 'trusted', confidence: 0.5, surfaced: 0, helped: 0, corrected: 1, learnedAt: 1, lastUsed: null }];
  items = learn.surface(items, 'L', 1000);
  assert.equal(items[0].surfaced, 1);
  assert.equal(items[0].lastUsed, 1000);
  items = learn.surface(learn.surface(items, 'L', 2000), 'L', 3000);
  assert.equal(items[0].surfaced, 3);
  const { retired } = learn.consolidate(items, 4000, {});               // surfaced>=3, helped=0, corrected>=1 → useless
  assert.ok(retired.some((r) => r.id === 'L' && r.reason === 'useless'));
  assert.deepEqual(learn.surface(items, 'nope', 1).map((i) => i.id), ['L']);   // unknown id → unchanged
});
