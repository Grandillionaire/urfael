'use strict';
// Unit tests for app/reflect.js — SLEEP-TIME REFLECTION. Pure logic + atomic fs helpers, no daemon, no spawn. Run:
//   env -u ELECTRON_RUN_AS_NODE node --test test/reflect.test.js
// The contract under test: the trigger fires on cadence/threshold (NOT every tick); consolidation is deterministic
// and reuses the trust machinery; the note is written WITHOUT mutating existing notes; the notify gate QUEUES and
// NEVER acts; and every path fails soft (no throw) on junk input.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reflect = require('../reflect');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-reflect-')); }
const NOW = Date.parse('2026-07-06T20:00:00.000Z');
const HOUR = 3600000, DAY = 86400000;

// archive-entry + ledger-item factories matching the real shapes (recordSession / learn.js)
const turn = (over = {}) => Object.assign({ t: new Date(NOW).toISOString(), channel: 'local', model: 'sonnet', user: '', urfael: '', ms: 100 }, over);
const lesson = (over = {}) => Object.assign({
  id: over.id || ('L' + Math.random().toString(36).slice(2, 8)),
  type: 'lesson', ref: 'a note', source: '', learnedAt: NOW,
  status: 'trusted', confidence: 0.5, verify: null, surfaced: 0, helped: 0, corrected: 0, lastUsed: null,
}, over);

// ════════════════════════════════ TRIGGER (fires on cadence/threshold, not every tick) ════════════════════════

test('shouldReflect fires on the accumulated-activity threshold once enough turns pile up', () => {
  const r = reflect.shouldReflect({ lastReflectAt: NOW - 7 * HOUR }, 25, NOW);
  assert.equal(r.fire, true);
  assert.equal(r.reason, 'activity-threshold');
});

test('shouldReflect rate-limits: too soon since the last reflection never fires (anti-nag)', () => {
  // 25 turns would otherwise fire, but only 2h have passed (< minHoursBetween) → suppressed
  const r = reflect.shouldReflect({ lastReflectAt: NOW - 2 * HOUR }, 25, NOW);
  assert.equal(r.fire, false);
  assert.equal(r.reason, 'too-soon');
});

test('shouldReflect honors the daily floor: any activity after ~24h fires', () => {
  const r = reflect.shouldReflect({ lastReflectAt: NOW - 25 * HOUR }, 3, NOW);
  assert.equal(r.fire, true);
  assert.equal(r.reason, 'daily-cadence');
});

test('shouldReflect does NOT fire on an idle tick with no activity', () => {
  const r = reflect.shouldReflect({ lastReflectAt: NOW - 48 * HOUR }, 0, NOW);
  assert.equal(r.fire, false);
  assert.equal(r.reason, 'no-activity');
});

test('shouldReflect fires on the accumulated path (>= minTurns after minHoursBetween)', () => {
  const r = reflect.shouldReflect({ lastReflectAt: NOW - 8 * HOUR }, 10, NOW);
  assert.equal(r.fire, true);
  assert.equal(r.reason, 'accumulated');
});

test('shouldReflect stays quiet below the accumulated threshold', () => {
  const r = reflect.shouldReflect({ lastReflectAt: NOW - 8 * HOUR }, 3, NOW);
  assert.equal(r.fire, false);
  assert.equal(r.reason, 'below-threshold');
});

test('shouldReflect fails closed on junk input (never throws)', () => {
  assert.doesNotThrow(() => reflect.shouldReflect(null, 'nope', 'later'));
  assert.equal(reflect.shouldReflect(null, NaN, NaN).fire, false);
});

test('turnsSince windows the archive and fails closed on undated lines', () => {
  const entries = [
    turn({ t: new Date(NOW - 2 * DAY).toISOString(), user: 'old' }),   // before the window
    turn({ t: new Date(NOW - 1 * HOUR).toISOString(), user: 'recent' }),
    turn({ t: 'not-a-date', user: 'undated' }),                        // fails closed → excluded, no throw
  ];
  const w = reflect.turnsSince(entries, NOW - 6 * HOUR, NOW);
  assert.equal(w.length, 1);
  assert.equal(w[0].user, 'recent');
  assert.deepEqual(reflect.turnsSince(null, 0, NOW), []);
});

// ════════════════════════════════ SYNTHESIS (deterministic pattern mining) ════════════════════════════════

