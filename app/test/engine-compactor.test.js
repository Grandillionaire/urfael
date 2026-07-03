'use strict';
// Unit tests for the native-engine compactor. The properties that matter are the SAFETY ones borrowed from
// Hermes: the kept tail is always a valid history (never starts on an orphan tool_result), the leading system
// prompt is never summarized away, the prior summary is folded in on each pass (iterative merge), a weak
// compaction backs off (anti-thrash), and — the load-bearing one — a summarizer that throws returns the window
// UNCHANGED (fail-safe abort) instead of destroying context.
const { test } = require('node:test');
const assert = require('node:assert');
const { createCompactor, alignTailStart, countLeadingSystem } = require('../engine/compactor');

// a big filler string so a handful of messages cross the token budget deterministically
const big = (tag) => tag + ' ' + 'x'.repeat(2000);
function convo(nPairs) {
  const m = [{ role: 'system', content: 'You are Urfael.' }];
  for (let i = 0; i < nPairs; i++) { m.push({ role: 'user', content: big('u' + i) }); m.push({ role: 'assistant', content: big('a' + i) }); }
  return m;
}
// a summarizer that records what it saw and echoes a compact marker + the prior summary it was given
function fakeSummarizer() {
  const calls = [];
  const fn = async (middle, prior) => { calls.push({ n: middle.length, prior }); return { ok: true, summary: 'SUMMARY(' + middle.length + ' msgs)' + (prior ? ' [merged:' + prior.slice(0, 12) + ']' : '') }; };
  return { fn, calls };
}

test('alignTailStart: advances past leading orphan tool_results only', () => {
  const m = [{ role: 'assistant' }, { role: 'tool' }, { role: 'tool' }, { role: 'user' }];
  assert.strictEqual(alignTailStart(m, 1), 3);          // skip the two tool messages
  assert.strictEqual(alignTailStart(m, 3), 3);          // already clean
  assert.strictEqual(alignTailStart(m, 0), 0);          // assistant is a fine tail start
});

test('under budget ⇒ no compaction', async () => {
  const { fn } = fakeSummarizer();
  const c = createCompactor({ summarize: fn });
  const r = await c.maybeCompact(convo(1), { maxTokens: 100000 });
  assert.strictEqual(r.compacted, false);
  assert.strictEqual(r.reason, 'under_budget');
});

test('over budget ⇒ compacts, pins the system head, keeps a recent tail, actually shrinks', async () => {
  const { fn, calls } = fakeSummarizer();
  const c = createCompactor({ summarize: fn });
  const msgs = convo(20);                                // ~20*2 big messages, well over budget
  const r = await c.maybeCompact(msgs, { maxTokens: 8000, tailTokenBudget: 3000 });
  assert.strictEqual(r.compacted, true);
  assert.ok(r.tokensAfter < r.tokensBefore);
  assert.ok(r.savedPct > 0);
  assert.strictEqual(r.messages[0].role, 'system');     // head pinned
  assert.strictEqual(r.messages[0].content, 'You are Urfael.');
  assert.match(r.messages[1].content, /reference only/i);  // the fence
  assert.match(r.messages[1].content, /SUMMARY\(/);        // the summary body
  assert.strictEqual(calls.length, 1);
  // the LAST original message is still present verbatim in the tail
  assert.strictEqual(r.messages[r.messages.length - 1].content, msgs[msgs.length - 1].content);
});

test('tool pairs: the kept tail never begins on an orphan tool_result', async () => {
  const { fn } = fakeSummarizer();
  const c = createCompactor({ summarize: fn });
  // build a history where the natural token boundary would fall right on a tool_result
  const m = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 12; i++) {
    m.push({ role: 'user', content: big('u' + i) });
    m.push({ role: 'assistant', content: '', toolCalls: [{ id: 't' + i, name: 'read', args: '{}' }] });
    m.push({ role: 'tool', toolCallId: 't' + i, content: big('r' + i) });
    m.push({ role: 'assistant', content: big('a' + i) });
  }
  const r = await c.maybeCompact(m, { maxTokens: 8000, tailTokenBudget: 2500 });
  assert.strictEqual(r.compacted, true);
  // the first message AFTER head + summary (i.e. the start of the kept tail) must not be a tool_result
  const tailStart = r.messages[2];
  assert.notStrictEqual(tailStart.role, 'tool');
  // and no tool_result in the whole result lacks a preceding assistant toolCalls
  for (let i = 1; i < r.messages.length; i++) {
    if (r.messages[i].role === 'tool') {
      const prev = r.messages[i - 1];
      assert.ok(prev && (prev.role === 'assistant' || prev.role === 'tool'), 'orphan tool_result at ' + i);
    }
  }
});

