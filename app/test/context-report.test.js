'use strict';
// Unit tests for app/context-report.js — pure, no daemon, no I/O. Run:
//   env -u ELECTRON_RUN_AS_NODE node --test test/context-report.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const cr = require('../context-report');
const memctx = require('../memctx');
const engine = require('../engine');
const anthropic = require('../engine/anthropic-adapter');

const bytesOf = (s) => Buffer.byteLength(String(s == null ? '' : s), 'utf8');
const sumBytes = (cats) => cats.filter((c) => c.measured).reduce((n, c) => n + c.bytes, 0);

// ════════════════════════════════ ACCEPTANCE: attribution sums to total ════════════════════════════════

test('attribution sums to the measured total (bytes) and shares sum to 1', () => {
  const cats = cr.attribute({
    systemPrompt: 'You are Urfael. Be terse and honest.',
    memoryFiles: { 'MEMORY.md': 'a durable fact\nanother fact', 'USER.md': 'the owner is Maxim', 'LESSONS.md': '', 'WORKFLOW.md': 'ship over ask' },
    recallBlock: '[RECALLED MEMORY]\n• you: "x" / me: "y"\n[END RECALLED MEMORY]',
    refs: [{ name: 'notes.md', text: 'referenced file body' }],
    engine: 'cli',
  });
  const rep = cr.report({
    systemPrompt: 'You are Urfael. Be terse and honest.',
    memoryFiles: { 'MEMORY.md': 'a durable fact\nanother fact', 'USER.md': 'the owner is Maxim', 'LESSONS.md': '', 'WORKFLOW.md': 'ship over ask' },
    recallBlock: '[RECALLED MEMORY]\n• you: "x" / me: "y"\n[END RECALLED MEMORY]',
    refs: [{ name: 'notes.md', text: 'referenced file body' }],
    engine: 'cli',
  });
  // empty LESSONS.md produces NO category (only non-empty inputs are attributed)
  assert.ok(!cats.some((c) => c.category === 'LESSONS.md'), 'an empty memory file is not attributed');
  // measured bytes sum exactly to the reported total
  assert.equal(sumBytes(cats), rep.totalBytes, 'measured category bytes must sum to totalBytes');
  // measured shares sum to ~1
  const shareSum = cats.filter((c) => c.measured).reduce((n, c) => n + c.share, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9, 'measured shares sum to 1, got ' + shareSum);
  // measured token estimates sum to the reported total (consistent-by-construction)
  const tokSum = cats.filter((c) => c.measured).reduce((n, c) => n + c.estTokens, 0);
  assert.equal(tokSum, rep.totalEstTokens, 'measured est tokens sum to totalEstTokens');
});

test('per-file memory attribution names each file and carries the forget trim', () => {
  const cats = cr.attribute({ memoryFiles: [{ name: 'MEMORY.md', text: 'x'.repeat(400) }, { name: 'USER.md', text: 'y'.repeat(20) }], engine: 'cli' });
  const mem = cats.find((c) => c.category === 'MEMORY.md');
  const usr = cats.find((c) => c.category === 'USER.md');
  assert.ok(mem && usr, 'each memory file is its own category');
  assert.equal(mem.bytes, 400);
  assert.match(mem.trim, /urfael forget/, 'a fat memory file trims via `urfael forget`');
  assert.ok(mem.biggest && !usr.biggest, 'the biggest MEASURED consumer is flagged (MEMORY.md > USER.md)');
});

// ════════════════════════════════ token estimate is labelled + = chars/4 ════════════════════════════════

test('the token column is a chars/4 estimate and is labelled an estimate (never billed/exact)', () => {
  assert.equal(cr.CHARS_PER_TOKEN, 4);
  const body = 'z'.repeat(1000);
  const cats = cr.attribute({ systemPrompt: body, engine: 'native' });
  assert.equal(cats[0].estTokens, 250, '1000 chars → ~250 tokens (chars/4)');
  const rep = cr.report({ systemPrompt: body, engine: 'native' });
  assert.match(rep.note, /ESTIMATE/i, 'the report note labels the token count an estimate');
  assert.match(rep.note, /byte counts are exact/i, 'and says the byte column is exact');
});