test('deferralPatterns detects a topic deferred across >= 2 distinct sessions', () => {
  const entries = [
    turn({ t: new Date(NOW - DAY).toISOString(), user: 'I should finish the stripe integration but not now, later' }),
    turn({ t: new Date(NOW).toISOString(), user: 'still have to do the stripe integration, will get to it tomorrow' }),
  ];
  const defs = reflect.deferralPatterns(entries);
  const stripe = defs.find((d) => d.topic === 'stripe');
  assert.ok(stripe, 'stripe is surfaced as a recurring deferral');
  assert.equal(stripe.days.length, 2, 'seen deferred on two distinct days');
});

test('deferralPatterns ignores a single-session deferral (not yet "recurring")', () => {
  const entries = [turn({ user: 'I need to send the invoice later' })];
  const defs = reflect.deferralPatterns(entries);
  assert.ok(!defs.some((d) => d.topic === 'invoice'), 'a one-off deferral is not a pattern');
});

test('sessionThemes surfaces recurring content terms and drops one-offs', () => {
  const entries = [
    turn({ user: 'the polymarket weather bot needs a fix' }),
    turn({ user: 'polymarket paper trading looks promising' }),
    turn({ user: 'unrelated one-off question' }),
  ];
  const themes = reflect.sessionThemes(entries);
  assert.ok(themes.some((x) => x.term === 'polymarket' && x.count >= 2));
  assert.ok(!themes.some((x) => x.term === 'unrelated'));
});

test('synthesize is deterministic and turns a cross-session deferral into a QUEUED (pending) nudge', () => {
  const entries = [
    turn({ t: new Date(NOW - DAY).toISOString(), user: 'the meridian equities backtest — hold off, later' }),
    turn({ t: new Date(NOW).toISOString(), user: 'meridian equities backtest still pending, will do it tomorrow' }),
  ];
  const a = reflect.synthesize(entries, { merged: 1, retired: 0, trustedCount: 4 }, NOW);
  const b = reflect.synthesize(entries, { merged: 1, retired: 0, trustedCount: 4 }, NOW);
  // identical inputs → identical analysis (nudge ids are random, so compare the analytic payload)
  const strip = (s) => JSON.stringify({ reflections: s.reflections, themes: s.themes, deferrals: s.deferrals, ledger: s.ledger, turnCount: s.turnCount });
  assert.equal(strip(a), strip(b), 'synthesis is deterministic');
  assert.ok(a.nudges.length >= 1, 'a recurring deferral produced a nudge');
  assert.ok(a.nudges.every((n) => n.status === 'pending'), 'every nudge is QUEUED, never acted');
  assert.ok(a.reflections.some((r) => /keep returning to but deferring/.test(r)));
});

test('synthesize fails closed on junk (null turns) — no throw, empty payload', () => {
  let s;
  assert.doesNotThrow(() => { s = reflect.synthesize(null, null, NOW); });
  assert.equal(s.turnCount, 0);
  assert.deepEqual(s.nudges, []);
});

// ════════════════════════════════ CONSOLIDATION (reuses learn.js + consolidate.js) ════════════════════════

function ledgerFixture() {
  return [
    lesson({ id: 'A', ref: 'the gcc brunn railway token lives at config gcc brunn railway token', confidence: 0.6, surfaced: 2 }),
    lesson({ id: 'B', ref: 'gcc brunn railway token lives at config gcc brunn railway token', confidence: 0.9, surfaced: 1, helped: 1 }),
    lesson({ id: 'U', ref: 'a lesson that keeps surfacing but never helps and got corrected', surfaced: 4, helped: 0, corrected: 2, confidence: 0.1 }),
    lesson({ id: 'K', ref: 'never touch MX or SPF DNS records for eblex', confidence: 0.8, helped: 3 }),
  ];
}

test('consolidatePass deterministically dedupes near-duplicates and retires the proven-useless', () => {
  const r1 = reflect.consolidatePass(ledgerFixture(), NOW);
  const r2 = reflect.consolidatePass(ledgerFixture(), NOW);
  assert.equal(r1.changed, true);
  assert.ok(r1.merged >= 1, 'the near-duplicate lesson pair was merged');
  assert.ok(r1.retired >= 1, 'the useless lesson was retired');
  // deterministic across fresh identical inputs
  assert.equal(r1.merged, r2.merged);
  assert.equal(r1.retired, r2.retired);
  // the useless item is retired; the valuable one is preserved
  const u = r1.items.find((it) => it.id === 'U');
  const k = r1.items.find((it) => it.id === 'K');
  assert.equal(u.status, 'retired');
  assert.equal(k.status, 'trusted');
});

