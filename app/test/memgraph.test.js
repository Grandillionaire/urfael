'use strict';
// Unit tests for the pure Memory Journey projector (app/memgraph.js). It must NEVER throw, never do I/O, keep every
// attacker-influenceable label inert (verbatim in JSON, sanitized only at the DOM), assert NO fabricated per-lesson
// proof, pass the audit-chain.verify RESULT through honestly, and stay pure.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const mg = require('../memgraph');

const US = '\x1f', RS = '\x01';
const commit = (sha, ci, subj, body) => RS + sha + US + ci + US + subj + '\n' + body;

// a realistic 3-commit drift stream (newest-first, exactly the `git log -p` shape the daemon feeds in)
const C3 = commit('3333333', '2026-06-05 10:00:00 +0200', 'user-model: revise',
  'diff --git a/MEMORY.md b/MEMORY.md\n--- a/MEMORY.md\n+++ b/MEMORY.md\n@@ -1,3 +1,3 @@\n-- prefers concise answers\n+- prefers very concise answers\n');
const C2 = commit('2222222', '2026-06-03 10:00:00 +0200', 'learn: learned',
  'diff --git a/LESSONS.md b/LESSONS.md\n--- a/LESSONS.md\n+++ b/LESSONS.md\n@@ -1,1 +1,2 @@\n+- always confirm the branch before pushing\n' +
  'diff --git a/USER.json b/USER.json\n--- a/USER.json\n+++ b/USER.json\n@@ -1,1 +1,2 @@\n+"><img src=x onerror=alert(1)>\n');
const C1 = commit('1111111', '2026-06-01 10:00:00 +0200', 'init: seed',
  'diff --git a/MEMORY.md b/MEMORY.md\n--- /dev/null\n+++ b/MEMORY.md\n@@ -0,0 +1,2 @@\n+- prefers concise answers\n+- based in Vienna\n');
const DRIFT = C3 + C2 + C1;

const LEARN = [{ id: 'x1', type: 'lesson', ref: 'always confirm the branch before pushing', status: 'trusted', confidence: 0.82, verify: { note: 'checked across sessions' } }];
const OKLEDGER = { ok: true, through: 9, head: 'deadbeef' };

// ── parseDrift ──
test('parseDrift parses the %x01/%x1f header + unified diff into per-commit added/removed', () => {
  const rows = mg.parseDrift(DRIFT);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].sha, '3333333');
  assert.equal(rows[0].subject, 'user-model: revise');
  assert.equal(rows[0].added.length, 1);
  assert.equal(rows[0].removed.length, 1);
  assert.equal(rows[0].added[0].file, 'MEMORY.md');
  assert.equal(rows[0].added[0].text, '- prefers very concise answers');
  assert.equal(rows[0].removed[0].text, '- prefers concise answers');
  // +++ / --- file headers must NOT be mistaken for added/removed beliefs
  assert.ok(!rows[0].added.some((a) => a.text.startsWith('++')));
  assert.ok(!rows[0].removed.some((r) => r.text.startsWith('--')));
});

test('parseDrift returns [] on empty / non-string / garbage and never throws', () => {
  for (const bad of ['', null, undefined, 42, {}, [], '\x01\x01', 'no control bytes at all']) {
    const r = mg.parseDrift(bad);
    assert.ok(Array.isArray(r));
  }
  assert.deepEqual(mg.parseDrift(''), []);
  assert.deepEqual(mg.parseDrift('random text without record separators'), []);
});

// ── buildGraph: nodes, edges, revision pairing ──
test('buildGraph builds distinct belief nodes with git SHA provenance handles', () => {
  const g = mg.buildGraph({ gitLogText: DRIFT, learnItems: LEARN, ledger: OKLEDGER });
  assert.ok(Array.isArray(g.nodes) && g.nodes.length >= 4);
  for (const n of g.nodes) {
    assert.ok(typeof n.sha === 'string' && n.sha.length, 'every node carries a git sha handle');
    assert.ok(typeof n.firstSha === 'string' && n.firstSha.length);
    assert.ok(n.kind === 'belief' || n.kind === 'lesson');
  }
});

