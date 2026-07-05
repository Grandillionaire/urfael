'use strict';
// Unit tests for the native engine loop, driven with a FAKE adapter (a scripted queue of turns) and the REAL
// fail-closed toolset over a temp vault — so the loop's contract is exercised end to end without a network or the
// `claude` binary: a plain answer, a full tool cycle (call → real tool_result → follow-up answer), the step
// bound, adapter-error fail-closed, abort mid-cycle, and compact-before-each-call.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEngine } = require('../engine/loop');
const { createToolset } = require('../engine/tools');

// a scripted adapter: hand it a list of results; each chat() shifts the next one and records the messages it saw
function scriptedAdapter(script) {
  const seen = [];
  return {
    seen,
    chat: async (opts) => {
      seen.push(opts.messages.map((m) => m.role + (m.toolCalls ? '(tc)' : '')));
      if (typeof opts.onDelta === 'function' && script[0] && script[0].text) opts.onDelta(script[0].text);
      const r = script.shift();
      return r || { ok: true, text: '', toolCalls: [], usage: { inTok: 1, outTok: 1 }, stopReason: 'stop' };
    },
  };
}
function vault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urf-loop-'));
  fs.writeFileSync(path.join(dir, 'note.md'), 'the answer is 42');
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

test('a plain answer: one model call, no tools, returns the text and appends one assistant msg', async () => {
  const v = vault();
  const adapter = scriptedAdapter([{ ok: true, text: 'hello there', toolCalls: [], usage: { inTok: 10, outTok: 3 }, stopReason: 'stop' }]);
  const deltas = [];
  const eng = createEngine({ adapter, toolset: createToolset({ vaultDir: v.dir }), model: 'm', onDelta: (t) => deltas.push(t) });
  const r = await eng.run([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'hello there');
  assert.strictEqual(r.stopReason, 'stop');
  assert.strictEqual(r.messages.at(-1).role, 'assistant');
  assert.strictEqual(r.messages.at(-1).content, 'hello there');
  assert.deepStrictEqual(deltas, ['hello there']);
  v.cleanup();
});

test('a full tool cycle: model asks for read_file, gets the REAL file body, then answers', async () => {
  const v = vault();
  const adapter = scriptedAdapter([
    { ok: true, text: 'let me check', toolCalls: [{ id: 'c1', name: 'read_file', args: '{"path":"note.md"}' }], usage: { inTok: 20, outTok: 5 }, stopReason: 'tool_calls' },
    { ok: true, text: 'The note says the answer is 42.', toolCalls: [], usage: { inTok: 30, outTok: 8 }, stopReason: 'stop' },
  ]);
  const thinking = [];
  const eng = createEngine({ adapter, toolset: createToolset({ vaultDir: v.dir }), model: 'm', onThinking: (t) => thinking.push(t) });
  const r = await eng.run([{ role: 'user', content: 'what does note.md say?' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'The note says the answer is 42.');
  // history: user, assistant(toolCalls), tool(result), assistant(final)
  const roles = r.messages.map((m) => m.role);
  assert.deepStrictEqual(roles, ['user', 'assistant', 'tool', 'assistant']);
  assert.strictEqual(r.messages[2].content, 'the answer is 42');   // the REAL tool result flowed back
  assert.strictEqual(r.messages[2].toolCallId, 'c1');
  assert.deepStrictEqual(thinking, ['· read_file']);
  assert.strictEqual(r.usage.inTok, 50);                            // usage aggregated across both calls
  v.cleanup();
});

test('a denied tool result flows back as a normal tool_result, and the model continues', async () => {
  const v = vault();
  const adapter = scriptedAdapter([
    { ok: true, text: '', toolCalls: [{ id: 'c1', name: 'read_file', args: '{"path":"../../etc/passwd"}' }], usage: {}, stopReason: 'tool_calls' },
    { ok: true, text: 'I cannot read outside the vault.', toolCalls: [], usage: {}, stopReason: 'stop' },
  ]);
  const eng = createEngine({ adapter, toolset: createToolset({ vaultDir: v.dir }), model: 'm' });
  const r = await eng.run([{ role: 'user', content: 'read /etc/passwd' }]);
  assert.strictEqual(r.ok, true);
  assert.match(r.messages[2].content, /denied/);                   // the refusal became the tool_result
  assert.strictEqual(r.text, 'I cannot read outside the vault.');
  v.cleanup();
});

test('adapter error fails the turn CLOSED (ok:false, never throws)', async () => {
  const v = vault();
  const adapter = scriptedAdapter([{ ok: false, error: 'HTTP 500', stopReason: 'error', usage: {} }]);
  const eng = createEngine({ adapter, toolset: createToolset({ vaultDir: v.dir }), model: 'm' });
  const r = await eng.run([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'HTTP 500');
  v.cleanup();
});

test('a model that loops on tools is bounded by maxSteps (no infinite loop)', async () => {
  const v = vault();
  // an adapter that ALWAYS asks for another tool call
  const adapter = { chat: async () => ({ ok: true, text: '', toolCalls: [{ id: 'c', name: 'list_dir', args: '{"path":"."}' }], usage: {}, stopReason: 'tool_calls' }) };
  const eng = createEngine({ adapter, toolset: createToolset({ vaultDir: v.dir }), model: 'm', maxSteps: 3 });
  const r = await eng.run([{ role: 'user', content: 'loop forever' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.stopReason, 'max_steps');                   // bounded stop
  v.cleanup();
});

test('abort before the first call resolves aborted', async () => {
  const v = vault();
  const ac = new AbortController(); ac.abort();
  const adapter = scriptedAdapter([{ ok: true, text: 'x', toolCalls: [], usage: {}, stopReason: 'stop' }]);
  const eng = createEngine({ adapter, toolset: createToolset({ vaultDir: v.dir }), model: 'm' });
  const r = await eng.run([{ role: 'user', content: 'hi' }], { signal: ac.signal });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stopReason, 'aborted');
  v.cleanup();
});

test('the compactor runs before the model call and its shrunk history is what the adapter sees', async () => {
  const v = vault();
  const adapter = scriptedAdapter([{ ok: true, text: 'ok', toolCalls: [], usage: {}, stopReason: 'stop' }]);
  // a compactor stub that always collapses history to a single marker message
  const compactor = { maybeCompact: async () => ({ compacted: true, messages: [{ role: 'system', content: 'COMPACTED' }], reason: 'compacted' }) };
  const eng = createEngine({ adapter, toolset: createToolset({ vaultDir: v.dir }), model: 'm', compactor });
  await eng.run([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]);
  assert.deepStrictEqual(adapter.seen[0], ['system']);             // the adapter saw the compacted history
  v.cleanup();
});

test('a compactor that throws does not break the turn (best-effort)', async () => {
  const v = vault();
  const adapter = scriptedAdapter([{ ok: true, text: 'still fine', toolCalls: [], usage: {}, stopReason: 'stop' }]);
  const compactor = { maybeCompact: async () => { throw new Error('compactor bug'); } };
  const eng = createEngine({ adapter, toolset: createToolset({ vaultDir: v.dir }), model: 'm', compactor });
  const r = await eng.run([{ role: 'user', content: 'hi' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'still fine');
  v.cleanup();
});

// ── D. deer-flow tool-call loop-detection guard ──
// an adapter that records the tool count each call was offered, then plays a scripted queue
function recordingAdapter(script) {
  const seen = [];
  return { seen, chat: async (o) => { seen.push({ tools: (o.tools || []).length }); return script.shift() || { ok: true, text: '', toolCalls: [], usage: {}, stopReason: 'stop' }; } };
}

test('loop guard: 3 identical tool calls force a final answer with tools denied (deer-flow)', async () => {
  const v = vault();
  const A = { id: 'c', name: 'list_dir', args: '{"path":"."}' };
  const adapter = recordingAdapter([
    { ok: true, text: '', toolCalls: [A], usage: {}, stopReason: 'tool_calls' },
    { ok: true, text: '', toolCalls: [A], usage: {}, stopReason: 'tool_calls' },
    { ok: true, text: '', toolCalls: [A], usage: {}, stopReason: 'tool_calls' },   // 3rd identical ⇒ trips the guard
    { ok: true, text: 'final answer after the loop was broken', toolCalls: [], usage: {}, stopReason: 'stop' },
  ]);
  const notes = [];
  const eng = createEngine({ adapter, toolset: createToolset({ vaultDir: v.dir }), model: 'm', onThinking: (t) => notes.push(t) });
  const r = await eng.run([{ role: 'user', content: 'go' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.text, 'final answer after the loop was broken');   // NOT the max_steps placeholder
  assert.strictEqual(r.stopReason, 'loop_broken');
  assert.strictEqual(adapter.seen.length, 4);
  assert.strictEqual(adapter.seen[3].tools, 0);            // the forced 4th call was offered NO tools
  assert.ok(notes.some((n) => /loop guard/i.test(n)));     // honest telemetry line
  v.cleanup();
});

test('loop guard: 2 identical + 1 different tool call does NOT trip the guard', async () => {
  const v = vault();
  const A = { id: 'c1', name: 'list_dir', args: '{"path":"."}' };
  const B = { id: 'c2', name: 'list_dir', args: '{"path":"other"}' };
  const adapter = recordingAdapter([
    { ok: true, text: '', toolCalls: [A], usage: {}, stopReason: 'tool_calls' },
    { ok: true, text: '', toolCalls: [A], usage: {}, stopReason: 'tool_calls' },
    { ok: true, text: '', toolCalls: [B], usage: {}, stopReason: 'tool_calls' },   // different args ⇒ no 3rd repeat
    { ok: true, text: 'ordinary final', toolCalls: [], usage: {}, stopReason: 'stop' },
  ]);
  const eng = createEngine({ adapter, toolset: createToolset({ vaultDir: v.dir }), model: 'm' });
  const r = await eng.run([{ role: 'user', content: 'go' }]);
  assert.strictEqual(r.text, 'ordinary final');
  assert.strictEqual(r.stopReason, 'stop');                // NOT loop_broken
  assert.ok(adapter.seen[3].tools > 0);                    // tools were never denied
  v.cleanup();
});