// ════════════════════════════════ NATIVE PATH: measured, exact, end-to-end ══════════════════════════════

test('native-engine path: attributed bytes equal the EXACT toWire {system,messages} payload', () => {
  // build the same recalled-memory block the daemon would, from real memctx
  const built = memctx.buildContext({
    query: 'what did we decide about the launch date',
    turns: [{ t: '2026-07-01T10:00:00Z', user: 'we should launch on the 12th', urfael: 'noted — the 12th it is', score: 5 }],
    lessons: [],
  });
  const recallBlock = built.block;
  assert.ok(recallBlock, 'the fixture must produce a non-empty recall block');
  const system = 'You are Urfael, a security-first personal AI assistant. Be terse, direct, and honest.';
  const userText = 'remind me what the launch date is';
  const promptText = memctx.prepend(recallBlock, userText);           // recallBlock + "\n\n" + userText

  // exactly what the native anthropic adapter would send on the wire (its textual payload)
  const messages = engine.assembleMessages({ system, userText: promptText });
  const wire = anthropic.toWire(messages);
  const exactWire = bytesOf(wire.system) + wire.messages.reduce((n, m) => n + bytesOf(m.content), 0);

  // attribute from the SAME pieces: recall separated from the rest of the running turn (no double count, no gap)
  const rest = promptText.slice(recallBlock.length);                  // "\n\n" + userText → the running-window remainder
  const cats = cr.attribute({ systemPrompt: system, recallBlock, history: rest, engine: 'native' });

  assert.equal(sumBytes(cats), exactWire, 'native attribution is MEASURED from the exact bytes, no estimation');
  assert.ok(cats.some((c) => c.category === 'Recalled-memory block' && c.bytes === bytesOf(recallBlock)));
  assert.ok(!cats.some((c) => c.key === 'cli'), 'the native path owns its window — no CLI-managed remainder');
});

test('native history flattens message arrays incl. tool_use inputs and tool_result content', () => {
  const history = [
    { role: 'user', content: 'search the vault for the token' },
    { role: 'assistant', content: 'looking', toolCalls: [{ id: 't1', name: 'grep', args: '{"q":"token"}' }] },
    { role: 'tool', toolCallId: 't1', content: 'found: config/token' },
    { role: 'assistant', content: [{ type: 'text', text: 'it is in config/token' }] },
  ];
  const cats = cr.attribute({ history, engine: 'native' });
  const h = cats.find((c) => c.category === 'Running message history + tool outputs');
  assert.ok(h, 'a history category is emitted');
  const expected = bytesOf('search the vault for the token') + bytesOf('looking') + bytesOf('{"q":"token"}')
    + bytesOf('found: config/token') + bytesOf('it is in config/token');
  assert.equal(h.bytes, expected, 'tool args + tool results + text all count toward the window');
});

// ════════════════════════════════ HONESTY: the CLI remainder is named, not guessed ══════════════════════

test('CLI-engine path appends the honest "CLI-managed (not measured here)" remainder', () => {
  const cats = cr.attribute({ systemPrompt: 'sys', recallBlock: 'rc', engine: 'cli' });
  const rem = cats[cats.length - 1];
  assert.equal(rem.category, 'CLI-managed (not measured here)', 'the remainder is labelled exactly');
  assert.equal(rem.category, cr.CLI_REMAINDER);
  assert.equal(rem.measured, false);
  assert.equal(rem.bytes, null, 'the unmeasured remainder carries no fabricated byte count');
  assert.equal(rem.estTokens, null);
  assert.equal(rem.share, null);
  // and it is excluded from the measured total
  const rep = cr.report({ systemPrompt: 'sys', recallBlock: 'rc', engine: 'cli' });
  assert.equal(rep.totalBytes, bytesOf('sys') + bytesOf('rc'), 'the remainder does not inflate the measured total');
  assert.equal(rep.engine, 'cli');
});

