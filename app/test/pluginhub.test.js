'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const ph = require('../pluginhub');
const seal = require('../seal');
const lib = require('../lib');

// a minimal valid manifest object (parse normalizes it)
function baseManifest(extra = {}) {
  return Object.assign({
    schema: 'urfael.plugin/v1',
    id: 'demo',
    name: 'Demo',
    version: '1.2.3',
    runtime: 'mcp-native',
    entry: { transport: 'stdio', cmd: ['node', 'server.js'] },
    capabilities: {},
  }, extra);
}

// ── parse: fail-closed validation ────────────────────────────────────────────────────────────────
test('parse accepts a valid manifest and forces owner-turns-only', () => {
  const m = ph.parse(baseManifest());
  assert.equal(m.id, 'demo');
  assert.equal(m.activation.ownerTurnsOnly, true);
  assert.equal(m.hostReaching, false);
});

test('parse is fail-closed: unknown schema / runtime / non-stdio entry / shell-string entry all return null', () => {
  assert.equal(ph.parse('not json'), null);
  assert.equal(ph.parse('null'), null);
  assert.equal(ph.parse(JSON.stringify(baseManifest({ schema: 'urfael.plugin/v9' }))), null);
  assert.equal(ph.parse(JSON.stringify(baseManifest({ runtime: 'python' }))), null);   // reserved for v2
  assert.equal(ph.parse(JSON.stringify(baseManifest({ entry: { transport: 'http', cmd: ['x'] } }))), null);
  assert.equal(ph.parse(JSON.stringify(baseManifest({ entry: { transport: 'stdio', cmd: 'rm -rf ~' } }))), null); // not an argv array
  assert.equal(ph.parse(JSON.stringify(baseManifest({ entry: { transport: 'stdio', cmd: ['ok', 'bad\narg'] } }))), null);
});

test('parse DROPS an fs capability that targets a credential store or escapes the vault (deny-oracle), never the whole plugin', () => {
  const m = ph.parse(baseManifest({ capabilities: { fs: [
    { mode: 'read', path: 'vault:~/.claude/.credentials.json' },  // not vault-relative → dropped
    { mode: 'read', path: 'vault:../.ssh/id_rsa' },               // escapes the vault → dropped
    { mode: 'read', path: 'vault:.env' },                         // secret store → dropped
    { mode: 'read', path: '/etc/passwd' },                        // not a vault: path → dropped
    { mode: 'write', path: 'vault:03_Resources/plugins/demo' },   // the one legitimate grant
  ] } }));
  assert.equal(m.caps.fs.length, 1, 'only the safe vault-relative path survives');
  assert.equal(m.caps.fs[0].path, 'vault:03_Resources/plugins/demo');
  assert.equal(m.hostReaching, true);
});

test('parse DROPS a net capability pointing at a private/loopback host, keeps a public FQDN', () => {
  const m = ph.parse(baseManifest({ capabilities: { net: [
    { host: '127.0.0.1' }, { host: 'localhost' }, { host: '169.254.169.254' }, { host: '10.0.0.5' },
    { host: 'api.example.com', ports: [443] },
  ] } }));
  assert.deepEqual(m.caps.net.map((n) => n.host), ['api.example.com']);
});

test('parse keeps a secret as a REFERENCE name only (never a value) and drops a non-env-name', () => {
  const m = ph.parse(baseManifest({ capabilities: { secret: [
    { ref: 'STRIPE_KEY' }, { ref: 'lower' }, { ref: '--dangerously' },
  ] } }));
  assert.deepEqual(m.caps.secret.map((s) => s.ref), ['STRIPE_KEY']);
});

test('parse prefixes brain tool names to mcp_<id>_<tool>', () => {
  const m = ph.parse(baseManifest({ capabilities: { brain: { tools: [{ name: 'fetch_thing', description: 'x' }] } } }));
  assert.equal(m.caps.brain.tools[0].toolName, 'mcp_demo_fetch_thing');
});

// ── buildCellArgs: default-deny is the enforcement ───────────────────────────────────────────────
test('buildCellArgs with an EMPTY grant is default-deny: --network none, all caps dropped, read-only, NO bind mounts', () => {
  const m = ph.parse(baseManifest());
  const a = ph.buildCellArgs(m, {});
  const s = a.join(' ');
  assert.match(s, /--network none/);
  assert.match(s, /--cap-drop ALL/);
  assert.match(s, /--security-opt no-new-privileges/);
  assert.match(s, /--read-only/);
  assert.ok(!a.includes('-v'), 'no bind mount with an empty grant');
});

