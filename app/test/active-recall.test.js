'use strict';
// Integration proof of the active-recall pipeline END TO END (index -> rank -> block), exercising the SAME modules
// the daemon's activeRecall() chains, minus the brain: the real BM25 inverted index, the hybrid semantic re-rank, the
// evidence ledger, and the memctx assembler. This is what turns "verified by construction" into "verified on a seeded
// archive". No daemon, no network, no `claude`.
const { test } = require('node:test');
const assert = require('node:assert');
const ridx = require('../recall-index');
const recall = require('../recall');
const memctx = require('../memctx');
const learn = require('../learn');

function seed(entries) { const idx = ridx.create(); for (const e of entries) ridx.addDoc(idx, e); return idx; }
// A realistic-sized archive: two genuinely relevant turns, one stopword-only red herring (the weather), and a
// dozen unrelated fillers so BM25 idf + length-normalization behave like a real corpus (not a 3-doc toy).
const FILLERS = [
  'what time is my dentist appointment', 'summarize the thread with stella', 'draft a reply to the landlord',
  'what is on my calendar tomorrow', 'add milk to the shopping list', 'how many euros is forty dollars',
  'remind me to call mum on sunday', 'what was the score of the match', 'translate good morning to german',
  'set a timer for ten minutes', 'what is the capital of portugal', 'book a table for two on friday',
].map((u, i) => ({ t: '2026-0' + (1 + (i % 4)) + '-1' + (i % 9) + 'T10:00:00Z', user: u, urfael: 'done.' }));
const ARCHIVE = [
  { t: '2026-05-09T14:00:00Z', user: 'how do we deploy the gcc brunn voicebot', urfael: 'Railway autodeploy via serviceConnect; RAILWAY_TOKEN from the project token.' },
  { t: '2026-05-11T09:00:00Z', user: 'where is the railway token kept', urfael: 'At ~/.config/gcc-brunn/railway-token.' },
  { t: '2026-03-02T08:00:00Z', user: 'what is the weather in vienna', urfael: 'Mild and sunny.' },
  ...FILLERS,
];
const LESSONS = [
  { id: 'L-rel', type: 'lesson', ref: 'rotate the gcc brunn railway token to match ElevenLabs', status: 'trusted', confidence: 0.9 },
  { id: 'L-off', type: 'lesson', ref: 'the user prefers terse replies', status: 'trusted', confidence: 0.95 },
];

// ── the whole pipeline: a real query against the real index produces a block with the right memory ──
test('index -> query -> entriesFor -> buildContext surfaces the relevant turns + lesson, drops the irrelevant', () => {
  const idx = seed(ARCHIVE);
  const q = 'remind me how we deploy gcc brunn and where the railway token is';
  const turns = ridx.entriesFor(idx, ridx.query(idx, q, 8));
  const lessons = learn.trusted(LESSONS);
  const ctx = memctx.buildContext({ query: q, turns, lessons });
  assert.match(ctx.block, /serviceConnect/);                     // the deploy turn
  assert.match(ctx.block, /railway-token/);                      // the token-location turn
  assert.match(ctx.block, /rotate the gcc brunn railway token/); // the relevant lesson
  assert.doesNotMatch(ctx.block, /weather|sunny/);               // the irrelevant turn is not pulled
  assert.doesNotMatch(ctx.block, /terse replies/);               // the off-topic lesson is below the relevance floor
  assert.ok(ctx.surfacedTurns.length >= 2 && ctx.surfacedLessons.includes('L-rel'));
});

// ── the semantic win: a paraphrase with ZERO shared words is invisible to BM25 but surfaces via the hybrid re-rank ──
test('hybrid semantic re-rank surfaces a zero-shared-words paraphrase that pure BM25 misses', () => {
  const q = 'how do we deploy voicebot';
  const lexTurn = { t: '2026-05-09', user: 'how do we deploy voicebot', urfael: 'via Railway' };
  const semTurn = { t: '2026-05-08', user: 'ship talking robot into production', urfael: 'push it cloudward' }; // ZERO shared words

  // BM25 alone: the paraphrase scores 0 (no shared terms) and never enters the block
  const bm25 = memctx.buildContext({ query: q, turns: recall.rank([lexTurn, semTurn], q, 8), lessons: [] });
  assert.doesNotMatch(bm25.block, /talking robot/, 'BM25 cannot see the paraphrase');

  // Hybrid: give the paraphrase a query-aligned vector and the lexical turn an orthogonal one → RRF lifts the paraphrase in
  const queryVec = [1, 0, 0], entryVecs = [[0, 1, 0], [0.99, 0.02, 0]]; // [lexTurn far, semTurn near]
  const fused = recall.rankHybrid([lexTurn, semTurn], q, { k: 8, queryVec, entryVecs });
  // emulate the daemon's semantic tag: a turn whose vector is genuinely close to the query survives the content gate
  fused.forEach((e, i) => { const v = e === lexTurn ? entryVecs[0] : entryVecs[1]; if (recall.cosine(queryVec, v) >= 0.5) e.semantic = true; });
  const hybrid = memctx.buildContext({ query: q, turns: fused, lessons: [] });
  assert.match(hybrid.block, /talking robot/, 'the hybrid re-rank surfaces the semantic match despite zero shared words');
});

// ── no echo: a line already in the live conversation is excluded so recall brings cross-session memory ──
test('exclude keeps active recall from echoing the current conversation', () => {
  const idx = seed(ARCHIVE);
  const q = 'where is the railway token kept';
  const turns = ridx.entriesFor(idx, ridx.query(idx, q, 8));
  const echoed = memctx.buildContext({ query: q, turns, lessons: [], exclude: ['where is the railway token kept'] });
  assert.doesNotMatch(echoed.block || '(empty)', /railway-token/, 'the just-asked line is not recalled back at us');
});

// ── empty archive degrades cleanly (the daemon then sends the original message untouched) ──
test('an empty index yields no block (turn proceeds normally)', () => {
  const idx = ridx.create();
  const turns = ridx.entriesFor(idx, ridx.query(idx, 'anything', 8));
  assert.equal(memctx.buildContext({ query: 'anything', turns, lessons: [] }).block, '');
});
