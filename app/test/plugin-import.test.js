'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const ic = require('../plugin-importcore');
const ph = require('../pluginhub');

// ── stripJson5 / parseYamlSubset / detectFormat ────────────────────────────────────────────────────
test('stripJson5 removes // and /* */ comments and trailing commas, but not inside strings', () => {
  const j = ic.stripJson5('{\n  // c\n  "a": 1, /* x */\n  "url": "http://x//y",\n}');
  assert.deepEqual(JSON.parse(j), { a: 1, url: 'http://x//y' });
  assert.doesNotThrow(() => ic.stripJson5(null));   // total, never throws
});
test('parseYamlSubset reads flat scalars + simple lists; nested is opaque, not guessed', () => {
  const y = ic.parseYamlSubset('name: demo\nversion: 1.2.3\nprovides_tools:\n  - a\n  - b\nrequires_env:\n  - API_KEY');
  assert.equal(y.name, 'demo'); assert.equal(y.version, '1.2.3');
  assert.deepEqual(y.provides_tools, ['a', 'b']);
  assert.deepEqual(y.requires_env, ['API_KEY']);
});
test('detectFormat keys off the signature file', () => {
  assert.equal(ic.detectFormat(['openclaw.plugin.json', 'package.json']), 'openclaw');
  assert.equal(ic.detectFormat(['plugin.yaml']), 'hermes-plugin');
  assert.equal(ic.detectFormat(['SKILL.md']), 'skill-md');
  assert.equal(ic.detectFormat(['readme.txt']), 'unknown');
});

// ── the 3-bucket router + the fail-closed map ──────────────────────────────────────────────────────
const OC_MCP = ['{\n  // weather plugin\n  "id": "weather-tool",\n  "name": "Weather",\n  "version": "1.0.0",\n  "contracts": { "tools": [{ "name": "getWeather", "description": "get the weather" }] },\n  "providerEndpoints": [{ "host": "api.weather.com" }],\n}', '{"name":"weather-tool","version":"1.0.0"}', '{ "mcp": { "servers": { "weather": { "command": "node", "args": ["server.js"] } } } }'];

test('OpenClaw plugin WITH an external mcp.servers command → a draft manifest (entry + prefixed tools + ONE public net host)', () => {
  const d = ic.parseOpenClaw(...OC_MCP);
  const { manifest, refusals } = ic.mapToManifest(d);
  assert.ok(manifest, 'a runnable server exists → a manifest is emitted');
  assert.deepEqual(manifest.entry.cmd, ['node', 'server.js']);
  assert.equal(manifest.capabilities.brain.tools[0].name, 'getweather');
  assert.deepEqual(manifest.capabilities.net.map((n) => n.host), ['api.weather.com']);
  assert.equal(refusals.length, 0);
});

test('OpenClaw in-process tools with NO server command → REFUSED, never stubbed', () => {
  const d = ic.parseOpenClaw('{"id":"x","contracts":{"tools":[{"name":"doThing"}]}}', '{}', '{}');
  const { manifest, refusals } = ic.mapToManifest(d);
  assert.equal(manifest, null, 'a tool name + schema is a contract, not a runnable server → no manifest');
  assert.ok(refusals.some((r) => /no external MCP server/.test(r)));
});

test('Hermes hooks-only plugin → refusals non-empty AND no manifest (the frozen case)', () => {
  const d = ic.parseHermes('name: hooker\nversion: 0.1.0\nprovides_hooks:\n  - pre_tool_call\n  - post_llm_call', '');
  const { manifest, refusals } = ic.mapToManifest(d);
  assert.equal(manifest, null);
  assert.ok(refusals.some((r) => /register_hook|hook/i.test(r)));
});

test('a bundled SKILL.md is ROUTED to the skill installer, never a manifest capability', () => {
  const d = ic.parseOpenClaw('{"id":"sk","skills":["skills/daily/SKILL.md"]}', '{}', '{}');
  const { manifest, routedSkills } = ic.mapToManifest(d);
  assert.deepEqual(routedSkills, ['skills/daily/SKILL.md']);
  assert.equal(manifest, null);   // skill-only, no server → no manifest cap
});

test('an unparseable foreign manifest is REFUSED outright (no preview, no throw)', () => {
  const d = ic.parseOpenClaw("{ this is not json5 at all '''", '{}', '{}');
  assert.equal(d.parseError, true);
  const { manifest, refusals } = ic.mapToManifest(d);
  assert.equal(manifest, null);
  assert.ok(refusals.some((r) => /did not parse/.test(r)));
});

// ── the frozen SECURITY properties ──────────────────────────────────────────────────────────────────
test('a declared network capability with NO resolvable public host yields NO net cap (narrower-or-nothing, never a wildcard)', () => {
  const d = ic.parseOpenClaw('{"id":"y","contracts":{"tools":[{"name":"t"}],"webFetchProviders":[{"host":"*"},{"host":"127.0.0.1"},{"host":"10.0.0.5"}]},"mcp":{"servers":{"s":{"command":"node","args":["x.js"]}}}}', '{}', '{}');
  const { manifest } = ic.mapToManifest(d);
  assert.deepEqual(manifest.capabilities.net, [], 'wildcard + loopback + RFC1918 hosts are all dropped, never emitted');
});

test('mapToManifest NEVER emits an fs or exec cap, and a secret is a REFERENCE name only (never a value)', () => {
  const d = ic.parseOpenClaw('{"id":"z","contracts":{"tools":[{"name":"t"}]},"secretProviderIntegrations":[{"env":"STRIPE_KEY"}],"mcp":{"servers":{"s":{"command":"node","args":["x.js"]}}}}', '{}', '{}');
  const { manifest } = ic.mapToManifest(d);
  assert.deepEqual(manifest.capabilities.fs || [], []);
  assert.deepEqual(manifest.capabilities.exec || [], []);
  assert.deepEqual(manifest.capabilities.secret.map((s) => s.ref), ['STRIPE_KEY']);
  assert.ok(!JSON.stringify(manifest).includes('value'), 'no secret value is ever embedded');
});

test('ROUND-TRIP: every emitted manifest re-parses under the unchanged pluginhub.parse, with no fs/exec/private-net cap', () => {
  for (const fx of [OC_MCP, ['{"id":"hermes-ish","contracts":{"tools":[{"name":"go"}]},"mcp":{"servers":{"s":{"command":"uvx","args":["thing"]}}}}', '{}', '{}']]) {
    const { manifest } = ic.mapToManifest(ic.parseOpenClaw(...fx));
    const reparsed = ph.parse(JSON.stringify(manifest));
    assert.ok(reparsed, 'the importer cannot emit a manifest the native loader would reject');
    assert.deepEqual(reparsed.caps.fs, []);
    assert.deepEqual(reparsed.caps.exec, []);
    assert.ok(reparsed.caps.net.every((n) => !/^(127\.|10\.|192\.168|::1|localhost)/.test(n.host)));
  }
});

test('the importer emits an UNSIGNED, DISABLED draft (never signs, never enables)', () => {
  const { manifest } = ic.mapToManifest(ic.parseOpenClaw(...OC_MCP));
  assert.ok(!manifest.signature, 'unsigned');
  assert.equal(manifest._draft, true);
  const reparsed = ph.parse(JSON.stringify(manifest));
  assert.equal(reparsed.signature, '');   // pluginhub sees no signature → the native six-gate will require one
});