test('buildCellArgs threads the broker socket ONLY for a net/secret grant, keeps --network none, never opens a port', () => {
  const m = ph.parse(baseManifest({ capabilities: { net: [{ host: 'api.example.com' }], secret: [{ ref: 'K' }] } }));
  const withSock = ph.buildCellArgs(m, { net: m.caps.net, secret: m.caps.secret }, { brokerSock: '/j/plugin-sockets/x.sock' });
  const s = withSock.join(' ');
  assert.match(s, /--network none/, 'cell stays --network none even with egress');
  assert.ok(!/-p\b|--publish|bridge|--network host/.test(s), 'never a published/bridged/host network');
  assert.match(s, /-v \/j\/plugin-sockets\/x\.sock:\/run\/urfael\/broker\.sock/, 'the broker socket is the only egress mount');
  // without opts.brokerSock, no broker mount (the daemon supplies it at enable time)
  assert.ok(!ph.buildCellArgs(m, { net: m.caps.net }, {}).join(' ').includes('/run/urfael/broker.sock'));
  // an fs-only grant needs the cell but NOT the broker socket
  const fsm = ph.parse(baseManifest({ capabilities: { fs: [{ mode: 'read', path: 'vault:x' }] } }));
  assert.equal(ph.hostNeedsBroker(fsm.caps), false);
  assert.ok(!ph.buildCellArgs(fsm, { fs: fsm.caps.fs }, { brokerSock: '/j/s.sock' }).join(' ').includes('broker.sock'));
});

test('buildCellArgs with an fs:read grant mounts EXACTLY that path read-only and nothing else', () => {
  const m = ph.parse(baseManifest({ capabilities: { fs: [{ mode: 'read', path: 'vault:03_Resources/data' }] } }));
  const a = ph.buildCellArgs(m, { fs: m.caps.fs });
  const mounts = a.filter((x, i) => a[i - 1] === '-v');
  assert.equal(mounts.length, 1);
  assert.match(mounts[0], /\/vault\/03_Resources\/data:ro$/);
  assert.match(a.join(' '), /--network none/, 'fs grant never adds host networking');
});

test('buildCellArgs never contains a secret value (secrets are broker-injected, not in the argv)', () => {
  const m = ph.parse(baseManifest({ capabilities: { secret: [{ ref: 'API_KEY' }], net: [{ host: 'api.example.com' }] } }));
  const a = ph.buildCellArgs(m, { net: m.caps.net, secret: m.caps.secret });
  assert.ok(!a.join(' ').includes('API_KEY') || a.join(' ').indexOf('API_KEY') === -1, 'no secret ref value baked into the cell');
  assert.match(a.join(' '), /--network none/);
});

// ── buildMcpConfig: host-reaching → docker; pure brain-tools → plain stdio child; never a secret in env ──
test('buildMcpConfig wraps a host-reaching plugin in docker and a pure brain-tools plugin as a plain child', () => {
  const hostM = ph.parse(baseManifest({ capabilities: { fs: [{ mode: 'read', path: 'vault:x' }] } }));
  const cfgHost = ph.buildMcpConfig(hostM, { fs: hostM.caps.fs });
  assert.equal(cfgHost.mcpServers.demo.command, 'docker');
  assert.deepEqual(cfgHost.mcpServers.demo.env, {});

  const pureM = ph.parse(baseManifest({ capabilities: { brain: { tools: [{ name: 't' }] } } }));
  const cfgPure = ph.buildMcpConfig(pureM, ph.grantFromManifest(pureM));
  assert.equal(cfgPure.mcpServers.demo.command, 'node');                      // no docker needed, no host grant
  assert.deepEqual(cfgPure.mcpServers.demo.args, ['server.js']);
});

// ── integrity + signature gates ──────────────────────────────────────────────────────────────────
test('verifyIntegrity rejects a one-byte-mutated bundle, accepts the pinned bytes', () => {
  const bytes = Buffer.from('the plugin bundle bytes');
  const sha = ph.sha256(bytes);
  assert.equal(ph.verifyIntegrity(bytes, sha).ok, true);
  const mutated = Buffer.from('the plugin bundle byteS');
  assert.equal(ph.verifyIntegrity(mutated, sha).ok, false);
  assert.equal(ph.verifyIntegrity(bytes, '').ok, false);                      // no pin = refuse
});

