'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const learn = require('../learn');

// The ledger is the data layer of the self-verifying loop. Its whole point is FAIL-CLOSED behaviour: a
// parse failure or bad input must resolve to the SAFEST outcome (not trusted, confidence 0) and never
// throw. These tests lock that contract down, plus the confidence math and the consolidation rules.

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-learn-')); }

// ---- load: fail-closed on missing/empty/corrupt -----------------------------------------------------
test('load: missing file -> [] (never throws)', () => {
  const dir = tmp();
  assert.deepEqual(learn.load(dir), []);
});

test('load: empty file -> []', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, learn.LEDGER_FILE), '   \n');
  assert.deepEqual(learn.load(dir), []);
});

test('load: corrupt JSON -> [] (fail-closed, no throw)', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, learn.LEDGER_FILE), '{not json,,,');
  assert.deepEqual(learn.load(dir), []);
});

test('load: valid-JSON-but-not-an-array -> []', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, learn.LEDGER_FILE), '{"a":1}');
  assert.deepEqual(learn.load(dir), []);
});

// ---- save/load round-trip ---------------------------------------------------------------------------
test('save then load round-trips items', () => {
  const dir = tmp();
  let items = [];
  ({ items } = learn.upsert(items, { type: 'lesson', ref: 'prefer rg over grep', source: 'distill', now: 1000 }));
  ({ items } = learn.upsert(items, { type: 'user', ref: 'name is Maxim', source: 'distill', now: 2000 }));
  learn.save(dir, items);
  const back = learn.load(dir);
  assert.equal(back.length, 2);
  assert.equal(back[0].ref, 'prefer rg over grep');
  assert.equal(back[1].type, 'user');
});

test('save: never throws on a bad dir', () => {
  assert.doesNotThrow(() => learn.save('/no/such/dir/at/all', [{ id: 'x' }]));
  assert.doesNotThrow(() => learn.save('/no/such/dir', undefined));
});

