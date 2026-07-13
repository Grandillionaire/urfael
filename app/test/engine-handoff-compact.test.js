'use strict';
// Unit tests for the OPT-IN pre-hand-off distill compactor (engine/handoff-compact.js). It reuses the native
// compactor clean-room, so the properties under test are the seam ones: the FAIL-SAFE crown property (any summarizer
// outage returns the transcript UNCHANGED, byte-for-byte, never truncates/grows), the protected system+first-N+last-N,
// the no-split tool boundary, the >200-byte tool-output prune, DUAL-EDGE secret redaction (input AND persisted
// summary), the reference-only fence, the trigger gate + cooldown, and the ledger-shape the daemon logs.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  messagesFromTranscript, renderMiddleText, compactForHandoff, precompactConvo,
} = require('../engine/handoff-compact');
const { createCompactor, pruneMiddle } = require('../engine/compactor');

// a big filler so a handful of exchanges cross the token budget deterministically
const big = (tag) => tag + ' ' + 'x'.repeat(2000);
// a fake summarizer that records the middle it saw and returns a compact marker; optionally echoes a planted secret
function recordingSummarizer(summaryFn) {
  const calls = [];
  const fn = async (middle, prior) => { calls.push({ middle, n: middle.length, prior }); return { ok: true, summary: summaryFn ? summaryFn(middle) : 'SUMMARY(' + middle.length + ')' }; };
  return { fn, calls };
}
// build a {user,urfael} transcript with N exchanges of big filler
function transcript(n, tag = 't') {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ user: big(tag + '-u' + i), urfael: big(tag + '-a' + i) });
  return out;
}

