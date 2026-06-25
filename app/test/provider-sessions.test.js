'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const ps = require('../provider-sessions');
const providers = require('../providers');

// ── sessionKey: stability + the cross-provider collision fix ────────────────────────────────────────
test('sessionKey is stable and deterministic', () => {
  assert.strictEqual(ps.sessionKey('sonnet', 'claude'), ps.sessionKey('sonnet', 'claude'));
});

test('sessionKey does NOT collide two providers exposing the same model', () => {
  // the bug this pillar fixes: subscription 'sonnet' vs an OpenRouter-backed 'sonnet' must get separate buckets.
  assert.notStrictEqual(ps.sessionKey('sonnet', 'claude'), ps.sessionKey('sonnet', 'openrouter'));
});

test('sessionKey distinguishes same model via different methods (API vs subscription)', () => {
  assert.notStrictEqual(ps.sessionKey('opus', 'claude'), ps.sessionKey('opus', 'claude-bedrock'));
});

test('sessionKey is length-prefixed so adjacent fields cannot alias', () => {
  // without length-prefixing, ('a','bc') and ('ab','c') could both stringify to a shared form.
  assert.notStrictEqual(ps.sessionKey('bc', 'a'), ps.sessionKey('c', 'ab'));
});

test('sessionKey normalizes a missing providerId without throwing', () => {
  assert.strictEqual(typeof ps.sessionKey('sonnet'), 'string');
  assert.strictEqual(ps.sessionKey('sonnet', ''), ps.sessionKey('sonnet', null));
});

// ── loadProviderRegistry: reuses providers.js parsing ───────────────────────────────────────────────
test('loadProviderRegistry loads the bundled registry (same shape as providers.load)', () => {
  const list = ps.loadProviderRegistry();
  assert.ok(Array.isArray(list) && list.length >= 8, 'expected the curated set');
  for (const e of list) {
    assert.match(e.id, /^[a-z0-9-]+$/);
    assert.ok(providers.KINDS.has(e.kind));
  }
  // identical to providers.load() — it is a pure delegation.
  assert.strictEqual(list.length, providers.load().length);
});

test('loadProviderRegistry fail-soft returns [] for a missing path', () => {
  assert.deepStrictEqual(ps.loadProviderRegistry('/no/such/providers.json'), []);
});

test('findProvider resolves a known id and rejects an unknown one', () => {
  const list = ps.loadProviderRegistry();
  assert.ok(ps.findProvider(list, 'claude'));
  assert.strictEqual(ps.findProvider(list, 'does-not-exist'), null);
});

// ── resolveScopedEnv: child-only env, baseEnv never mutated, secret never leaks back ────────────────
test('resolveScopedEnv overlays routing onto a NEW object and never mutates baseEnv', () => {
  const list = ps.loadProviderRegistry();
  const openai = providers.find(list, 'openai');           // key-auth, custom baseUrl
  const baseEnv = { PATH: '/usr/bin', HOME: '/home/me' };
  const env = ps.resolveScopedEnv(baseEnv, openai, 'sk-secret-123');
  // base keys carried through
  assert.strictEqual(env.PATH, '/usr/bin');
  // routing applied for the child
  assert.strictEqual(env.ANTHROPIC_BASE_URL, openai.baseUrl);
  // the original baseEnv is untouched — the daemon's own process env never gains routing or the secret
  assert.deepStrictEqual(baseEnv, { PATH: '/usr/bin', HOME: '/home/me' });
  assert.strictEqual('ANTHROPIC_BASE_URL' in baseEnv, false);
});

test('resolveScopedEnv puts the secret ONLY on the child env, under the provider authEnv', () => {
  const list = ps.loadProviderRegistry();
  const openai = providers.find(list, 'openai');           // authEnv defaults to ANTHROPIC_AUTH_TOKEN
  const baseEnv = {};
  const env = ps.resolveScopedEnv(baseEnv, openai, 'sk-secret-xyz');
  assert.strictEqual(env[openai.authEnv], 'sk-secret-xyz');
  // never written back to baseEnv
  assert.strictEqual(baseEnv[openai.authEnv], undefined);
});

