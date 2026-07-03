'use strict';
// Regression tests for the adversarial-review findings on the native engine (commit 831ea4a review). Each test
// reproduces the finding's failure scenario and asserts it is now closed. Named by finding so a future regression
// points straight back to the review.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const openai = require('../engine/openai-adapter');
const anthropic = require('../engine/anthropic-adapter');
const { createToolset } = require('../engine/tools');
const { createCompactor } = require('../engine/compactor');
const { createEngine } = require('../engine/loop');

// ---- F1 (HIGH): a malformed API key must not REJECT the promise (never-reject contract) ----------

test('F1: an API key with a trailing newline resolves {ok:false}, never rejects (openai + anthropic)', async () => {
  // if either rejected, the await would throw and fail the test
  const r1 = await openai.chat({ baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-abc\n', messages: [{ role: 'user', content: 'x' }], timeoutMs: 2000 });
  assert.strictEqual(r1.ok, false);
  const r2 = await anthropic.chat({ baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'sk-ant\n', messages: [{ role: 'user', content: 'x' }], timeoutMs: 2000 });
  assert.strictEqual(r2.ok, false);
});

test('F1: a content value that throws on stringify still resolves {ok:false}', async () => {
  const nasty = { toString() { throw new Error('boom'); } };
  const r = await openai.chat({ baseUrl: 'https://api.example.com/v1', model: 'm', messages: [{ role: 'user', content: nasty }], timeoutMs: 2000 });
  assert.strictEqual(r.ok, false);
});

test('F1 (loop): an adapter that throws SYNCHRONOUSLY is caught by the loop, never escapes run()', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urf-f1-'));
  const eng = createEngine({ adapter: { chat: () => { throw new Error('sync boom'); } }, toolset: createToolset({ vaultDir: dir }), model: 'm' });
  const r = await eng.run([{ role: 'user', content: 'hi' }]);   // must not throw
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /sync boom/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- F2 (HIGH): compaction must never emit consecutive user messages (Anthropic 400) -------------

test('F2: across tail-budget boundaries, the compacted history never has two consecutive user messages', async () => {
  const big = (t) => t + ' ' + 'x'.repeat(2000);
  const summarize = async (middle) => ({ ok: true, summary: 'S(' + middle.length + ')' });
  for (const tb of [1500, 2000, 2500, 3000, 3500, 4000]) {
    const c = createCompactor({ summarize });
    const msgs = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 25; i++) { msgs.push({ role: 'user', content: big('u' + i) }); msgs.push({ role: 'assistant', content: big('a' + i) }); }
    const r = await c.maybeCompact(msgs, { maxTokens: 8000, tailTokenBudget: tb });
    if (!r.compacted) continue;
    for (let i = 1; i < r.messages.length; i++) {
      assert.ok(!(r.messages[i].role === 'user' && r.messages[i - 1].role === 'user'), `consecutive user at tb=${tb}, idx=${i}`);
    }
    // and the fold is real: when the tail began on a user turn, the summary rode INTO it (fence header present there)
    const firstAfterHead = r.messages[1];
    assert.match(firstAfterHead.content, /reference only/i);
    // the merged message round-trips through the Anthropic wire as a single user message (valid alternation)
    const { messages: wire } = anthropic.toWire(r.messages);
    for (let i = 1; i < wire.length; i++) assert.ok(!(wire[i].role === 'user' && wire[i - 1].role === 'user'), `wire adjacency at tb=${tb}`);
  }
});

// ---- F3 (MEDIUM): realDeepest must fail CLOSED, defeating the deep-path symlink escape ------------

test('F3: the reviewer\'s deep-path symlink escape (70 components through an in-vault symlink) is DENIED', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'urf-f3-'));
  const vault = path.join(base, 'vault'); fs.mkdirSync(vault);
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
  let ok = true; try { fs.symlinkSync(outside, path.join(vault, 'link')); } catch { ok = false; }
  if (!ok) { fs.rmSync(base, { recursive: true, force: true }); return; }
  const ts = createToolset({ vaultDir: vault });
  const deep = 'link/' + Array.from({ length: 70 }, (_, i) => 'd' + i).join('/') + '/PWNED.txt';
  const r = await ts.dispatch('write_file', { path: deep, content: 'ESCAPED' });
  assert.match(r, /denied/);                                   // caught by realpath-through-the-symlink now that budget > 70
  assert.ok(!fs.existsSync(path.join(outside, 'd0')));         // nothing landed outside
  fs.rmSync(base, { recursive: true, force: true });
});

test('F3: a pathologically deep (>budget) non-existent path fails CLOSED, not open', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urf-f3b-'));
  const ts = createToolset({ vaultDir: dir });
  const insane = Array.from({ length: 5000 }, () => 'd').join('/') + '/x.txt';
  const r = await ts.dispatch('write_file', { path: insane, content: 'y' });
  assert.match(r, /denied.*(unresolvable|fail-closed)/);       // budget-exhaustion returns null → guard denies
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- F5 (MED-LOW): the adapter isLoopback agrees with the registry on 0.0.0.0 -------------------

test('F5: 0.0.0.0 is accepted by the adapter endpoint rule (matches the registry gate)', () => {
  assert.ok(openai.endpointFor('http://0.0.0.0:11434/v1'));    // a provider that registered with 0.0.0.0 now resolves
  assert.strictEqual(openai.isLoopback('0.0.0.0'), true);
});

// ---- F7 (LOW): exec_shell output is length-capped like read_file --------------------------------

test('F7: a huge shell stdout is truncated, not fed unbounded into the history', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urf-f7-'));
  const huge = 'A'.repeat(2 * 1024 * 1024);
  const ts = createToolset({ vaultDir: dir, allowShell: true, runShell: async () => ({ exitCode: 0, out: huge }) });
  const r = await ts.dispatch('exec_shell', { command: 'cat big' });
  assert.ok(r.length < huge.length);
  assert.match(r, /truncated/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- F9 (LOW): max_steps surfaces a visible note, not an empty answer ----------------------------

test('F9: hitting maxSteps returns a non-empty explanatory text (not a silent empty answer)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urf-f9-'));
  const adapter = { chat: async () => ({ ok: true, text: '', toolCalls: [{ id: 'c', name: 'list_dir', args: '{"path":"."}' }], usage: {}, stopReason: 'tool_calls' }) };
  const eng = createEngine({ adapter, toolset: createToolset({ vaultDir: dir }), model: 'm', maxSteps: 2 });
  const r = await eng.run([{ role: 'user', content: 'loop' }]);
  assert.strictEqual(r.stopReason, 'max_steps');
  assert.ok(r.text && r.text.length > 0);
  assert.match(r.text, /tool steps/);
  assert.strictEqual(r.steps, 2);                              // steps reported accurately (dead ternary removed)
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- F10 (INFO): an empty HOME de-anchors nothing (deny-globs skipped, allowlist still holds) ----

test('F10: with no configured root the toolset denies regardless (allowlist is the primary boundary)', async () => {
  const ts = createToolset({});   // no vault → allowlist empty → everything denied even if deny-globs were skipped
  assert.match(await ts.dispatch('read_file', { path: '/etc/passwd' }), /no file root/);
});