test('verifySignature: accepts the pinned ed25519 key, rejects a wrong key and a tampered manifest', () => {
  const kp = seal.generateKeypair();
  const m = ph.parse(baseManifest({ publisher: { id: 'me', keyFingerprint: seal.fingerprint(kp.publicPem) } }));
  m.signature = seal.sign(kp.privatePem, ph.canonicalManifest(m));
  assert.equal(ph.verifySignature(m, kp.publicPem).ok, true);

  // wrong key → refused
  const other = seal.generateKeypair();
  assert.equal(ph.verifySignature(m, other.publicPem).ok, false);

  // tampered manifest (widen a capability after signing) → signature no longer matches
  const tampered = ph.parse(baseManifest({ publisher: m.publisher, capabilities: { exec: [{ bin: 'bash' }] } }));
  tampered.signature = m.signature;
  assert.equal(ph.verifySignature(tampered, kp.publicPem).ok, false);

  // unsigned → refused
  const unsigned = ph.parse(baseManifest());
  assert.equal(ph.verifySignature(unsigned, kp.publicPem).ok, false);
});

// ── grant diff: an upgrade that widens power is caught ────────────────────────────────────────────
test('grantDiff flags an upgrade that requests a capability beyond the prior grant', () => {
  const prior = ph.declaredCaps(ph.parse(baseManifest({ capabilities: { brain: { tools: [{ name: 't' }] } } })));
  const upgraded = ph.parse(baseManifest({ capabilities: { brain: { tools: [{ name: 't' }] }, net: [{ host: 'evil.example.com' }] } }));
  const diff = ph.grantDiff(prior, upgraded);
  assert.ok(diff.some((c) => c.kind === 'net'), 'the newly-requested net capability is in the diff');
  // no widening → empty diff
  assert.equal(ph.grantDiff(prior, ph.parse(baseManifest({ capabilities: { brain: { tools: [{ name: 't' }] } } }))).length, 0);
});

// ── preview: pure data, never leaks a secret value, owner-only, masks the cell command ─────────────
test('preview is owner-only, lists capabilities, and never contains a raw secret value', () => {
  const m = ph.parse(baseManifest({ capabilities: { secret: [{ ref: 'TOKEN' }], net: [{ host: 'api.example.com' }] } }));
  const p = ph.preview(m);
  assert.equal(p.ownerTurnsOnly, true);
  assert.equal(p.requiresDocker, true);
  assert.ok(p.capabilities.some((c) => c.kind === 'net'));
  assert.deepEqual(p.secrets, ['TOKEN']);
  // a secret VALUE (were one ever present) is redacted; the ref name is fine
  assert.ok(!ph.redact('Authorization: Bearer sk-supersecret', ['sk-supersecret']).includes('sk-supersecret'));
});

// ── the registry index is pin-mandatory ──────────────────────────────────────────────────────────
test('parseIndex requires an https url AND a 64-hex sha256 pin; drops anything unpinned', () => {
  const idx = JSON.stringify({ plugins: [
    { id: 'good', url: 'https://h/p.ufp', sha256: 'a'.repeat(64), publisher: 'me' },
    { id: 'unpinned', url: 'https://h/p.ufp' },                       // no sha → dropped
    { id: 'http', url: 'http://h/p.ufp', sha256: 'a'.repeat(64) },    // not https → dropped
    { id: 'badsha', url: 'https://h/p.ufp', sha256: 'xyz' },          // bad sha → dropped
  ] });
  assert.deepEqual(ph.parseIndex(idx).map((e) => e.id), ['good']);
});

// ── lib: the plugin-zero floor exists, is never 'local', grants nothing ───────────────────────────
test('lib.resolveProfile("plugin-zero") is the zero-capability floor, never local', () => {
  const z = lib.resolveProfile('plugin-zero');
  assert.equal(z.name, 'plugin-zero');
  assert.deepEqual(z.allowedTools, []);
  assert.notEqual(z.permissionMode, null);                           // null permissionMode is local's bypass-capable marker
  // an unknown/coerced input still floors to untrusted (unchanged), never local
  assert.equal(lib.resolveProfile(['local']).name, 'untrusted');
});
