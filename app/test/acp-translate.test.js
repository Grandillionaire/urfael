'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const t = require('../acp-translate');

// ── JSON-RPC framing ────────────────────────────────────────────────────────────────────────────────
test('JSON-RPC framers produce valid 2.0 envelopes; parseFramedLine is fail-soft', () => {
  assert.deepEqual(t.rpcResult(7, { a: 1 }), { jsonrpc: '2.0', id: 7, result: { a: 1 } });
  assert.deepEqual(t.rpcError(7, -32601, 'x'), { jsonrpc: '2.0', id: 7, error: { code: -32601, message: 'x' } });
  assert.deepEqual(t.rpcNotify('session/update', { s: 1 }), { jsonrpc: '2.0', method: 'session/update', params: { s: 1 } });
  assert.equal(t.parseFramedLine('not json'), null);            // garbage → null, never throws
  assert.equal(t.parseFramedLine('"a string"'), null);          // non-object → null
  assert.deepEqual(t.parseFramedLine('{"jsonrpc":"2.0","id":1}'), { jsonrpc: '2.0', id: 1 });
});

// ── initialize: minimal, text-only, no per-session MCP ────────────────────────────────────────────────
test('handleInitialize advertises a minimal text-only agent (no fs/terminal, loadSession:false, no mcp)', () => {
  const r = t.handleInitialize();
  assert.equal(r.protocolVersion, 1);
  assert.equal(r.agentCapabilities.loadSession, false);
  assert.equal(r.agentCapabilities.mcp, false);
  assert.deepEqual(r.agentCapabilities.promptCapabilities, { image: false, audio: false, embeddedContext: false });
  assert.deepEqual(r.authMethods, []);
});

// ── prompt flatten ────────────────────────────────────────────────────────────────────────────────────
test('flattenPromptBlocks collapses text blocks and drops non-text', () => {
  assert.equal(t.flattenPromptBlocks([{ type: 'text', text: 'hello' }, { type: 'image' }, { type: 'text', text: 'world' }]), 'hello\nworld');
  assert.equal(t.flattenPromptBlocks('plain'), 'plain');
  assert.equal(t.flattenPromptBlocks([]), '');
});

// ── stop reasons ──────────────────────────────────────────────────────────────────────────────────────
test('mapStopReason: normal→end_turn, abort→cancelled, brain error→refusal', () => {
  assert.equal(t.mapStopReason({ text: 'a normal answer' }), 'end_turn');
  assert.equal(t.mapStopReason({ aborted: true }), 'cancelled');
  assert.equal(t.mapStopReason({ text: '(stopped)' }), 'cancelled');
  assert.equal(t.mapStopReason({ text: '(brain unreachable — is the Urfael daemon running?)' }), 'refusal');
  assert.equal(t.mapStopReason({ text: '(timed out)' }), 'refusal');
});

// ── NDJSON line → session/update mapping ──────────────────────────────────────────────────────────────
test('a thinking delta becomes an agent_message_chunk', () => {
  const ctx = t.newPromptCtx();
  const r = t.ndjsonLineToUpdate({ kind: 'thinking', delta: 'Hello' }, ctx);
  assert.equal(r.updates.length, 1);
  assert.equal(r.updates[0].sessionUpdate, 'agent_message_chunk');
  assert.equal(r.updates[0].content.text, 'Hello');
  // a trailing space is deferred (stripSpoken trims the safe prefix) and emitted once non-space follows
  const r2 = t.ndjsonLineToUpdate({ kind: 'thinking', delta: ' world' }, ctx);
  assert.equal(r2.updates[0].content.text, ' world');
});
test('a thinking tool becomes a tool_call then a tool_call_update completed (name only)', () => {
  const ctx = t.newPromptCtx();
  const r = t.ndjsonLineToUpdate({ kind: 'thinking', tool: 'Bash' }, ctx);
  assert.equal(r.updates[0].sessionUpdate, 'tool_call');
  assert.equal(r.updates[0].title, 'Bash');
  assert.equal(r.updates[0].status, 'in_progress');
  assert.equal(r.updates[1].sessionUpdate, 'tool_call_update');
  assert.equal(r.updates[1].status, 'completed');
  assert.equal(r.updates[0].toolCallId, r.updates[1].toolCallId);
});
test('a say line (voice aside) produces no update', () => {
  assert.deepEqual(t.ndjsonLineToUpdate({ kind: 'say', text: 'On it, sir.' }, t.newPromptCtx()).updates, []);
});
test('a done line flushes the remaining answer and returns the stop reason + usage', () => {
  const ctx = t.newPromptCtx();
  t.ndjsonLineToUpdate({ kind: 'thinking', delta: 'partial' }, ctx);
  const r = t.ndjsonLineToUpdate({ kind: 'done', text: 'partial answer', model: 'sonnet', usage: { input_tokens: 5, output_tokens: 9 } }, ctx);
  assert.equal(r.updates[0].content.text, ' answer');           // only the un-emitted tail
  assert.equal(r.done.stopReason, 'end_turn');
  assert.deepEqual(r.done.usage, { input_tokens: 5, output_tokens: 9 });
});

// ── THE [SPOKEN] leak guard: feed a delta stream ONE CHAR AT A TIME; an aside must NEVER appear, even partially ──
test('[SPOKEN] aside never leaks into an emitted chunk, char-by-char, even when left open at end-of-stream', () => {
  const full = 'The answer is 42. [SPOKEN]say this aloud[/SPOKEN] Done.';
  const ctx = t.newPromptCtx();
  let emitted = '';
  for (const ch of full) {
    const r = t.ndjsonLineToUpdate({ kind: 'thinking', delta: ch }, ctx);
    for (const u of r.updates) emitted += u.content.text;
    // INVARIANT at every prefix: no aside body, no raw marker fragment
    assert.ok(!emitted.includes('say this aloud'), 'aside body leaked: ' + JSON.stringify(emitted));
    assert.ok(!/\[\/?SPOKEN/i.test(emitted), 'raw marker leaked: ' + JSON.stringify(emitted));
    assert.ok(!/\[\/?s(p(o(k(e(n)?)?)?)?)?$/i.test(emitted), 'a half-formed marker fragment leaked: ' + JSON.stringify(emitted));
  }
  // an UNTERMINATED aside at end of stream must be fully held back
  const ctx2 = t.newPromptCtx(); let e2 = '';
  for (const ch of 'visible [SPOKEN]never shown') { const r = t.ndjsonLineToUpdate({ kind: 'thinking', delta: ch }, ctx2); for (const u of r.updates) e2 += u.content.text; }
  assert.ok(!e2.includes('never shown'));
  assert.equal(e2.trim(), 'visible');
  // the done line flushes the FINAL written answer with the aside stripped
  const done = t.ndjsonLineToUpdate({ kind: 'done', text: 'The answer is 42.  Done.' }, ctx);
  assert.ok(!emitted.concat(done.updates.map((u) => u.content.text).join('')).includes('say this aloud'));
});