test('resolveScopedEnv clears a prior provider\'s routing vars (no cross-chat leak)', () => {
  const list = ps.loadProviderRegistry();
  const claude = providers.find(list, 'claude');           // native cloud, no baseUrl
  // simulate a base env that still carries a previous provider's endpoint + secret
  const dirty = { PATH: '/bin', ANTHROPIC_BASE_URL: 'https://leftover.example', ANTHROPIC_AUTH_TOKEN: 'old-secret' };
  const env = ps.resolveScopedEnv(dirty, claude, '');
  // every MANAGED var is cleared before the new provider's (empty) set is applied
  assert.strictEqual('ANTHROPIC_BASE_URL' in env, false);
  assert.strictEqual('ANTHROPIC_AUTH_TOKEN' in env, false);
  assert.strictEqual(env.PATH, '/bin');                    // non-managed base keys survive
  // and the dirty base object itself is unchanged
  assert.strictEqual(dirty.ANTHROPIC_BASE_URL, 'https://leftover.example');
});

test('resolveScopedEnv emits ONLY keys that are in providers.MANAGED (drift guard)', () => {
  const list = ps.loadProviderRegistry();
  const MANAGED = new Set(providers.MANAGED);
  const base = { PATH: '/bin', HOME: '/h' };
  for (const entry of list) {
    let env;
    try { env = ps.resolveScopedEnv(base, entry, 'x'); } catch { continue; }   // key-auth without a real secret may throw; fine
    for (const k of Object.keys(env)) {
      if (k === 'PATH' || k === 'HOME') continue;           // carried base keys
      assert.ok(MANAGED.has(k), 'unmanaged routing var emitted: ' + k + ' (provider ' + entry.id + ')');
    }
  }
});

test('resolveScopedEnv throws when a key-auth provider has no secret (never spawn keyless)', () => {
  const list = ps.loadProviderRegistry();
  const openai = providers.find(list, 'openai');
  assert.throws(() => ps.resolveScopedEnv({}, openai, ''), /missing secret/);
});

test('resolveScopedEnv throws on a null provider', () => {
  assert.throws(() => ps.resolveScopedEnv({}, null, ''), /no provider/);
});

// ── ChatRegistry: many concurrent chats, none disconnects unless asked ──────────────────────────────
test('register opens a chat with safe metadata and a PER-CHAT sessionKey (model, provider, chatId)', () => {
  const reg = new ps.ChatRegistry();
  const c = reg.register('chat-1', { model: 'sonnet', providerId: 'claude' });
  assert.strictEqual(c.chatId, 'chat-1');
  assert.strictEqual(c.model, 'sonnet');
  assert.strictEqual(c.providerId, 'claude');
  assert.strictEqual(c.connected, true);
  // the warm bucket folds in the chatId so every tile is its OWN child process, never the shared main-brain bucket
  // (sessionKey(model,'')); this isolates context between tiles and keeps disconnect from reaping the main brain.
  assert.strictEqual(c.key, ps.sessionKey('sonnet', 'claude') + '#chat-1');
  assert.notStrictEqual(c.key, ps.sessionKey('sonnet', 'claude'));
});

test('register mints an unguessable chatId when none is given', () => {
  const reg = new ps.ChatRegistry();
  const a = reg.register(null, { model: 'opus', providerId: 'claude' });
  const b = reg.register(undefined, { model: 'opus', providerId: 'claude' });
  assert.notStrictEqual(a.chatId, b.chatId);
  assert.match(a.chatId, /^c[0-9a-z]+-[0-9a-f]{18}$/);
});

