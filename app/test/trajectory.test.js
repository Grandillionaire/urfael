'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const tj = require('../trajectory');

const ENTRIES = [
  { t: '2026-05-01T10:00:00Z', channel: 'local', model: 'opus', user: 'how do I deploy?', urfael: 'Use Railway. [SPOKEN]Railway, sir.[/SPOKEN]' },
  { t: '2026-05-02T11:00:00Z', channel: 'telegram', model: 'sonnet', user: 'my key is sk-ant-ABCDEFGHIJKLMNOP1234567890', urfael: 'noted' },
  { t: '2026-06-01T09:00:00Z', channel: 'local', model: 'sonnet', user: '', urfael: 'orphan reply' }, // empty user → dropped
];
const LEDGER = [
  { id: 'L1', type: 'lesson', status: 'trusted', ref: 'deploy gcc brunn via Railway', confidence: 0.91, verify: { correct: true, general: true, safe: true } },
  { id: 'L2', type: 'lesson', status: 'trusted', ref: 'low confidence note', confidence: 0.3, verify: { correct: true, general: false, safe: true } },
  { id: 'L3', type: 'lesson', status: 'proposed', ref: 'not yet verified', confidence: 0 }, // untrusted → never exported
  { id: 'L4', type: 'lesson', status: 'retired', ref: 'a wrong lesson', confidence: 0.1 },
];

// ── SFT: clean user/assistant pairs in the OpenAI fine-tune shape; [SPOKEN] stripped; empty turns dropped ──
test('buildSFT emits messages pairs, strips spoken tags, drops empty turns', () => {
  const { records } = tj.buildSFT(ENTRIES, {});
  assert.equal(records.length, 2);                               // the empty-user turn is dropped
  assert.deepEqual(records[0].messages[0], { role: 'user', content: 'how do I deploy?' });
  assert.equal(records[0].messages[1].content, 'Use Railway. Railway, sir.');   // content kept, control markup dropped
  assert.doesNotMatch(records[0].messages[1].content, /\[\/?SPOKEN\]/i);         // no [SPOKEN] tags leak into the dataset
  assert.equal(records[0].meta.model, 'opus');
});

// ── redaction: a credential-shaped string is stripped before export, and counted ──
test('secrets are redacted by default and counted; --no-redact keeps them', () => {
  const red = tj.buildSFT(ENTRIES, {});
  const leaked = JSON.stringify(red.records);
  assert.doesNotMatch(leaked, /sk-ant-ABCDEFGHIJKLMNOP/);
  assert.match(leaked, /\[REDACTED\]/);
  assert.ok(red.redactions >= 1);
  const raw = tj.buildSFT(ENTRIES, { redact: false });
  assert.match(JSON.stringify(raw.records), /sk-ant-ABCDEFGHIJKLMNOP/);
  // KEY=value form keeps the key name, redacts only the value
  const kv = tj.redact('export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIabcdEFGHIjklmnop');
  assert.match(kv.text, /AWS_SECRET_ACCESS_KEY=\[REDACTED\]/);
  assert.equal(kv.n, 1);
});

// ── filter: by date range, channel, model ──
test('filter narrows by since/until, channel, and model', () => {
  assert.equal(tj.buildSFT(ENTRIES, { since: '2026-05-02' }).records.length, 1);
  assert.equal(tj.buildSFT(ENTRIES, { channel: 'telegram' }).records.length, 1);
  assert.equal(tj.buildSFT(ENTRIES, { model: 'opus' }).records.length, 1);
  assert.equal(tj.buildSFT(ENTRIES, { until: '2026-04-01' }).records.length, 0);
});

// ── the differentiator: a VERIFIED-knowledge dataset from trusted lessons only, confidence-weighted + sorted ──
test('buildLessons exports only trusted lessons, carries the verdict + confidence, sorts strongest first', () => {
  const { records } = tj.buildLessons(LEDGER, {});
  assert.equal(records.length, 2);                               // L1 + L2 (trusted); L3 proposed + L4 retired excluded
  assert.equal(records[0].metadata.confidence, 0.91);           // highest confidence first
  assert.equal(records[0].metadata.verified, true);
  assert.deepEqual(records[0].metadata.verdict, { correct: true, general: true, safe: true });
  assert.equal(records[0].reward, 0.91);
  assert.equal(records[0].messages[1].content, 'deploy gcc brunn via Railway');
  // minConfidence gates weak lessons
  assert.equal(tj.buildLessons(LEDGER, { minConfidence: 0.5 }).records.length, 1);
});

// ── atropos format: trajectory + reward + metadata; archived turns are success-filtered so reward is 1.0 ──
test('buildAtropos emits trajectory + reward + metadata', () => {
  const { records } = tj.buildAtropos(ENTRIES, {});
  assert.equal(records.length, 2);
  assert.equal(records[0].reward, 1.0);
  assert.ok(Array.isArray(records[0].trajectory) && records[0].trajectory.length === 2);
  assert.equal(records[0].metadata.verified, false);
});

// ── JSONL + manifest ──
test('toJSONL is one object per line; manifest summarises counts + redactions + integrity', () => {
  const sft = tj.buildSFT(ENTRIES, {});
  const jsonl = tj.toJSONL(sft.records);
  assert.equal(jsonl.trim().split('\n').length, 2);
  assert.doesNotThrow(() => jsonl.trim().split('\n').forEach((l) => JSON.parse(l)));
  const m = tj.manifest({ sft, lessons: tj.buildLessons(LEDGER, {}) }, {});
  assert.equal(m.formats.sft.records, 2);
  assert.equal(m.formats.lessons.records, 2);
  assert.ok(m.totalRedactions >= 1);
  assert.match(m.integrity, /Ledger of Record/);
});

// ── robustness: never throws on junk; redaction stays linear on a pathological string ──
test('total and bounded on hostile input', () => {
  assert.doesNotThrow(() => tj.buildSFT(null, null));
  assert.doesNotThrow(() => tj.buildLessons([null, {}, { status: 'trusted', ref: null }], {}));
  const t0 = process.hrtime.bigint();
  tj.redact('A'.repeat(200000) + ' sk-' + 'a'.repeat(50000));
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 300, 'redaction must stay linear');
});