test('engine defaults to CLI when no history is supplied, native when it is', () => {
  assert.ok(cr.attribute({ systemPrompt: 'x' }).some((c) => c.key === 'cli'), 'no history → CLI (with remainder)');
  assert.ok(!cr.attribute({ systemPrompt: 'x', history: 'running window' }).some((c) => c.key === 'cli'), 'history present → native (no remainder)');
});

// ════════════════════════════════ FAIL-CLOSED: never throws on junk ═════════════════════════════════════

test('fail-closed: junk/empty/null inputs never throw and yield a safe array', () => {
  for (const bad of [undefined, null, 0, 'str', [], { systemPrompt: 12345 }, { memoryFiles: 'not-a-map' }, { refs: 'nope' }, { history: {} }, { memoryFiles: [null, {}, { name: '' }] }]) {
    assert.doesNotThrow(() => cr.attribute(bad));
    const cats = cr.attribute(bad);
    assert.ok(Array.isArray(cats), 'always returns an array');
    for (const c of cats) { assert.ok(typeof c.category === 'string'); assert.ok(c.bytes == null || (Number.isFinite(c.bytes) && c.bytes >= 0)); }
  }
  assert.doesNotThrow(() => cr.report(null));
  assert.doesNotThrow(() => cr.lines(null, null));
  assert.doesNotThrow(() => cr.lines(cr.report({ systemPrompt: 'x' }), null));
});

test('lines() renders a readable, non-empty readout without throwing', () => {
  const rep = cr.report({ systemPrompt: 'You are Urfael', memoryFiles: { 'MEMORY.md': 'fact' }, recallBlock: 'rc', engine: 'cli' });
  const out = cr.lines(rep, { gold: (s) => s, dim: (s) => s, bold: (s) => s });
  assert.ok(Array.isArray(out) && out.length >= 3);
  assert.match(out.join('\n'), /Context breakdown/);
  assert.match(out.join('\n'), /CLI-managed \(not measured here\)/);
  assert.match(out.join('\n'), /trim:/);
});

// ════════════════════════════════ DEFAULT BYTE-IDENTICAL: read-only, no mutation ════════════════════════

test('attribute() is read-only: it never mutates the strings/objects it is handed', () => {
  const memoryFiles = { 'MEMORY.md': 'a fact', 'USER.md': 'the owner' };
  const refs = [{ name: 'n.md', text: 'ref body' }];
  const inputs = { systemPrompt: 'sys prompt', memoryFiles, recallBlock: 'the block', refs, history: 'hist', engine: 'native' };
  const snapshot = JSON.stringify(inputs);
  cr.attribute(inputs);
  cr.report(inputs);
  assert.equal(JSON.stringify(inputs), snapshot, 'inputs (incl. nested memoryFiles/refs) are untouched — the turn path stays byte-identical');
});

test('read-only over the memctx seam: reporting does not change the recalled-memory block that rides in', () => {
  const built = memctx.buildContext({
    query: 'the launch date',
    turns: [{ t: '2026-07-01T10:00:00Z', user: 'launch on the 12th', urfael: 'the 12th', score: 3 }],
    lessons: [],
  });
  const before = built.block;
  const promptBefore = memctx.prepend(before, 'what is the launch date');
  cr.report({ systemPrompt: 'sys', recallBlock: built.block, history: promptBefore.slice(before.length), engine: 'native' });
  // the assembled preamble the model would receive is unchanged by having measured it
  assert.equal(built.block, before);
  assert.equal(memctx.prepend(built.block, 'what is the launch date'), promptBefore);
});
