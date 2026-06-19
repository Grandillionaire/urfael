'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const c = require('../connectors');

// ── the bundled registry is real and every entry survives validation ────────────────────────────
test('bundled registry loads and is non-trivial', () => {
  const list = c.load();
  assert.ok(list.length >= 30, 'expected a curated set of connectors, got ' + list.length);
  for (const e of list) {
    assert.match(e.id, /^[a-z0-9-]+$/);
    assert.ok(c.TRANSPORTS.has(e.transport));
    assert.ok(c.AUTHS.has(e.auth));
    if (e.transport === 'npx' || e.transport === 'uvx') assert.ok(e.pkg, e.id + ' needs a pkg');
    else assert.ok(/^https:\/\//.test(e.url) || c.isLoopback(new URL(e.url).hostname), e.id + ' remote url must be https or loopback');
  }
  // ids are unique
  assert.equal(new Set(list.map((e) => e.id)).size, list.length, 'duplicate connector id');
});

// ── parse is fail-soft: junk and malformed entries are DROPPED, never crash, never malformed ─────
test('parse drops malformed entries instead of throwing', () => {
  assert.deepEqual(c.parse('not json'), []);
  assert.deepEqual(c.parse('null'), []);
  assert.deepEqual(c.parse('{}'), []);
  const bad = JSON.stringify({ connectors: [
    { id: 'ok', name: 'OK', transport: 'npx', pkg: 'good-pkg', auth: 'none' },
    { id: 'no-transport', pkg: 'x' },                          // missing/invalid transport → drop
    { id: 'bad-transport', transport: 'ftp', pkg: 'x' },       // unknown transport → drop
    { id: 'npx-no-pkg', transport: 'npx' },                    // npx without pkg → drop
    { id: 'npx-evil-pkg', transport: 'npx', pkg: 'x; rm -rf ~' }, // shell metachars in pkg → drop
    { id: 'http-plain-remote', transport: 'http', url: 'http://evil.example.com' }, // plain-http remote → drop
    { id: 'http-bad-url', transport: 'http', url: 'not a url' }, // unparseable url → drop
    { transport: 'npx', pkg: 'no-id' },                        // no id → drop
  ] });
  const got = c.parse(bad);
  assert.deepEqual(got.map((e) => e.id), ['ok'], 'only the single valid entry should survive');
});

test('parse keeps a loopback http connector (local service) but not a plain-http remote', () => {
  const j = JSON.stringify({ connectors: [
    { id: 'local', name: 'Local', transport: 'http', url: 'http://127.0.0.1:27123/mcp/', auth: 'key', env: [{ key: 'OBSIDIAN_API_KEY', label: 'key' }] },
    { id: 'remote', name: 'Remote', transport: 'http', url: 'http://api.evil.com/mcp' },
  ] });
  assert.deepEqual(c.parse(j).map((e) => e.id), ['local']);
});

test('parse drops env fields that are not real env-var names (no flag smuggling)', () => {
  const j = JSON.stringify({ connectors: [
    { id: 'x', name: 'X', transport: 'npx', pkg: 'pkg', auth: 'key', env: [
      { key: 'GOOD_KEY', label: 'good' },
      { key: '--dangerously-skip-permissions', label: 'evil' },
      { key: 'lower_case', label: 'nope' },
    ] },
  ] });
  const e = c.parse(j)[0];
  assert.deepEqual(e.env.map((f) => f.key), ['GOOD_KEY']);
});

// ── search / find ────────────────────────────────────────────────────────────────────────────────
test('search + find', () => {
  const list = c.load();
  assert.ok(c.search(list, 'github').some((e) => e.id === 'github'));
  assert.equal(c.search(list, 'zzz-no-such').length, 0);
  assert.equal(c.search(list, '').length, list.length);
  assert.equal(c.find(list, 'github').id, 'github');
  assert.equal(c.find(list, 'GitHub').id, 'github');           // slug-normalized
  assert.equal(c.find(list, 'nope'), null);
});

// ── buildAddArgs: the core safety property — an ARGV, with secrets inside (no shell string) ───────
test('buildAddArgs for an npx key connector', () => {
  const e = { id: 'slack', transport: 'npx', pkg: '@modelcontextprotocol/server-slack', auth: 'key',
    env: [{ key: 'SLACK_BOT_TOKEN', label: 't' }, { key: 'SLACK_TEAM_ID', label: 'i' }] };
  const a = c.buildAddArgs(e, { SLACK_BOT_TOKEN: 'xoxb-secret', SLACK_TEAM_ID: 'T123' });
  assert.deepEqual(a, ['mcp', 'add', 'slack', '--env', 'SLACK_BOT_TOKEN=xoxb-secret', '--env', 'SLACK_TEAM_ID=T123', '--', 'npx', '-y', '@modelcontextprotocol/server-slack']);
  // it is an array (execFile-safe) — the secret is an element, never concatenated into a shell line
  assert.ok(Array.isArray(a));
});

test('buildAddArgs for a uvx no-auth connector', () => {
  const a = c.buildAddArgs({ id: 'time', transport: 'uvx', pkg: 'mcp-server-time', auth: 'none', env: [] });
  assert.deepEqual(a, ['mcp', 'add', 'time', '--', 'uvx', 'mcp-server-time']);
});

test('buildAddArgs for an http oauth connector (no secret)', () => {
  const a = c.buildAddArgs({ id: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp', auth: 'oauth', env: [] });
  assert.deepEqual(a, ['mcp', 'add', '--transport', 'http', 'notion', 'https://mcp.notion.com/mcp']);
});

test('buildAddArgs for an http key connector adds a bearer header', () => {
  const a = c.buildAddArgs({ id: 'stripe', transport: 'http', url: 'https://mcp.stripe.com', auth: 'key', env: [{ key: 'STRIPE_SECRET_KEY', label: 'k' }] }, { STRIPE_SECRET_KEY: 'rk_live_x' });
  assert.deepEqual(a, ['mcp', 'add', '--transport', 'http', 'stripe', 'https://mcp.stripe.com', '--header', 'Authorization: Bearer rk_live_x']);
});

test('buildAddArgs throws (does not silently produce a broken command) when a required secret is missing', () => {
  const e = { id: 'tavily', transport: 'npx', pkg: 'tavily-mcp', auth: 'key', env: [{ key: 'TAVILY_API_KEY', label: 'k' }] };
  assert.throws(() => c.buildAddArgs(e, {}), /missing secret: TAVILY_API_KEY/);
});

// ── redaction: a preview/log can show the command shape but never the secret VALUE ───────────────
test('redactArgs masks env values and bearer tokens, keeps keys', () => {
  const a = ['mcp', 'add', 'slack', '--env', 'SLACK_BOT_TOKEN=xoxb-supersecret', '--', 'npx', '-y', 'pkg'];
  const r = c.redactArgs(a);
  assert.ok(!r.join(' ').includes('xoxb-supersecret'), 'secret value must not appear');
  assert.ok(r.join(' ').includes('SLACK_BOT_TOKEN=••••'), 'key kept, value masked');
  const h = c.redactArgs(['mcp', 'add', '--transport', 'http', 'stripe', 'https://x', '--header', 'Authorization: Bearer rk_live_secret']);
  assert.ok(!h.join(' ').includes('rk_live_secret'));
  assert.ok(/Bearer ••••/.test(h.join(' ')));
});

// ── scan: the pre-enable verdict the rest of the field doesn't ship ───────────────────────────────
test('scan flags a plain-http remote as danger', () => {
  // (this shape can't come from parse(), but scan must still fail closed if handed one)
  const f = c.scan({ id: 'x', transport: 'http', url: 'http://api.evil.com', auth: 'none', env: [] }).flags;
  assert.ok(f.some((x) => x.level === 'danger' && /plain http/.test(x.why)));
});
test('scan notes a loopback connector as info, not danger', () => {
  const f = c.scan({ id: 'obsidian', transport: 'http', url: 'http://127.0.0.1:27123/mcp/', auth: 'key', env: [{ key: 'OBSIDIAN_API_KEY', label: 'k' }] }).flags;
  assert.ok(!f.some((x) => x.level === 'danger'));
  assert.ok(f.some((x) => x.level === 'info' && /local service/.test(x.why)));
});
test('scan warns that a stdio connector runs local code, and that an unverified pkg needs a source check', () => {
  const f = c.scan({ id: 'gmail', transport: 'npx', pkg: 'some-community-pkg', auth: 'oauth', env: [], verified: false }).flags;
  assert.ok(f.some((x) => x.level === 'warn' && /runs a third-party package/.test(x.why)));
  assert.ok(f.some((x) => x.level === 'warn' && /not independently verified/.test(x.why)));
});

// ── preview is pure data with a redacted command and the owner-turns-only guarantee ──────────────
test('preview returns a redacted command and never leaks a secret', () => {
  const e = c.find(c.load(), 'stripe');
  const p = c.preview(e, { STRIPE_SECRET_KEY: 'rk_live_THIS_IS_SECRET' });
  assert.equal(p.ownerTurnsOnly, true);
  assert.ok(!JSON.stringify(p).includes('rk_live_THIS_IS_SECRET'), 'preview must never contain a secret value');
  assert.ok(p.command.startsWith('claude mcp add'));
});
test('preview renders the command shape even with no secrets entered yet', () => {
  const e = c.find(c.load(), 'slack');
  const p = c.preview(e, {});
  assert.ok(p.command.includes('SLACK_BOT_TOKEN=••••'));
  assert.ok(Array.isArray(p.secretsNeeded) && p.secretsNeeded.length >= 1);
});