test('buildGraph emits a revision EDGE old->new for a paired remove+add in one commit', () => {
  const g = mg.buildGraph({ gitLogText: DRIFT, learnItems: LEARN, ledger: OKLEDGER });
  const oldN = g.nodes.find((n) => n.label === '- prefers concise answers');
  const newN = g.nodes.find((n) => n.label === '- prefers very concise answers');
  assert.ok(oldN && newN, 'both the old and new belief are nodes');
  const e = g.edges.find((x) => x.from === oldN.id && x.to === newN.id);
  assert.ok(e, 'a revision edge connects the old belief to its revised form');
  assert.equal(e.type, 'revision');
  assert.equal(e.sha, '3333333', 'the edge carries the REAL commit sha');
  assert.ok(/June 2026/.test(e.label));
  // the revised-away old belief is marked retired (born earlier, replaced in the newest commit)
  assert.equal(oldN.retired, true);
  assert.equal(oldN.firstSha, '1111111');
  assert.equal(newN.retired, false);
});

test('an add with no similar remove creates a live node and no edge; unpaired removes never fabricate an orphan edge', () => {
  const g = mg.buildGraph({ gitLogText: DRIFT, learnItems: LEARN, ledger: OKLEDGER });
  const vienna = g.nodes.find((n) => n.label === '- based in Vienna');
  assert.ok(vienna && vienna.retired === false);
  // exactly one revision edge in this fixture
  assert.equal(g.edges.length, 1);
});

test('conservative pairing does NOT link two dissimilar changes in the same commit', () => {
  const c = commit('aaaaaaa', '2026-06-06 09:00:00 +0200', 'memory: distilled',
    'diff --git a/MEMORY.md b/MEMORY.md\n--- a/MEMORY.md\n+++ b/MEMORY.md\n@@ -1,2 +1,2 @@\n-- owns a red bicycle\n+- allergic to penicillin\n');
  const g = mg.buildGraph({ gitLogText: c, learnItems: [], ledger: OKLEDGER });
  assert.equal(g.edges.length, 0, 'unrelated remove/add must not be paired as a revision');
});

// ── lessons ──
test('a node whose text matches a learn-ledger ref becomes a lesson carrying {status, confidence}', () => {
  const g = mg.buildGraph({ gitLogText: DRIFT, learnItems: LEARN, ledger: OKLEDGER });
  const lesson = g.nodes.find((n) => n.kind === 'lesson');
  assert.ok(lesson, 'the LESSONS.md line matched the ledger ref');
  assert.equal(lesson.status, 'trusted');
  assert.equal(lesson.confidence, 0.82);
  assert.equal(lesson.verifyNote, 'checked across sessions');
});

test('NO fabricated proof: no node carries a per-lesson ledger seq / inclusion field', () => {
  const g = mg.buildGraph({ gitLogText: DRIFT, learnItems: LEARN, ledger: OKLEDGER });
  for (const n of g.nodes) {
    assert.ok(!('seq' in n), 'no node.seq');
    assert.ok(!('ledgerSeq' in n), 'no node.ledgerSeq');
    assert.ok(!('inclusion' in n), 'no node.inclusion');
    assert.ok(!('provable' in n), 'provability is the git sha, not a fabricated flag');
  }
});

// ── XSS inertness (verbatim preservation) ──
test('an XSS-shaped belief is preserved VERBATIM in the JSON label (rendering safety is the DOM layer, not mangling)', () => {
  const g = mg.buildGraph({ gitLogText: DRIFT, learnItems: LEARN, ledger: OKLEDGER });
  const xss = g.nodes.find((n) => n.label.indexOf('onerror') >= 0);
  assert.ok(xss, 'the crafted label survived as a node');
  assert.equal(xss.label, '"><img src=x onerror=alert(1)>');
});