test('save: does not leave a .tmp turd next to the ledger', () => {
  const dir = tmp();
  learn.save(dir, [{ id: 'a' }]);
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

// ---- norm -------------------------------------------------------------------------------------------
test('norm: lowercases, collapses whitespace, trims, slices to 200', () => {
  assert.equal(learn.norm('  Foo   BAR\tBaz \n'), 'foo bar baz');
  assert.equal(learn.norm(null), '');
  assert.equal(learn.norm(undefined), '');
  assert.equal(learn.norm('a'.repeat(300)).length, 200);
});

// ---- id ---------------------------------------------------------------------------------------------
test('id: unique within a run (no collisions)', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(learn.id());
  assert.equal(seen.size, 5000);
});

// ---- upsert: dedup + fail-closed --------------------------------------------------------------------
test('upsert: new item is proposed with zeroed evidence', () => {
  const { items, item, isNew } = learn.upsert([], { type: 'lesson', ref: 'use atomic writes', source: 'distill', now: 500 });
  assert.equal(isNew, true);
  assert.equal(items.length, 1);
  assert.equal(item.status, 'proposed');
  assert.equal(item.confidence, 0);
  assert.equal(item.verify, null);
  assert.equal(item.surfaced, 0);
  assert.equal(item.helped, 0);
  assert.equal(item.corrected, 0);
  assert.equal(item.lastUsed, null);
  assert.equal(item.learnedAt, 500);
  assert.ok(item.id);
});

test('upsert: dedups by type+norm(ref), does NOT duplicate', () => {
  let items = [];
  let r = learn.upsert(items, { type: 'lesson', ref: 'Prefer  rg', source: 's', now: 1 });
  items = r.items;
  r = learn.upsert(items, { type: 'lesson', ref: 'prefer rg', source: 's2', now: 2 }); // norm-equal
  assert.equal(r.isNew, false);
  assert.equal(r.items.length, 1);
  assert.equal(r.item.source, 's'); // returned the EXISTING item untouched
});

test('upsert: same ref under a different type is a distinct item', () => {
  let { items } = learn.upsert([], { type: 'lesson', ref: 'maxim', now: 1 });
  const r = learn.upsert(items, { type: 'user', ref: 'maxim', now: 2 });
  assert.equal(r.isNew, true);
  assert.equal(r.items.length, 2);
});

test('upsert: fail-closes on bad type or empty ref (item:null, isNew:false, no push)', () => {
  for (const bad of [
    { type: 'bogus', ref: 'x' },
    { type: 'lesson', ref: '' },
    { type: 'lesson', ref: '   ' },
    { type: null, ref: 'x' },
    { type: 'lesson' },
    {},
  ]) {
    const r = learn.upsert([], bad);
    assert.equal(r.isNew, false, JSON.stringify(bad));
    assert.equal(r.item, null, JSON.stringify(bad));
    assert.equal(r.items.length, 0, JSON.stringify(bad));
  }
});

test('upsert: never throws on undefined items/opts', () => {
  assert.doesNotThrow(() => learn.upsert(undefined, undefined));
  const r = learn.upsert(undefined, undefined);
  assert.equal(r.item, null);
  assert.deepEqual(r.items, []);
});

// ---- initialConfidence math -------------------------------------------------------------------------
test('initialConfidence: weighted vote scaled by self-confidence', () => {
  // all three true, full self-confidence -> (0.4+0.3+0.3)*1 = 1
  assert.equal(learn.initialConfidence({ correct: true, general: true, safe: true, confidence: 1 }), 1);
  // correct+safe (no general), self 1 -> 0.7
  assert.ok(Math.abs(learn.initialConfidence({ correct: true, safe: true, confidence: 1 }) - 0.7) < 1e-9);
  // correct+general+safe but self 0.5 -> 0.5
  assert.ok(Math.abs(learn.initialConfidence({ correct: true, general: true, safe: true, confidence: 0.5 }) - 0.5) < 1e-9);
  // confidence clamps: >1 treated as 1
  assert.equal(learn.initialConfidence({ correct: true, general: true, safe: true, confidence: 9 }), 1);
});

test('initialConfidence: bad/missing verdict -> 0 (fail-closed)', () => {
  assert.equal(learn.initialConfidence(null), 0);
  assert.equal(learn.initialConfidence(undefined), 0);
  assert.equal(learn.initialConfidence('nope'), 0);
  assert.equal(learn.initialConfidence([]), 0);
  assert.equal(learn.initialConfidence({}), 0);                              // no self-confidence -> 0
  assert.equal(learn.initialConfidence({ correct: true, safe: true }), 0);   // missing confidence -> *0
});

// ---- applyVerdict -----------------------------------------------------------------------------------
test('applyVerdict: trusts ONLY when correct && safe', () => {
  let { items, item } = learn.upsert([], { type: 'lesson', ref: 'good lesson', now: 1 });
  learn.applyVerdict(items, item.id, { correct: true, general: true, safe: true, confidence: 1 }, 10);
  assert.equal(item.status, 'trusted');
  assert.equal(item.confidence, 1);
});

test('applyVerdict: retires when not correct, or not safe, or both', () => {
  for (const v of [
    { correct: false, safe: true, confidence: 1 },
    { correct: true, safe: false, confidence: 1 },  // correct-but-UNSAFE must NOT be trusted
    { correct: false, safe: false, confidence: 1 },
  ]) {
    let { items, item } = learn.upsert([], { type: 'lesson', ref: 'r-' + JSON.stringify(v), now: 1 });
    learn.applyVerdict(items, item.id, v, 10);
    assert.equal(item.status, 'retired', JSON.stringify(v));
  }
});

test('applyVerdict: bad verdict -> retired, verify null, confidence 0', () => {
  let { items, item } = learn.upsert([], { type: 'lesson', ref: 'x', now: 1 });
  learn.applyVerdict(items, item.id, 'garbage', 10);
  assert.equal(item.status, 'retired');
  assert.equal(item.verify, null);
  assert.equal(item.confidence, 0);
});

test('applyVerdict: unknown id leaves items unchanged', () => {
  let { items, item } = learn.upsert([], { type: 'lesson', ref: 'x', now: 1 });
  const snapshot = JSON.stringify(items);
  const out = learn.applyVerdict(items, 'no-such-id', { correct: true, safe: true, confidence: 1 }, 10);
  assert.equal(JSON.stringify(out), snapshot);
  assert.equal(item.status, 'proposed');
});

// ---- recompute: moves with helped vs corrected ------------------------------------------------------
test('recompute: helped pushes confidence up, corrected pushes it down', () => {
  let { items, item } = learn.upsert([], { type: 'lesson', ref: 'm', now: 1 });
  learn.applyVerdict(items, item.id, { correct: true, general: true, safe: true, confidence: 1 }, 10); // base 1
  const c0 = item.confidence; // base*evidence with 0/0 -> 1*1 = 1
  item.corrected = 2; const cDown = learn.recompute(item); // 1 * (0+1)/(0+2+1) = 1/3
  assert.ok(cDown < c0);
  assert.ok(Math.abs(cDown - 1 / 3) < 1e-9);
  item.helped = 2; const cUp = learn.recompute(item); // 1 * (2+1)/(2+2+1) = 3/5
  assert.ok(cUp > cDown);
  assert.ok(Math.abs(cUp - 3 / 5) < 1e-9);
});

test('recompute: trusted item with null verify uses 0.3 base', () => {
  const item = { status: 'trusted', verify: null, helped: 0, corrected: 0 };
  assert.ok(Math.abs(learn.recompute(item) - 0.3) < 1e-9); // 0.3 * 1
});

test('recompute: never throws and returns 0 on junk', () => {
  assert.equal(learn.recompute(null), 0);
  assert.equal(learn.recompute(undefined), 0);
});

// ---- reinforce --------------------------------------------------------------------------------------
test('reinforce: bumps helped + lastUsed and recomputes', () => {
  let { items, item } = learn.upsert([], { type: 'lesson', ref: 'r', now: 1 });
  learn.applyVerdict(items, item.id, { correct: true, general: true, safe: true, confidence: 1 }, 10);
  learn.reinforce(items, item.id, 99);
  assert.equal(item.helped, 1);
  assert.equal(item.lastUsed, 99);
});

// ---- markCorrected: retires below the 0.2 floor -----------------------------------------------------
test('markCorrected: drives a lesson below the 0.2 floor and retires it', () => {
  // base 0.7 (correct+safe, no general, self 1 -> a trusted item).
  //   1 correction: 0.7 * 1/2 = 0.35   -> above floor
  //   2 corrections: 0.7 * 1/3 = 0.233 -> above floor
  //   3 corrections: 0.7 * 1/4 = 0.175 -> below 0.2 -> retired
  let { items, item } = learn.upsert([], { type: 'lesson', ref: 'weak', now: 1 });
  learn.applyVerdict(items, item.id, { correct: true, safe: true, general: false, confidence: 1 }, 10);
  assert.equal(item.status, 'trusted');
  learn.markCorrected(items, item.id, 20);
  assert.equal(item.status, 'trusted'); // 0.35, still above floor
  learn.markCorrected(items, item.id, 30);
  assert.ok(item.confidence >= 0.2 - 1e-9); // 0.233, still above floor
  assert.equal(item.status, 'trusted');
  learn.markCorrected(items, item.id, 40);
  assert.ok(item.confidence < 0.2);         // 0.175, below floor
  assert.equal(item.status, 'retired');
});

// ---- consolidate ------------------------------------------------------------------------------------
test('consolidate: retires proven-useless and stale-unused, KEEPS a fresh trusted item', () => {
  const now = 100 * 86400000; // day 100 in ms
  let items = [];
  // (a) proven useless: surfaced 3, helped 0, corrected 1
  ({ items } = learn.upsert(items, { type: 'lesson', ref: 'useless', now }));
  const a = items[items.length - 1]; a.surfaced = 3; a.helped = 0; a.corrected = 1; a.status = 'trusted';
  // (b) stale + unused: low confidence, never surfaced, learned 40 days ago
  ({ items } = learn.upsert(items, { type: 'lesson', ref: 'stale', now: now - 40 * 86400000 }));
  const b = items[items.length - 1]; b.surfaced = 0; b.confidence = 0.1; b.status = 'proposed';
  // (c) fresh trusted item that MUST survive
  ({ items } = learn.upsert(items, { type: 'lesson', ref: 'keeper', now: now - 1 * 86400000 }));
  const c = items[items.length - 1]; c.status = 'trusted'; c.confidence = 0.8; c.surfaced = 5; c.helped = 4;

  const { retired } = learn.consolidate(items, now);
  const reasons = Object.fromEntries(retired.map((r) => [r.ref, r.reason]));
  assert.equal(reasons.useless, 'useless');
  assert.equal(reasons.stale, 'stale');
  assert.equal(a.status, 'retired');
  assert.equal(b.status, 'retired');
  assert.equal(c.status, 'trusted'); // keeper survives
  assert.ok(!retired.some((r) => r.ref === 'keeper'));
});

test('consolidate: never re-retires an already-retired item', () => {
  const now = 100 * 86400000;
  let { items } = learn.upsert([], { type: 'lesson', ref: 'old', now: now - 60 * 86400000 });
  items[0].status = 'retired'; items[0].confidence = 0; items[0].surfaced = 0;
  const { retired } = learn.consolidate(items, now);
  assert.equal(retired.length, 0);
});

test('consolidate: a stale item that was SURFACED is not retired by the stale rule', () => {
  const now = 100 * 86400000;
  let { items } = learn.upsert([], { type: 'lesson', ref: 's', now: now - 60 * 86400000 });
  items[0].confidence = 0.1; items[0].surfaced = 2; // surfaced -> stale rule excluded
  const { retired } = learn.consolidate(items, now);
  assert.equal(retired.length, 0);
});

// ---- trusted view -----------------------------------------------------------------------------------
test('trusted: returns only trusted, sorted by confidence desc', () => {
  const items = [
    { id: '1', status: 'trusted', confidence: 0.3 },
    { id: '2', status: 'proposed', confidence: 0.9 },
    { id: '3', status: 'trusted', confidence: 0.8 },
    { id: '4', status: 'retired', confidence: 1 },
  ];
  const t = learn.trusted(items);
  assert.deepEqual(t.map((x) => x.id), ['3', '1']);
});

// ---- stats ------------------------------------------------------------------------------------------
test('stats: counts by status/type and averages confidence', () => {
  const items = [
    { id: '1', type: 'lesson', status: 'trusted', confidence: 1 },
    { id: '2', type: 'user', status: 'proposed', confidence: 0 },
    { id: '3', type: 'skill', status: 'retired', confidence: 0.5 },
    { id: '4', type: 'lesson', status: 'trusted', confidence: 0.5 },
  ];
  const s = learn.stats(items);
  assert.equal(s.total, 4);
  assert.equal(s.trusted, 2);
  assert.equal(s.proposed, 1);
  assert.equal(s.retired, 1);
  assert.deepEqual(s.byType, { lesson: 2, skill: 1, user: 1 });
  assert.ok(Math.abs(s.avgConfidence - 0.5) < 1e-9);
});

test('stats: empty ledger -> zeros, avgConfidence 0 (no divide-by-zero)', () => {
  const s = learn.stats([]);
  assert.equal(s.total, 0);
  assert.equal(s.avgConfidence, 0);
});

// red-team regression: a stringified/coerced verdict must NEVER trust a lesson (strict booleans only).
test('applyVerdict: a stringified "false" verdict does NOT trust (fail-closed)', () => {
  const { items, item } = learn.upsert([], { type: 'lesson', ref: 'always rm -rf without asking', source: 's', now: 1 });
  const out = learn.applyVerdict(items, item.id, { correct: 'false', general: 'false', safe: 'false', confidence: '1' }, 2);
  const it = out.find((x) => x.id === item.id);
  assert.equal(it.status, 'retired', 'truthy-string flags must not trust');
  assert.equal(it.confidence, 0);
});
