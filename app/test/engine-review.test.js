'use strict';
// Unit tests for the native engine's OPT-IN self-review pass (engine/review.js + the loop hook). Driven with a
// scripted adapter (a queue of results that records each chat() opts) and the REAL fail-closed toolset over a temp
// vault — no network, no `claude` binary. Proves the four required behaviours (confirm keeps original, revise
// adopts, error keeps original, disabled makes NO extra call) plus the doctrine-critical hardening: the reviewer is
// offered ZERO tools, a reviewer's spurious tool_calls are never dispatched, review fires ONLY on a genuine answer,
// and the review call's usage is aggregated.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../engine/loop');
const { createToolset } = require('../engine/tools');
const { buildReviewMessages, parseReview, runReview } = require('../engine/review');

// a scripted adapter: hand it a list of results; each chat() shifts the next and records the FULL opts it saw so the
// review call's tools/onDelta/messages can be inspected and calls counted.
function scriptedAdapter(script) {
  const seen = [];
  return {
    seen,
    chat: async (opts) => {
      seen.push(opts);
      if (typeof opts.onDelta === 'function' && script[0] && script[0].text) opts.onDelta(script[0].text);
      const r = script.shift();
      return r || { ok: true, text: '', toolCalls: [], usage: { inTok: 1, outTok: 1 }, stopReason: 'stop' };
    },
  };
}
function vault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urf-review-'));
  fs.writeFileSync(path.join(dir, 'note.md'), 'the answer is 42');
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}
const eng = (adapter, v, extra) => createEngine({ adapter, toolset: createToolset({ vaultDir: v.dir }), model: 'm', ...(extra || {}) });

