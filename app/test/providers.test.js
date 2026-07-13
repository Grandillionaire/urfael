'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const p = require('../providers');

// the daemon's forwarded allowlist (daemon.js PROVIDER_ENV ∪ the two URFAEL tier vars), copied here as a FROZEN
// contract: every var a provider switch can emit must be one the daemon already forwards to every spawn.
const DAEMON_FORWARDED = new Set([
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'AWS_REGION', 'AWS_PROFILE', 'AWS_BEARER_TOKEN_BEDROCK', 'CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID', 'GOOGLE_APPLICATION_CREDENTIALS',
  'URFAEL_SONNET_MODEL', 'URFAEL_OPUS_MODEL',
]);

// ── the bundled registry loads and every row is valid ────────────────────────────────────────────
test('bundled provider registry loads and is non-trivial', () => {
  const list = p.load();
  assert.ok(list.length >= 8, 'expected a curated set, got ' + list.length);
  for (const e of list) {
    assert.match(e.id, /^[a-z0-9-]+$/);
    assert.ok(p.KINDS.has(e.kind));
    assert.ok(p.AUTHS.has(e.authKind));
    assert.ok(p.PROXIES.has(e.proxy));
    if (e.baseUrl) assert.ok(/^https:\/\//.test(e.baseUrl) || /^http:\/\/(localhost|127\.0\.0\.1)/.test(e.baseUrl), e.id + ' baseUrl must be https or loopback');
  }
  assert.equal(new Set(list.map((e) => e.id)).size, list.length, 'duplicate provider id');
  assert.ok(p.find(list, 'claude'), 'the flat-rate Claude default row exists');
});

// ── parse is fail-soft: junk and hostile rows are DROPPED, never crash ─────────────────────────────
test('parse drops malformed / plain-http-remote / flag-smuggling rows, keeping the good one', () => {
  assert.deepEqual(p.parse('not json'), []);
  assert.deepEqual(p.parse('null'), []);
  const j = JSON.stringify({ providers: [
    { id: 'ok', label: 'OK', kind: 'openai', baseUrl: 'https://api.example.com', authKind: 'key', authEnv: 'ANTHROPIC_AUTH_TOKEN' },
    { id: 'no-kind', baseUrl: 'https://x' },
    { id: 'bad-kind', kind: 'magic' },
    { id: 'plain-http-remote', kind: 'openai', baseUrl: 'http://api.evil.com' },     // plain-http remote → drop
    { id: 'flag-env', kind: 'openai', baseUrl: 'https://x', authKind: 'key', authEnv: '--dangerously-skip-permissions' },  // not a real/forwarded env name → drop
    { id: 'unforwarded-env', kind: 'openai', baseUrl: 'https://x', authKind: 'key', authEnv: 'SOME_RANDOM_VAR' },           // real name but daemon doesn't forward it → drop
  ] });
  assert.deepEqual(p.parse(j).map((e) => e.id), ['ok']);
});
test('parse keeps a loopback baseUrl (a local model server)', () => {
  const j = JSON.stringify({ providers: [{ id: 'local', kind: 'ollama', baseUrl: 'http://localhost:11434', authKind: 'local', localToken: 'ollama' }] });
  assert.deepEqual(p.parse(j).map((e) => e.id), ['local']);
});

// ── the claude default is honest: native flat-rate cloud, sets nothing new ─────────────────────────
test('the claude default resolves to native cloud — clears the managed vars, sets no base url and no key', () => {
  const e = p.find(p.load(), 'claude');
  const r = p.resolveEnv(e);
  assert.ok(!('ANTHROPIC_BASE_URL' in r.set), 'no base url for native');
  assert.ok(!('ANTHROPIC_API_KEY' in r.set) && !('ANTHROPIC_AUTH_TOKEN' in r.set), 'no key for the subscription');
  assert.deepEqual(r.clear, p.MANAGED, 'a switch clears every managed var first (no cross-provider leak)');
  assert.equal(p.preview(e).isDefault, true);
});

// ── resolveEnv per kind sets the right delta ───────────────────────────────────────────────────────
test('resolveEnv: an openai/proxy provider sets base url + the keyed secret + the tier→model mapping', () => {
  const e = { id: 'x', kind: 'openai', baseUrl: 'https://api.example.com', authKind: 'key', authEnv: 'ANTHROPIC_AUTH_TOKEN', big_model: 'big/m', small_model: 'small/m' };
  const r = p.resolveEnv(e, 'sk-secret');
  assert.equal(r.set.ANTHROPIC_BASE_URL, 'https://api.example.com');
  assert.equal(r.set.ANTHROPIC_AUTH_TOKEN, 'sk-secret');
  assert.equal(r.set.ANTHROPIC_MODEL, 'big/m');
  assert.equal(r.set.URFAEL_OPUS_MODEL, 'big/m');
  assert.equal(r.set.URFAEL_SONNET_MODEL, 'small/m');
});
test('resolveEnv: a local model sets a placeholder token and needs NO key prompt', () => {
  const e = p.find(p.load(), 'ollama');
  const r = p.resolveEnv(e);                                      // no secret passed
  assert.equal(r.set.ANTHROPIC_AUTH_TOKEN, 'ollama');
  assert.match(r.set.ANTHROPIC_BASE_URL, /11434/);
  assert.equal(p.secretNeeded(e), null);
});
test('resolveEnv: bedrock/vertex set their flags, not a base url', () => {
  assert.equal(p.resolveEnv(p.find(p.load(), 'claude-bedrock')).set.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(p.resolveEnv(p.find(p.load(), 'claude-vertex')).set.CLAUDE_CODE_USE_VERTEX, '1');
});
test('resolveEnv throws (does not produce a broken switch) when a required key is missing', () => {
  assert.throws(() => p.resolveEnv({ id: 'x', kind: 'openai', baseUrl: 'https://x', authKind: 'key', authEnv: 'ANTHROPIC_AUTH_TOKEN' }, ''), /missing secret/);
});
test('resolveEnv honors a --big/--small override', () => {
  const r = p.resolveEnv(p.find(p.load(), 'ollama'), undefined, { big: 'a/b', small: 'c/d' });
  assert.equal(r.set.URFAEL_OPUS_MODEL, 'a/b');
  assert.equal(r.set.URFAEL_SONNET_MODEL, 'c/d');
});

// ── THE DRIFT GUARD: every var any seed provider's resolveEnv can emit is one the daemon forwards ──
test('DRIFT GUARD: resolveEnv only ever emits vars the daemon already forwards to every spawn', () => {
  const list = p.load();
  for (const e of list) {
    const r = p.resolveEnv(e, p.secretNeeded(e) ? 'dummy-secret' : undefined);
    for (const k of Object.keys(r.set)) assert.ok(DAEMON_FORWARDED.has(k), 'provider ' + e.id + ' emits ' + k + ' which the daemon does NOT forward — a switch would not propagate');
    for (const k of r.clear) assert.ok(DAEMON_FORWARDED.has(k), 'MANAGED clears ' + k + ' which is not in the forwarded set');
  }
  // and MANAGED itself is a subset of the forwarded allowlist
  for (const k of p.MANAGED) assert.ok(DAEMON_FORWARDED.has(k), 'MANAGED var not forwarded: ' + k);
});

// ── preview never leaks a secret value ──────────────────────────────────────────────────────────────
test('preview is pure data, marks local/verified, and never contains a secret value', () => {
  const e = p.find(p.load(), 'openrouter');
  const pv = p.preview(e, 'sk-or-THE-SECRET');
  assert.ok(!JSON.stringify(pv).includes('sk-or-THE-SECRET'), 'preview must never contain a secret value');
  assert.equal(pv.secret, e.authLabel);
  assert.equal(p.preview(p.find(p.load(), 'ollama')).local, true);
  assert.ok(!p.redact('Authorization: Bearer sk-or-THE-SECRET', ['sk-or-THE-SECRET']).includes('sk-or-THE-SECRET'));
});

// ── provider fallback chains (fallback_providers): the daemon tries the next on a failed turn ──
test('chain resolves [primary, ...fallbacks] to real entries, deduped, self/unknown skipped', () => {
  const list = [
    { id: 'a', fallbacks: ['b', 'c', 'a', 'ghost'] },   // self + unknown are skipped
    { id: 'b', fallbacks: [] },
    { id: 'c', fallbacks: ['b'] },
  ];
  assert.deepEqual(p.chain(list, 'a').map((x) => x.id), ['a', 'b', 'c']);
  assert.deepEqual(p.chain(list, 'b').map((x) => x.id), ['b']);
  assert.deepEqual(p.chain(list, 'nope'), []);
  // parsed from the bundled registry: openai falls back to openrouter then deepseek
  const real = p.load();
  assert.deepEqual(p.chain(real, 'openai').map((x) => x.id), ['openai', 'openrouter', 'deepseek']);
  assert.ok(Array.isArray(p.find(real, 'claude').fallbacks));   // every entry has a (possibly empty) fallbacks array
});