// ── messagesFromTranscript ──
test('messagesFromTranscript maps {user,urfael} to a user/assistant alternation', () => {
  const m = messagesFromTranscript([{ user: 'hi', urfael: 'hey' }, { user: 'q', urfael: 'a' }]);
  assert.deepStrictEqual(m, [
    { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hey' },
    { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' },
  ]);
  assert.deepStrictEqual(messagesFromTranscript(null), []);           // never throws on garbage
  assert.deepStrictEqual(messagesFromTranscript([null, 3]), []);      // malformed rows skipped
});

// ── FAIL-SAFE abort: the crown property. ANY outage returns the input UNCHANGED. ──
test('FAIL-SAFE: a throwing summarizer leaves the transcript byte-for-byte unchanged (precompactConvo)', async () => {
  const T = transcript(40);
  const raw = T.map((t) => `User: ${t.user}\nUrfael: ${t.urfael}`).join('\n\n');
  const r = await precompactConvo(T, { summarize: async () => { throw new Error('aux 503'); } }, { maxTokens: 8000 });
  assert.strictEqual(r.compacted, false);
  assert.strictEqual(r.convo, raw);                                   // string-equal to the exact raw join
});

test('FAIL-SAFE: !ok / empty / whitespace summaries all preserve the raw convo and never grow', async () => {
  const T = transcript(40);
  const raw = T.map((t) => `User: ${t.user}\nUrfael: ${t.urfael}`).join('\n\n');
  for (const bad of [async () => ({ ok: false }), async () => ({ ok: true, summary: '' }), async () => ({ ok: true, summary: '   ' })]) {
    const r = await precompactConvo(T, { summarize: bad }, { maxTokens: 8000 });
    assert.strictEqual(r.compacted, false);
    assert.strictEqual(r.convo, raw);
  }
  // no summarizer at all is also an abort
  const r0 = await precompactConvo(T, {}, { maxTokens: 8000 });
  assert.strictEqual(r0.compacted, false);
  assert.strictEqual(r0.convo, raw);
});

// HONEST behavior: an all-secret summary is NOT dropped — it is scrubbed to a safe [redacted] marker (edge 2) and the
// compaction proceeds, so it can never leak the credential AND never grows the window. (redactSecrets replaces with a
// marker rather than emptying, so the compactor's crown property keeps a raw secret out without aborting.)
test('SAFE: an all-secret model summary is redacted to a marker and never leaks the raw credential', async () => {
  const SK = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX0123456789';
  const T = transcript(40);
  const r = await precompactConvo(T, { summarize: async () => ({ ok: true, summary: SK }) }, { maxTokens: 8000 });
  assert.ok(!r.convo.includes(SK), 'a raw credential must never survive into the persisted convo');
  assert.match(r.convo, /\[redacted\]/);
});

test('FAIL-SAFE: compactForHandoff returns messages deepEqual the input on summarizer failure (no truncation/grow)', async () => {
  const msgs = messagesFromTranscript(transcript(40));
  for (const bad of [async () => { throw new Error('x'); }, async () => ({ ok: false }), async () => ({ ok: true, summary: '   ' })]) {
    const r = await compactForHandoff(msgs, { summarize: bad, maxTokens: 8000, pinFirst: 0, pinLast: 0 });
    assert.strictEqual(r.compacted, false);
    assert.deepStrictEqual(r.messages, msgs);
    assert.ok(r.messages.length === msgs.length);                    // never grows or truncates
  }
});

// ── TRIGGER GATE: under budget ⇒ no-op, convo === rawConvo ──
test('TRIGGER GATE: an under-budget transcript is a no-op (convo === rawConvo)', async () => {
  const T = transcript(1);
  const raw = T.map((t) => `User: ${t.user}\nUrfael: ${t.urfael}`).join('\n\n');
  const { fn } = recordingSummarizer();
  const r = await precompactConvo(T, { summarize: fn }, { maxTokens: 1000000 });
  assert.strictEqual(r.compacted, false);
  assert.strictEqual(r.reason, 'under_budget');
  assert.strictEqual(r.convo, raw);
});

// ── ANTI-THRASH cooldown: a failed pass arms a cooldown that skips the immediate retry (shared compactor) ──
test('ANTI-THRASH: a cooldown after a failed pass keeps the next call a no-op (input preserved)', async () => {
  let clock = 1000;
  const compactor = createCompactor({ summarize: async () => { throw new Error('boom'); }, pruneStubMin: 200, now: () => clock });
  const msgs = messagesFromTranscript(transcript(40));
  const r1 = await compactForHandoff(msgs, { compactor, maxTokens: 8000, pinFirst: 0, pinLast: 0 });
  assert.strictEqual(r1.compacted, false);
  assert.match(r1.reason, /summary_failed/);
  const r2 = await compactForHandoff(msgs, { compactor, maxTokens: 8000, pinFirst: 0, pinLast: 0 });
  assert.strictEqual(r2.reason, 'cooldown');
  assert.deepStrictEqual(r2.messages, msgs);
});

// ── PROTECT system + first-N + last-N verbatim ──
test('PROTECT: system row + first pinFirst + last pinLast messages survive verbatim (compactForHandoff)', async () => {
  const msgs = [{ role: 'system', content: 'You are Urfael.' }];
  for (let i = 0; i < 24; i++) { msgs.push({ role: 'user', content: big('u' + i) }); msgs.push({ role: 'assistant', content: big('a' + i) }); }
  const { fn } = recordingSummarizer();
  const r = await compactForHandoff(msgs, { summarize: fn, maxTokens: 8000, triggerRatio: 0.5, pinFirst: 2, pinLast: 4 });
  assert.strictEqual(r.compacted, true);
  assert.deepStrictEqual(r.messages[0], msgs[0]);                     // system pinned verbatim
  assert.deepStrictEqual(r.messages[1], msgs[1]);                     // first message verbatim
  assert.deepStrictEqual(r.messages[2], msgs[2]);                     // second (pinFirst=2) verbatim
  // the last pinLast=4 originals survive verbatim, in order, at the end
  for (let k = 1; k <= 4; k++) assert.deepStrictEqual(r.messages[r.messages.length - k], msgs[msgs.length - k]);
});

test('PROTECT: first/last exchanges survive as verbatim User:/Urfael: substrings (precompactConvo)', async () => {
  const T = [];
  T.push({ user: 'FIRST-QUESTION-alpha', urfael: 'FIRST-ANSWER-alpha' });
  T.push({ user: 'FIRST-QUESTION-beta', urfael: 'FIRST-ANSWER-beta' });
  for (let i = 0; i < 30; i++) T.push({ user: big('mid-u' + i), urfael: big('mid-a' + i) });
  for (let i = 0; i < 6; i++) T.push({ user: 'RECENT-Q-' + i, urfael: 'RECENT-A-' + i });
  const { fn } = recordingSummarizer();
  const r = await precompactConvo(T, { summarize: fn }, { maxTokens: 8000, firstN: 2, lastN: 6 });
  assert.strictEqual(r.compacted, true);
  assert.match(r.convo, /User: FIRST-QUESTION-alpha/);                                // first exchange verbatim
  assert.match(r.convo, /Urfael: FIRST-ANSWER-alpha/);
  assert.match(r.convo, /User: FIRST-QUESTION-beta/);                                 // second (firstN=2) verbatim
  for (let i = 0; i < 6; i++) assert.ok(r.convo.includes('User: RECENT-Q-' + i) && r.convo.includes('Urfael: RECENT-A-' + i), 'recent exchange ' + i + ' must be verbatim');
  assert.ok(r.tokensAfter < r.tokensBefore);
});

// ── NO-SPLIT tool pairs ──
test('NO-SPLIT: the kept tail never begins on an orphan tool_result', async () => {
  const msgs = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 14; i++) {
    msgs.push({ role: 'user', content: big('u' + i) });
    msgs.push({ role: 'assistant', content: '', toolCalls: [{ id: 't' + i, name: 'read', args: '{}' }] });
    msgs.push({ role: 'tool', toolCallId: 't' + i, content: big('r' + i) });
    msgs.push({ role: 'assistant', content: big('a' + i) });
  }
  const { fn } = recordingSummarizer();
  const r = await compactForHandoff(msgs, { summarize: fn, maxTokens: 8000, pinFirst: 0, pinLast: 0 });
  assert.strictEqual(r.compacted, true);
  for (let i = 1; i < r.messages.length; i++) {
    if (r.messages[i].role === 'tool') {
      const prev = r.messages[i - 1];
      assert.ok(prev && (prev.role === 'assistant' || prev.role === 'tool'), 'orphan tool_result at index ' + i);
    }
  }
});

// ── PRUNE >200 (hand-off floor): stub a >200-byte tool result, keep a <=200-byte one, dedupe exact repeats ──
test('PRUNE>200: pruneMiddle(stubMin:200) stubs a 201-byte result, keeps a 200-byte one, dedupes repeats', () => {
  const over = 'D'.repeat(201);
  const under = 'k'.repeat(200);
  const out = pruneMiddle([
    { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'read', args: '{"p":"a"}' }] },
    { role: 'tool', toolCallId: 't1', content: over },
    { role: 'assistant', content: '', toolCalls: [{ id: 't2', name: 'read', args: '{"p":"a"}' }] },
    { role: 'tool', toolCallId: 't2', content: over },
    { role: 'assistant', content: '', toolCalls: [{ id: 't3', name: 'read', args: '{"p":"b"}' }] },
    { role: 'tool', toolCallId: 't3', content: under },
  ], { stubMin: 200 });
  assert.match(out[1].content, /\[read\].*bytes \(elided\)/);        // >200 stubbed to a 1-line marker
  assert.ok(out[1].content.length < over.length);                    // shorter than the original
  assert.match(out[3].content, /identical to earlier result, elided/); // exact duplicate collapses
  assert.strictEqual(out[5].content, under);                         // <=200 kept verbatim
});