test('many chats coexist on different providers; opening one never disconnects another', () => {
  const reg = new ps.ChatRegistry();
  reg.register('a', { model: 'sonnet', providerId: 'claude' });
  reg.register('b', { model: 'sonnet', providerId: 'openrouter' });   // same model, different provider
  reg.register('c', { model: 'gpt-5', providerId: 'openai' });
  assert.strictEqual(reg.activeChats().length, 3);
  // distinct warm-session buckets — no collision between the two 'sonnet' chats
  const keys = new Set(reg.list().map((x) => x.key));
  assert.strictEqual(keys.size, 3);
  // every chat is still connected after the others opened
  for (const id of ['a', 'b', 'c']) assert.strictEqual(reg.get(id).connected, true);
});

test('disconnect drops ONLY the named chat; each tile owns its OWN bucket (per-chat isolation)', () => {
  const reg = new ps.ChatRegistry();
  // even two chats on the SAME (model, provider) get DISTINCT per-chat buckets now (key folds in the chatId), so a
  // tile is never shared with another tile or with the main brain. disconnect therefore frees only that tile's child.
  reg.register('a', { model: 'sonnet', providerId: 'claude' });
  reg.register('b', { model: 'sonnet', providerId: 'claude' });
  reg.register('c', { model: 'opus', providerId: 'claude' });
  assert.notStrictEqual(reg.get('a').key, reg.get('b').key, 'same model+provider, but distinct per-chat buckets');
  const r = reg.disconnect('a');
  assert.strictEqual(r.chatId, 'a');
  assert.strictEqual(r.keyStillInUse, false, "a's bucket is unique to a, so it is free to reap (never the main brain)");
  assert.strictEqual(reg.get('a').connected, false);
  assert.strictEqual(reg.get('b').connected, true);          // untouched
  assert.strictEqual(reg.get('c').connected, true);          // untouched
});

test('disconnect on an unknown chat returns null (no throw)', () => {
  const reg = new ps.ChatRegistry();
  assert.strictEqual(reg.disconnect('ghost'), null);
});

test('markActivity bumps lastActivity and reconfirms connected', () => {
  let t = 1000;
  const reg = new ps.ChatRegistry({ now: () => t });
  reg.register('a', { model: 'sonnet', providerId: 'claude' });
  const t0 = reg.get('a').lastActivity;
  t = 5000;
  assert.strictEqual(reg.markActivity('a'), true);
  assert.ok(reg.get('a').lastActivity > t0);
  assert.strictEqual(reg.markActivity('missing'), false);
});

test('list() and get() NEVER expose a secret or an env object (safe-metadata contract)', () => {
  const reg = new ps.ChatRegistry();
  reg.register('a', { model: 'sonnet', providerId: 'openai', secret: 'sk-should-be-ignored', env: { X: 1 } });
  const safeFields = ['chatId', 'model', 'providerId', 'connected', 'key', 'createdAt', 'lastActivity'];
  for (const view of [reg.get('a'), reg.list()[0]]) {
    assert.deepStrictEqual(Object.keys(view).sort(), [...safeFields].sort());
    assert.strictEqual('secret' in view, false);
    assert.strictEqual('env' in view, false);
    // the ignored secret never landed anywhere on the projection
    assert.strictEqual(JSON.stringify(view).includes('sk-should-be-ignored'), false);
  }
});

test('activeChats excludes disconnected chats; remove hard-deletes', () => {
  const reg = new ps.ChatRegistry();
  reg.register('a', { model: 'sonnet', providerId: 'claude' });
  reg.register('b', { model: 'opus', providerId: 'claude' });
  reg.disconnect('a');
  assert.strictEqual(reg.activeChats().length, 1);
  assert.strictEqual(reg.list().length, 2);                 // disconnected row retained for audit
  assert.strictEqual(reg.remove('a'), true);
  assert.strictEqual(reg.list().length, 1);
  assert.strictEqual(reg.has('a'), false);
});

test('register with an unknown providerId still keys cleanly (fail-soft, slugified)', () => {
  const reg = new ps.ChatRegistry();
  const c = reg.register('x', { model: 'sonnet', providerId: 'Weird Name!!' });
  assert.strictEqual(c.providerId, 'weird-name');
  assert.strictEqual(c.key, ps.sessionKey('sonnet', 'weird-name') + '#x');
});