test('consolidatePass fails closed on a junk ledger (no throw, no change)', () => {
  let r;
  assert.doesNotThrow(() => { r = reflect.consolidatePass(null, NOW); });
  assert.equal(r.changed, false);
  assert.deepEqual(r.items, []);
  assert.doesNotThrow(() => reflect.consolidatePass([null, 42, { nope: true }], NOW));
});

// ════════════════════════════════ NOTE BUILDING + WRITING (never mutates existing notes) ════════════════════

test('noteFilename is the dated, inspectable form', () => {
  assert.equal(reflect.noteFilename('2026-07-06'), 'Daily Reflection 2026-07-06.md');
});

test('buildNote renders the dated header, [[wikilinks]], the review section, and redacts secrets', () => {
  const syn = {
    turnCount: 5, sessionCount: 2,
    themes: [{ term: 'stripe', count: 3 }],
    deferrals: [{ topic: 'stripe', count: 2, days: ['2026-07-01', '2026-07-06'], sample: 'do stripe, api_key=sk-SECRETsecretsecret123' }],
    ledger: { merged: 1, retired: 1, trustedCount: 3 },
    nudges: [reflect.makeNudge({ kind: 'deferral', text: 'tackle stripe', links: ['stripe'], now: NOW })],
  };
  const note = reflect.buildNote({ date: '2026-07-06', now: NOW, synthesis: syn, prevDate: '2026-07-05' });
  assert.ok(note.includes('# Daily Reflection 2026-07-06'));
  assert.ok(note.includes('[[stripe]]'), 'themes/deferrals link out as wikilinks');
  assert.ok(note.includes('[[Daily Reflection 2026-07-05]]'), 'links the previous reflection');
  assert.ok(note.includes('notify / accept / edit / ignore'), 'the review taxonomy is spelled out');
  assert.ok(/\[REDACTED\]/.test(note) && !note.includes('sk-SECRETsecretsecret123'), 'secrets in a sample are redacted');
});

test('buildNote fails closed on empty input (a valid, quiet note, no throw)', () => {
  let note;
  assert.doesNotThrow(() => { note = reflect.buildNote({}); });
  assert.ok(note.includes('# Daily Reflection'));
  assert.ok(note.includes('quiet day'));
});

test('writeNote creates its OWN note and never mutates an existing sibling note', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), 'PRECIOUS owner memory\n');
  const before = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
  const w = reflect.writeNote(dir, '2026-07-06', '# note body one', { now: NOW });
  assert.ok(w.ok && w.created && !w.appended);
  assert.ok(fs.existsSync(path.join(dir, 'Daily Reflection 2026-07-06.md')));
  assert.equal(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), before, 'the sibling note is byte-identical (untouched)');
});

test('writeNote APPENDS to its own note on a same-day re-run, preserving prior content', () => {
  const dir = tmp();
  reflect.writeNote(dir, '2026-07-06', '# note body one', { now: NOW });
  const w2 = reflect.writeNote(dir, '2026-07-06', '# note body two', { now: NOW + HOUR });
  assert.ok(w2.ok && w2.appended && !w2.created);
  const content = fs.readFileSync(path.join(dir, 'Daily Reflection 2026-07-06.md'), 'utf8');
  assert.ok(content.includes('# note body one'), 'the first reflection is preserved');
  assert.ok(content.includes('# note body two'), 'the re-run is appended');
  assert.ok(content.includes('re-reflected'), 'the append is marked');
});

test('writeNote fails closed on a bad target (no throw)', () => {
  let w;
  assert.doesNotThrow(() => { w = reflect.writeNote('', '2026-07-06', 'x'); });
  assert.equal(w.ok, false);
  assert.doesNotThrow(() => reflect.writeNote(tmp(), '2026-07-06', null));
});

test('prevReflectionDate finds the newest prior reflection or fails closed to empty', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'Daily Reflection 2026-07-04.md'), 'x');
  fs.writeFileSync(path.join(dir, 'Daily Reflection 2026-07-05.md'), 'x');
  assert.equal(reflect.prevReflectionDate(dir, '2026-07-06'), '2026-07-05');
  assert.equal(reflect.prevReflectionDate(dir, '2026-07-04'), '');   // nothing strictly before
  assert.equal(reflect.prevReflectionDate('/no/such/dir', '2026-07-06'), '');
});

// ════════════════════════════════ NOTIFY-NOT-ACT (queues, never acts) ════════════════════════════════