test('iterative merge: the SECOND compaction is handed the FIRST summary', async () => {
  const { fn, calls } = fakeSummarizer();
  const c = createCompactor({ summarize: fn });
  const first = await c.maybeCompact(convo(20), { maxTokens: 8000, tailTokenBudget: 3000 });
  assert.strictEqual(first.compacted, true);
  assert.strictEqual(calls[0].prior, '');               // first pass: no prior
  // grow the history again on top of the compacted result and compact once more
  const grown = [...first.messages];
  for (let i = 0; i < 20; i++) { grown.push({ role: 'user', content: big('nu' + i) }); grown.push({ role: 'assistant', content: big('na' + i) }); }
  const second = await c.maybeCompact(grown, { maxTokens: 8000, tailTokenBudget: 3000 });
  assert.strictEqual(second.compacted, true);
  assert.ok(calls[1].prior.startsWith('SUMMARY('));      // prior summary folded in
  assert.match(second.messages[1].content, /merged:/);   // the merge is visible in the new summary
});

test('FAIL-SAFE: a throwing summarizer returns the window UNCHANGED and arms a cooldown', async () => {
  let clock = 1000;
  const c = createCompactor({ summarize: async () => { throw new Error('aux model 503'); }, now: () => clock });
  const msgs = convo(20);
  const r = await c.maybeCompact(msgs, { maxTokens: 8000, tailTokenBudget: 3000, cooldownMs: 5000 });
  assert.strictEqual(r.compacted, false);
  assert.match(r.reason, /summary_failed/);
  assert.strictEqual(r.messages, msgs);                  // SAME array — nothing was mutated or dropped
  // cooldown is armed: an immediate retry is skipped even though we're over budget
  const r2 = await c.maybeCompact(msgs, { maxTokens: 8000, tailTokenBudget: 3000 });
  assert.strictEqual(r2.reason, 'cooldown');
  clock += 6000;                                          // past the cooldown
  const r3 = await c.maybeCompact(msgs, { maxTokens: 8000, tailTokenBudget: 3000, cooldownMs: 5000 });
  assert.match(r3.reason, /summary_failed/);              // tries again after cooldown
});

test('FAIL-SAFE: a not-ok / empty summary is treated as failure (window preserved)', async () => {
  const c = createCompactor({ summarize: async () => ({ ok: false }) });
  const r = await c.maybeCompact(convo(20), { maxTokens: 8000, tailTokenBudget: 3000 });
  assert.strictEqual(r.compacted, false);
  assert.strictEqual(r.reason, 'summary_failed');
  const c2 = createCompactor({ summarize: async () => ({ ok: true, summary: '   ' }) });
  const r2 = await c2.maybeCompact(convo(20), { maxTokens: 8000, tailTokenBudget: 3000 });
  assert.strictEqual(r2.reason, 'summary_failed');
});

test('anti-thrash: a compaction that frees too little raises a backoff cooldown', async () => {
  let clock = 0;
  // a summarizer that returns a summary nearly as big as the middle → weak savings
  const c = createCompactor({ summarize: async (middle) => ({ ok: true, summary: 'x'.repeat(middle.length * 1800) }), now: () => clock });
  const r = await c.maybeCompact(convo(20), { maxTokens: 8000, tailTokenBudget: 3000, minSavingsPct: 0.5, cooldownMs: 1000 });
  // either it compacted with low savings (counter up) or refused as too-large; both must arm a cooldown
  assert.ok(c.state.cooldownUntil > 0, 'a weak/ineffective compaction must arm a cooldown');
});

test('summary larger than the original ⇒ abort, keep original', async () => {
  const c = createCompactor({ summarize: async () => ({ ok: true, summary: 'y'.repeat(500000) }) });
  const r = await c.maybeCompact(convo(20), { maxTokens: 8000, tailTokenBudget: 3000 });
  assert.strictEqual(r.compacted, false);
  assert.strictEqual(r.reason, 'summary_too_large');
});

test('countLeadingSystem counts only the leading run', () => {
  assert.strictEqual(countLeadingSystem([{ role: 'system' }, { role: 'system' }, { role: 'user' }, { role: 'system' }]), 2);
});