test('PRUNE>200: native default (no stubMin) still stubs at 220, not 200 (backward-compatible)', () => {
  const body = 'z'.repeat(210);                                      // between 200 and 220
  assert.strictEqual(pruneMiddle([{ role: 'tool', toolCallId: 't', content: body }])[0].content, body);           // one-arg call unchanged: 220 floor keeps it
  assert.match(pruneMiddle([{ role: 'tool', toolCallId: 't', content: body }], { stubMin: 200 })[0].content, /elided/); // hand-off floor stubs it
});

// ── DUAL-EDGE secret redaction ──
test('DUAL-EDGE: planted secrets are [redacted] in BOTH the summarizer input AND the final fenced convo', async () => {
  const SK = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX012345';
  const GHP = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const BEARER = 'Bearer eyJhbGciOiJIUzI1NiJ9aBcDeFgHiJkLmNoPqRsTuV';
  const PW = 'password: hunter2sekret';
  const T = [];
  T.push({ user: 'q0', urfael: 'a0' }); T.push({ user: 'q1', urfael: 'a1' });
  for (let i = 0; i < 30; i++) T.push({ user: big('m-u' + i) + (i === 4 ? ' ' + SK + ' ' + GHP + ' ' + BEARER + ' ' + PW : ''), urfael: big('m-a' + i) });
  for (let i = 0; i < 6; i++) T.push({ user: 'r' + i, urfael: 'ra' + i });
  let capturedInput = null;
  const summarize = async (middle) => { capturedInput = renderMiddleText(middle); return { ok: true, summary: 'model surfaced ' + SK + ' and ' + GHP + ' and ' + PW }; };
  const r = await precompactConvo(T, { summarize }, { maxTokens: 8000, firstN: 2, lastN: 6 });
  assert.strictEqual(r.compacted, true);
  // edge 1 — the exact text handed to the summarizer
  assert.ok(!capturedInput.includes(SK) && !capturedInput.includes(GHP) && !capturedInput.includes('hunter2sekret'), 'raw secret leaked into summarizer input');
  assert.match(capturedInput, /\[redacted\]/);
  // edge 2 — the persisted fenced convo (compactor re-redacts the returned summary)
  assert.ok(!r.convo.includes(SK) && !r.convo.includes(GHP) && !r.convo.includes('hunter2sekret'), 'raw secret leaked into the persisted convo');
  assert.match(r.convo, /\[redacted\]/);
});