// ── truncation + caps ──
test('labels are truncated to <= 200 chars server-side', () => {
  const long = '- ' + 'x'.repeat(400);
  const c = commit('bbbbbbb', '2026-06-07 09:00:00 +0200', 'memory: distilled',
    'diff --git a/MEMORY.md b/MEMORY.md\n--- a/MEMORY.md\n+++ b/MEMORY.md\n@@ -1 +1 @@\n+' + long + '\n');
  const g = mg.buildGraph({ gitLogText: c, learnItems: [], ledger: OKLEDGER });
  const n = g.nodes[0];
  assert.ok(n.label.length <= 200, 'label capped at LABEL_MAX (200)');
});

test('MAX_NODES caps the node count and sets truncated=true', () => {
  let body = 'diff --git a/MEMORY.md b/MEMORY.md\n--- /dev/null\n+++ b/MEMORY.md\n@@ -0,0 +1,600 @@\n';
  for (let i = 0; i < 600; i++) body += '+- distinct belief number ' + i + '\n';
  const c = commit('ccccccc', '2026-06-08 09:00:00 +0200', 'init: seed', body);
  const g = mg.buildGraph({ gitLogText: c, learnItems: [], ledger: OKLEDGER });
  assert.equal(g.nodes.length, mg.MAX_NODES);
  assert.equal(g.truncated, true);
  assert.ok(mg.MAX_NODES <= 400);
});

// ── ledger honesty passthrough ──
test('buildGraph passes an intact audit-chain.verify result through (ok:true + through/head)', () => {
  const g = mg.buildGraph({ gitLogText: DRIFT, learnItems: LEARN, ledger: { ok: true, through: 42, head: 'a'.repeat(64) } });
  assert.equal(g.ledger.ok, true);
  assert.equal(g.ledger.through, 42);
  assert.equal(g.ledger.head.length, 64);
});

test('a BROKEN audit-chain.verify result flows through as ledger.ok=false + brokenSeq (no recompute, honest)', () => {
  const g = mg.buildGraph({ gitLogText: DRIFT, learnItems: LEARN, ledger: { ok: false, brokenSeq: 7, reason: 'hash_mismatch' } });
  assert.equal(g.ledger.ok, false);
  assert.equal(g.ledger.brokenSeq, 7);
});

// ── never-throws on hostile / empty input ──
test('buildGraph on undefined / null / {} / garbage returns an empty graph and never throws', () => {
  for (const bad of [undefined, null, {}, 'garbage', 42, [], { gitLogText: 12345, learnItems: 'no', ledger: 7 }]) {
    let g;
    assert.doesNotThrow(() => { g = mg.buildGraph(bad); });
    assert.deepEqual(g.nodes, []);
    assert.deepEqual(g.edges, []);
    assert.equal(g.ledger.ok, false);
    assert.equal(g.truncated, false);
  }
});

test('deterministic output: two identical builds are byte-identical', () => {
  const a = JSON.stringify(mg.buildGraph({ gitLogText: DRIFT, learnItems: LEARN, ledger: OKLEDGER }));
  const b = JSON.stringify(mg.buildGraph({ gitLogText: DRIFT, learnItems: LEARN, ledger: OKLEDGER }));
  assert.equal(a, b);
});

// ── purity + origin-clean ──
const SRC = fs.readFileSync(path.join(__dirname, '..', 'memgraph.js'), 'utf8');

test('memgraph.js is pure: no fs / child_process / net / http / os require, no listener', () => {
  assert.doesNotMatch(SRC, /require\('(fs|child_process|http|https|net|os|dgram|tls)'\)/);
  assert.doesNotMatch(SRC, /\.listen\(|createServer/);
});

test('no origin-reveal comment is present and the forbidden copy marker is absent', () => {
  assert.ok(!SRC.includes('NousResearch' + '/hermes-agent'), 'no origin-reveal slug in memgraph.js');
  assert.doesNotMatch(SRC, /mirror of (hermes|openclaw)/i);
});