test('the module exposes NO act/execute/schedule path — reflection cannot act by construction', () => {
  assert.equal(typeof reflect.act, 'undefined');
  assert.equal(typeof reflect.execute, 'undefined');
  assert.equal(typeof reflect.schedule, 'undefined');
  assert.deepEqual(reflect.NUDGE_ACTIONS, ['notify', 'accept', 'edit', 'ignore']);
});

test('makeNudge + queueNudge QUEUE a pending nudge (never acted), dedupe, and do not mutate the input queue', () => {
  const n = reflect.makeNudge({ kind: 'deferral', text: 'do the thing', links: ['thing'], now: NOW });
  assert.equal(n.status, 'pending', 'a fresh nudge is QUEUED, not acted');
  assert.equal(n.action, null);
  const orig = [];
  const q = reflect.queueNudge(orig, n);
  assert.equal(orig.length, 0, 'input queue untouched (pure)');
  assert.equal(q.length, 1);
  assert.equal(q[0].status, 'pending');
  const q2 = reflect.queueNudge(q, reflect.makeNudge({ text: 'do the thing', now: NOW }));
  assert.equal(q2.length, 1, 'same-text nudge is deduped (no repeat nagging)');
});

test('queueNudge is bounded and drops reviewed entries first', () => {
  let q = [];
  for (let i = 0; i < 5; i++) q = reflect.queueNudge(q, reflect.makeNudge({ text: 'nudge ' + i, now: NOW }), { max: 3 });
  assert.ok(q.length <= 3, 'the queue is capped');
});

test('reviewNudge records the owner decision (accept/edit/ignore/notify) as pure data — it acts on nothing', () => {
  const q = reflect.queueNudge([], reflect.makeNudge({ text: 'ship the thing', now: NOW }));
  const id = q[0].id;

  const acc = reflect.reviewNudge(q, id, 'accept', { now: NOW });
  assert.equal(acc[0].status, 'accepted');
  assert.equal(acc[0].action, 'accept');
  assert.equal(q[0].status, 'pending', 'the original queue is untouched (pure)');

  assert.equal(reflect.reviewNudge(q, id, 'ignore')[0].status, 'dismissed');
  assert.equal(reflect.reviewNudge(q, id, 'notify')[0].status, 'notified');

  const ed = reflect.reviewNudge(q, id, 'edit', { text: 'ship it Friday instead' });
  assert.equal(ed[0].text, 'ship it Friday instead');
  assert.equal(ed[0].status, 'pending', 'an edited nudge stays pending for a later decision');
});

test('reviewNudge ignores an out-of-taxonomy action and an unknown id (fail-closed no-op)', () => {
  const q = reflect.queueNudge([], reflect.makeNudge({ text: 'a nudge', now: NOW }));
  assert.equal(reflect.reviewNudge(q, q[0].id, 'delete')[0].status, 'pending', 'unknown action is a no-op');
  assert.equal(reflect.reviewNudge(q, 'no-such-id', 'accept')[0].status, 'pending', 'unknown id changes nothing');
  assert.doesNotThrow(() => reflect.reviewNudge(null, 'x', 'accept'));
});

test('pendingNudges returns only the still-pending nudges', () => {
  const q = [reflect.makeNudge({ text: 'a', now: NOW }), reflect.makeNudge({ text: 'b', now: NOW })];
  const q2 = reflect.reviewNudge(q, q[0].id, 'ignore');
  assert.equal(reflect.pendingNudges(q2).length, 1);
});

// ════════════════════════════════ PERSISTENCE (atomic, fail-closed I/O) ════════════════════════════════

test('inbox + state round-trip and fail closed on missing/corrupt files', () => {
  const dir = tmp();
  const inboxF = path.join(dir, 'reflections-inbox.json');
  const stateF = path.join(dir, 'reflect.json');
  assert.deepEqual(reflect.loadInbox(inboxF), [], 'missing inbox → []');
  reflect.saveInbox(inboxF, [reflect.makeNudge({ text: 'x', now: NOW })]);
  assert.equal(reflect.loadInbox(inboxF).length, 1, 'round-trips');
  fs.writeFileSync(inboxF, '{corrupt json');
  assert.deepEqual(reflect.loadInbox(inboxF), [], 'corrupt inbox → [] (fail-closed)');

  assert.deepEqual(reflect.loadState(stateF), {}, 'missing state → {}');
  reflect.saveState(stateF, { lastReflectAt: NOW });
  assert.equal(reflect.loadState(stateF).lastReflectAt, NOW, 'round-trips');
  fs.writeFileSync(stateF, 'not json');
  assert.deepEqual(reflect.loadState(stateF), {}, 'corrupt state → {} (fail-closed)');
});