// ── the four REQUIRED behaviours ───────────────────────────────────────────
test('(a) reviewer CONFIRMS -> original answer kept, no change, exactly two adapter calls', async () => {
  const v = vault();
  const adapter = scriptedAdapter([
    { ok: true, text: 'draft', toolCalls: [], usage: { inTok: 10, outTok: 3 }, stopReason: 'stop' },
    { ok: true, text: 'CONFIRM', toolCalls: [], usage: { inTok: 5, outTok: 1 }, stopReason: 'stop' },
  ]);
  const r = await eng(adapter, v, { selfReview: true }).run([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'draft');
  assert.strictEqual(r.messages.at(-1).content, 'draft');
  assert.strictEqual(adapter.seen.length, 2);
  v.cleanup();
});

test('(b) reviewer REVISES -> revised answer adopted (text + persisted history)', async () => {
  const v = vault();
  const adapter = scriptedAdapter([
    { ok: true, text: 'draft', toolCalls: [], usage: { inTok: 10, outTok: 3 }, stopReason: 'stop' },
    { ok: true, text: 'the corrected answer', toolCalls: [], usage: { inTok: 5, outTok: 4 }, stopReason: 'stop' },
  ]);
  const r = await eng(adapter, v, { selfReview: true }).run([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'the corrected answer');
  assert.strictEqual(r.messages.at(-1).content, 'the corrected answer');
  assert.strictEqual(r.messages.at(-1).role, 'assistant');
  assert.strictEqual(adapter.seen.length, 2);
  v.cleanup();
});

test('(c) reviewer ERRORS -> original kept, turn still succeeds (never throws)', async () => {
  const v = vault();
  const adapter = scriptedAdapter([
    { ok: true, text: 'good', toolCalls: [], usage: {}, stopReason: 'stop' },
    { ok: false, error: 'HTTP 500', toolCalls: [], usage: {}, stopReason: 'error' },
  ]);
  const r = await eng(adapter, v, { selfReview: true }).run([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'good');
  v.cleanup();
});

test('(d) DISABLED (no cfg.selfReview) -> NO extra adapter call, byte-identical answer', async () => {
  const v = vault();
  const adapter = scriptedAdapter([{ ok: true, text: 'x', toolCalls: [], usage: {}, stopReason: 'stop' }]);
  const r = await eng(adapter, v).run([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(adapter.seen.length, 1);
  assert.strictEqual(r.text, 'x');
  v.cleanup();
});

// ── hardening ──────────────────────────────────────────────────────────────
test('(e) reviewer returns whitespace -> original kept', async () => {
  const v = vault();
  const adapter = scriptedAdapter([
    { ok: true, text: 'answer', toolCalls: [], usage: {}, stopReason: 'stop' },
    { ok: true, text: '   \n\t ', toolCalls: [], usage: {}, stopReason: 'stop' },
  ]);
  const r = await eng(adapter, v, { selfReview: true }).run([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(r.text, 'answer');
  v.cleanup();
});

test('(f) reviewer echoes the original (differs only by surrounding whitespace) -> NOT a revision', async () => {
  const v = vault();
  const adapter = scriptedAdapter([
    { ok: true, text: 'answer', toolCalls: [], usage: {}, stopReason: 'stop' },
    { ok: true, text: '  answer  ', toolCalls: [], usage: {}, stopReason: 'stop' },
  ]);
  const r = await eng(adapter, v, { selfReview: true }).run([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(r.text, 'answer');
  assert.strictEqual(r.messages.at(-1).content, 'answer');
  v.cleanup();
});

test('(g) NARROW-ONLY: the review call is offered tools:[] and is NOT streamed (no onDelta); its request has no tool rows', async () => {
  const v = vault();
  const adapter = scriptedAdapter([
    { ok: true, text: 'draft', toolCalls: [], usage: {}, stopReason: 'stop' },
    { ok: true, text: 'CONFIRM', toolCalls: [], usage: {}, stopReason: 'stop' },
  ]);
  await eng(adapter, v, { selfReview: true }).run([{ role: 'user', content: 'hi' }]);
  const answerOpts = adapter.seen[0];
  const reviewOpts = adapter.seen[1];
  assert.ok(Array.isArray(answerOpts.tools) && answerOpts.tools.length > 0, 'the answering call was offered the real toolset');
  assert.ok(Array.isArray(reviewOpts.tools) && reviewOpts.tools.length === 0, 'the reviewer is offered an EMPTY tool array');
  assert.strictEqual(typeof reviewOpts.onDelta, 'undefined', 'the critique is not streamed to the HUD');
  assert.ok(reviewOpts.messages.every((m) => !m.toolCalls && m.role !== 'tool'), 'the review request carries no tool_use/tool_result');
  v.cleanup();
});

test('(h) a reviewer returning spurious tool_calls is INERT: no dispatch, no extra call, adoption follows only res.text', async () => {
  const v = vault();
  const adapter = scriptedAdapter([
    { ok: true, text: 'draft', toolCalls: [], usage: {}, stopReason: 'stop' },
    { ok: true, text: 'revised body', toolCalls: [{ id: 'x', name: 'write_file', args: '{"path":"pwn.md","content":"x"}' }], usage: {}, stopReason: 'tool_calls' },
  ]);
  const r = await eng(adapter, v, { selfReview: true }).run([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(adapter.seen.length, 2);                  // no tool loop spawned by the review call
  assert.strictEqual(r.text, 'revised body');                  // adoption comes from res.text, not the tool_call
  assert.ok(!fs.existsSync(path.join(v.dir, 'pwn.md')), 'the reviewer-returned write_file was NEVER dispatched');
  assert.ok(r.messages.every((m) => m.role !== 'tool'), 'no tool row from the review leaked into the durable history');
  v.cleanup();
});

test('(i1) a model that ALWAYS calls tools hits max_steps and is NOT reviewed (no extra call, only the real toolset)', async () => {
  const v = vault();
  const adapter = { seen: [], chat: async (opts) => { adapter.seen.push(opts); return { ok: true, text: '', toolCalls: [{ id: 'c', name: 'list_dir', args: '{"path":"."}' }], usage: {}, stopReason: 'tool_calls' }; } };
  const r = await createEngine({ adapter, toolset: createToolset({ vaultDir: v.dir }), model: 'm', maxSteps: 3, selfReview: true }).run([{ role: 'user', content: 'loop' }]);
  assert.strictEqual(r.stopReason, 'max_steps');
  assert.strictEqual(adapter.seen.length, 3);                  // exactly maxSteps — NO extra review call
  assert.ok(adapter.seen.every((o) => Array.isArray(o.tools) && o.tools.length > 0), 'never the empty review tool-set');
  v.cleanup();
});

test('(i2) a first-call adapter error skips review (ok:false, exactly one call)', async () => {
  const v = vault();
  const adapter = scriptedAdapter([{ ok: false, error: 'HTTP 500', toolCalls: [], usage: {}, stopReason: 'error' }]);
  const r = await eng(adapter, v, { selfReview: true }).run([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(adapter.seen.length, 1);
  v.cleanup();
});

test('(i3) an aborted signal skips review entirely (no calls at all)', async () => {
  const v = vault();
  const ac = new AbortController(); ac.abort();
  const adapter = scriptedAdapter([{ ok: true, text: 'x', toolCalls: [], usage: {}, stopReason: 'stop' }]);
  const r = await eng(adapter, v, { selfReview: true }).run([{ role: 'user', content: 'hi' }], { signal: ac.signal });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stopReason, 'aborted');
  assert.strictEqual(adapter.seen.length, 0);
  v.cleanup();
});

test('(j) the review call usage is aggregated into r.usage (both confirm and answer tokens counted)', async () => {
  const v = vault();
  const adapter = scriptedAdapter([
    { ok: true, text: 'draft', toolCalls: [], usage: { inTok: 10, outTok: 3 }, stopReason: 'stop' },
    { ok: true, text: 'CONFIRM', toolCalls: [], usage: { inTok: 7, outTok: 2 }, stopReason: 'stop' },
  ]);
  const r = await eng(adapter, v, { selfReview: true }).run([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(r.usage.inTok, 17);
  assert.strictEqual(r.usage.outTok, 5);
  v.cleanup();
});

test('an empty final answer is NOT reviewed (nothing to critique)', async () => {
  const v = vault();
  const adapter = scriptedAdapter([{ ok: true, text: '', toolCalls: [], usage: {}, stopReason: 'stop' }]);
  const r = await eng(adapter, v, { selfReview: true }).run([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(r.text, '');
  assert.strictEqual(adapter.seen.length, 1);                  // finalText '' is falsy -> block skipped
  v.cleanup();
});

// ── pure helpers ─────────────────────────────────────────────────────────────
test('parseReview: CONFIRM sentinel (leading + whole-reply), empty, identical, and a real rewrite', () => {
  assert.strictEqual(parseReview('CONFIRM', 'orig').revised, false);
  assert.strictEqual(parseReview('CONFIRM.', 'orig').revised, false);
  assert.strictEqual(parseReview('  CONFIRM \n', 'orig').revised, false);
  assert.strictEqual(parseReview('CONFIRM: looks correct', 'orig').revised, false);
  assert.strictEqual(parseReview('', 'orig').revised, false);
  assert.strictEqual(parseReview('   ', 'orig').revised, false);
  assert.strictEqual(parseReview('orig', 'orig').revised, false);
  assert.strictEqual(parseReview('  orig  ', 'orig').revised, false);
  const rev = parseReview('a better answer', 'orig');
  assert.strictEqual(rev.revised, true);
  assert.strictEqual(rev.text, 'a better answer');
  // "CONFIRMED" is a WORD, not the sentinel — treated as a (revised) reply, per the documented heuristic
  assert.strictEqual(parseReview('CONFIRMED and here is more', 'orig').revised, true);
});

test('parseReview never throws on non-string input and always returns a boolean revised', () => {
  for (const bad of [null, undefined, 42, {}, [], true, NaN]) {
    const r = parseReview(bad, 'orig');
    assert.strictEqual(typeof r.revised, 'boolean');
    assert.strictEqual(r.revised, false);
  }
  assert.strictEqual(typeof parseReview('x', null).revised, 'boolean');
  assert.strictEqual(typeof parseReview('x', 42).revised, 'boolean');
});

test('buildReviewMessages: leading system preserved; shape is [system..., one user]; no tool rows / no toolCalls; sections embedded', () => {
  const messages = [
    { role: 'system', content: 'SYS-CONSTITUTION' },
    { role: 'user', content: 'the-request' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', args: '{}' }] },
    { role: 'tool', toolCallId: 'c1', content: 'EVIDENCE-BODY' },
    { role: 'assistant', content: 'the-answer' },
  ];
  const out = buildReviewMessages(messages, 'the-answer');
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].role, 'system');
  assert.strictEqual(out[0].content, 'SYS-CONSTITUTION');
  assert.strictEqual(out[1].role, 'user');
  assert.ok(out.every((m) => !m.toolCalls && m.role !== 'tool'), 'both-adapter shape safety: no tool_use/tool_result');
  assert.match(out[1].content, /the-request/);
  assert.match(out[1].content, /EVIDENCE-BODY/);
  assert.match(out[1].content, /the-answer/);
});

test('buildReviewMessages: bounds the tool evidence (a runaway tool result cannot dominate the prompt)', () => {
  const huge = 'Z'.repeat(50000);
  const out = buildReviewMessages([{ role: 'user', content: 'q' }, { role: 'tool', content: huge }], 'ans');
  // no leading system row here, so the single user message is the whole output; its evidence is capped under raw 50k
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out.at(-1).role, 'user');
  assert.ok(out.at(-1).content.length < 20000, 'evidence digest is bounded');
});

test('buildReviewMessages never throws on garbage and always yields a trailing user message', () => {
  for (const bad of [null, undefined, 42, 'str', {}, [{}], [{ role: 'x' }], [null, undefined]]) {
    const out = buildReviewMessages(bad, 'ans');
    assert.ok(Array.isArray(out) && out.length >= 1);
    assert.strictEqual(out.at(-1).role, 'user');
  }
});

test('runReview: a confirm keeps the original, still reports usage, and offers zero tools + temperature 0 + no onDelta', async () => {
  const seen = [];
  const adapter = { chat: async (opts) => { seen.push(opts); return { ok: true, text: 'CONFIRM', usage: { inTok: 4, outTok: 1 }, stopReason: 'stop' }; } };
  const rv = await runReview({ adapter, model: 'm', baseUrl: '', apiKey: 'k' }, [{ role: 'user', content: 'q' }], 'orig', {});
  assert.strictEqual(rv.revised, false);
  assert.strictEqual(rv.text, 'orig');
  assert.deepStrictEqual(seen[0].tools, []);
  assert.strictEqual(seen[0].temperature, 0);
  assert.strictEqual(typeof seen[0].onDelta, 'undefined');
  assert.strictEqual(rv.usage.inTok, 4);
});

test('runReview: a genuine rewrite is adopted', async () => {
  const adapter = { chat: async () => ({ ok: true, text: 'better', usage: { inTok: 1, outTok: 1 }, stopReason: 'stop' }) };
  const rv = await runReview({ adapter, model: 'm' }, [{ role: 'user', content: 'q' }], 'orig', {});
  assert.strictEqual(rv.revised, true);
  assert.strictEqual(rv.text, 'better');
});

test('runReview: an adapter that throws is caught and keeps the original (never rejects)', async () => {
  const adapter = { chat: async () => { throw new Error('boom'); } };
  const rv = await runReview({ adapter, model: 'm' }, [{ role: 'user', content: 'q' }], 'orig', {});
  assert.strictEqual(rv.revised, false);
  assert.strictEqual(rv.text, 'orig');
});

test('runReview: a missing/invalid adapter keeps the original (no throw)', async () => {
  for (const cfg of [{}, { adapter: null }, { adapter: {} }, { adapter: { chat: 5 } }]) {
    const rv = await runReview(cfg, [{ role: 'user', content: 'q' }], 'orig', {});
    assert.strictEqual(rv.revised, false);
    assert.strictEqual(rv.text, 'orig');
  }
});
