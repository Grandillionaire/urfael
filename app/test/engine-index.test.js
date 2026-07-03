'use strict';
// Unit tests for the engine assembly factory — the daemon's one integration surface. Focus: adapter SELECTION
// per provider kind (the subscription path must stay on the CLI engine ⇒ null), the fail-closed no-secret path,
// and the aux-summarizer's fail-soft contract (any adapter hiccup ⇒ {ok:false} so the compactor preserves the
// window). No network: the summarizer is tested with a fake adapter.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildEngine, pickAdapter, makeSummarizer } = require('../engine/index');

test('pickAdapter: subscription anthropic (no baseUrl, auth none) ⇒ null (CLI engine owns it)', () => {
  assert.strictEqual(pickAdapter({ kind: 'anthropic', baseUrl: '', authKind: 'none' }), null);
});

test('pickAdapter: API-key anthropic cloud ⇒ the anthropic adapter', () => {
  const p = pickAdapter({ kind: 'anthropic', baseUrl: '', authKind: 'key', authEnv: 'ANTHROPIC_API_KEY' });
  assert.ok(p && p.adapter && typeof p.adapter.chat === 'function');
  assert.strictEqual(p.baseUrl, '');
});

test('pickAdapter: an openai/ollama endpoint (baseUrl set) ⇒ the openai-compatible adapter', () => {
  const p = pickAdapter({ kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1' });
  assert.ok(p && p.adapter && typeof p.adapter.chat === 'function');
  assert.strictEqual(p.baseUrl, 'http://127.0.0.1:11434/v1');
});

test('buildEngine: the subscription provider returns null so the daemon falls back to the CLI spawn', () => {
  const e = buildEngine({ entry: { kind: 'anthropic', baseUrl: '', authKind: 'none' }, model: 'sonnet', vaultDir: os.tmpdir() });
  assert.strictEqual(e, null);
});

test('buildEngine: an API-key provider with no secret fails closed (needsSecret), never builds a live engine', () => {
  const e = buildEngine({ entry: { kind: 'anthropic', authKind: 'key', authEnv: 'ANTHROPIC_API_KEY' }, secret: '', model: 'claude-x', vaultDir: os.tmpdir() });
  assert.ok(e && e.needsSecret === true);
  assert.strictEqual(e.authEnv, 'ANTHROPIC_API_KEY');
  assert.strictEqual(typeof e.run, 'undefined');
});

test('buildEngine: a wired Ollama engine exposes run() and the fail-closed toolset (shell off by default)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urf-idx-'));
  const e = buildEngine({ entry: { kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1' }, secret: 'x', model: 'llama3', vaultDir: dir });
  assert.strictEqual(typeof e.run, 'function');
  assert.strictEqual(e._adapter, 'openai');
  assert.ok(!e.toolset.defs.some((d) => d.name === 'exec_shell'));   // fail-closed default carried through the factory
  fs.rmSync(dir, { recursive: true, force: true });
});

test('makeSummarizer: renders the middle + folds in the prior summary, returns {ok, summary}', async () => {
  let seen;
  const fakeAdapter = { chat: async (opts) => { seen = opts; return { ok: true, text: 'notes: decided X' }; } };
  const sum = makeSummarizer(fakeAdapter, { baseUrl: '', apiKey: 'k', model: 'cheap' });
  const r = await sum([{ role: 'user', content: 'do X?' }, { role: 'assistant', content: 'yes', toolCalls: [{ name: 'read_file' }] }], 'earlier: talked Y');
  assert.strictEqual(r.ok, true);
  assert.match(r.summary, /decided X/);
  assert.match(seen.messages[1].content, /earlier: talked Y/);      // prior summary merged into the prompt
  assert.match(seen.messages[1].content, /called: read_file/);      // tool calls surfaced to the summarizer
  assert.strictEqual(seen.temperature, 0);
});

test('makeSummarizer: any adapter failure ⇒ {ok:false} (compactor will then preserve the window)', async () => {
  const down = { chat: async () => ({ ok: false, error: 'network' }) };
  const sum = makeSummarizer(down, { model: 'cheap', apiKey: 'k' });
  assert.deepStrictEqual(await sum([{ role: 'user', content: 'x' }], ''), { ok: false });
  const empty = { chat: async () => ({ ok: true, text: '   ' }) };
  assert.deepStrictEqual(await makeSummarizer(empty, { model: 'c', apiKey: 'k' })([{ role: 'user', content: 'x' }], ''), { ok: false });
});