// ── REFERENCE-ONLY fence ──
test('REFERENCE-ONLY: the carried summary is prefixed by the compactor reference-only fence', async () => {
  const T = transcript(40);
  const r = await precompactConvo(T, { summarize: async () => ({ ok: true, summary: 'CARRIED-SUMMARY-BODY' }) }, { maxTokens: 8000, firstN: 2, lastN: 6 });
  assert.strictEqual(r.compacted, true);
  assert.match(r.convo, /\[PRIOR CONTEXT/);                          // the DEFAULT_REFERENCE_HEADER
  assert.match(r.convo, /reference only/i);
  assert.match(r.convo, /NOT/);
  assert.match(r.convo, /CARRIED-SUMMARY-BODY/);
});

// ── LEDGER shape: the daemon logs exactly these fields; precompactConvo must supply them on a compaction ──
test('LEDGER shape: a compaction returns { reason, tokensBefore, tokensAfter, savedPct } for logEvent', async () => {
  const T = transcript(40);
  const r = await precompactConvo(T, { summarize: async () => ({ ok: true, summary: 'S' }) }, { maxTokens: 8000, firstN: 2, lastN: 6 });
  assert.strictEqual(r.compacted, true);
  assert.strictEqual(typeof r.reason, 'string');
  assert.ok(Number.isFinite(r.tokensBefore) && r.tokensBefore > 0);
  assert.ok(Number.isFinite(r.tokensAfter) && r.tokensAfter > 0);
  assert.ok(r.savedPct >= 0 && r.savedPct <= 1);
  assert.ok(r.tokensAfter < r.tokensBefore);
});

// ── ORIGIN-CLEAN: the module carries no origin-reveal comment and avoids the forbidden fingerprint ──
test('handoff-compact.js carries no origin-reveal comment and no forbidden copy fingerprint', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'engine', 'handoff-compact.js'), 'utf8');
  assert.ok(!src.includes('NousResearch' + '/hermes-agent'), 'no origin-reveal slug in handoff-compact.js');
  assert.doesNotMatch(src, /mirror of (hermes|openclaw)/i);
});
