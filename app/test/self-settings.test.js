'use strict';
// Unit tests for self-settings.js — the "rewrite yourself on request" pillar's SECURITY GATE.
// Runs in isolation (no daemon, no disk): node --test test/self-settings.test.js
const test = require('node:test');
const assert = require('node:assert');
const ss = require('../self-settings.js');

// ---------- parseProposal: the directive grammar ----------
test('parseProposal extracts key/value/reason from a fenced directive', () => {
  const p = ss.parseProposal('Right away, sir. <<urfael:set key=persona value=architect reason="you asked for systems thinking">> Done.');
  assert.ok(p, 'should parse');
  assert.strictEqual(p.key, 'persona');
  assert.strictEqual(p.value, 'architect');
  assert.strictEqual(p.reason, 'you asked for systems thinking');
});

test('parseProposal accepts fields in any order and an unquoted value', () => {
  const p = ss.parseProposal('<<urfael:set value=terse reason=concise key=verbosity>>');
  assert.ok(p);
  assert.strictEqual(p.key, 'verbosity');
  assert.strictEqual(p.value, 'terse');
  assert.strictEqual(p.reason, 'concise');
});

test('parseProposal allows a quoted value with spaces (e.g. a voice name)', () => {
  const p = ss.parseProposal('<<urfael:set key=ttsVoice value="Daniel UK">>');
  assert.ok(p);
  assert.strictEqual(p.key, 'ttsVoice');
  assert.strictEqual(p.value, 'Daniel UK');
  assert.strictEqual(p.reason, '');
});

test('parseProposal returns null when there is no directive', () => {
  assert.strictEqual(ss.parseProposal('Just a normal reply, sir.'), null);
  assert.strictEqual(ss.parseProposal(''), null);
  assert.strictEqual(ss.parseProposal(null), null);
});

test('parseProposal returns null when key or value is missing', () => {
  assert.strictEqual(ss.parseProposal('<<urfael:set key=persona>>'), null);
  assert.strictEqual(ss.parseProposal('<<urfael:set value=architect>>'), null);
});

test('parseProposal takes only the FIRST directive in a reply', () => {
  const p = ss.parseProposal('<<urfael:set key=verbosity value=rich>> then <<urfael:set key=persona value=sage>>');
  assert.strictEqual(p.key, 'verbosity');
  assert.strictEqual(p.value, 'rich');
});

test('parseProposal bounds an oversized value', () => {
  const huge = 'x'.repeat(5000);
  const p = ss.parseProposal('<<urfael:set key=ttsVoice value=' + huge + '>>');
  assert.ok(p);
  assert.ok(p.value.length <= 200);
});

// ---------- validateProposal: SAFE keys accepted ----------
test('validateProposal accepts every safe registry key with a valid value', () => {
  const good = [
    { key: 'persona', value: 'architect' },
    { key: 'persona', value: 'urfael' },
    { key: 'verbosity', value: 'terse' },
    { key: 'verbosity', value: 'RICH' },          // case-insensitive
    { key: 'tuiTheme', value: 'ember' },
    { key: 'tuiAnimation', value: 'oracle' },
    { key: 'orbTheme', value: 'sigil' },
    { key: 'voiceOn', value: 'on' },
    { key: 'voiceOn', value: false },
    { key: 'ttsVoice', value: 'Daniel' },
    { key: 'ackStyle', value: 'butler' },
    { key: 'confirmBypass', value: 'true' },
  ];
  for (const p of good) {
    const r = ss.validateProposal(p);
    assert.strictEqual(r.ok, true, 'expected ' + JSON.stringify(p) + ' to be accepted: ' + r.reason);
  }
});

test('validateProposal accepts an AUTHORED persona id passed via ctx', () => {
  const p = { key: 'persona', value: 'ledger-keeper' };
  assert.strictEqual(ss.validateProposal(p).ok, false, 'unknown authored id rejected without ctx');
  const r = ss.validateProposal(p, { personaIds: ['urfael', 'architect', 'ledger-keeper'] });
  assert.strictEqual(r.ok, true, 'authored id accepted when in ctx.personaIds');
});

// ---------- validateProposal: invalid VALUES for safe keys are rejected ----------
test('validateProposal rejects an out-of-enum value for a safe key', () => {
  assert.strictEqual(ss.validateProposal({ key: 'verbosity', value: 'screaming' }).ok, false);
  assert.strictEqual(ss.validateProposal({ key: 'tuiTheme', value: 'neon' }).ok, false);
  assert.strictEqual(ss.validateProposal({ key: 'persona', value: 'overlord' }).ok, false);
  assert.strictEqual(ss.validateProposal({ key: 'ackStyle', value: 'rude' }).ok, false);
});

test('validateProposal rejects a ttsVoice with shell/control characters', () => {
  assert.strictEqual(ss.validateProposal({ key: 'ttsVoice', value: 'Daniel; rm -rf /' }).ok, false);
  assert.strictEqual(ss.validateProposal({ key: 'ttsVoice', value: '$(whoami)' }).ok, false);
  assert.strictEqual(ss.validateProposal({ key: 'ttsVoice', value: 'a\nb' }).ok, false);
});

// ---------- THE CORE SECURITY PROOF: unsafe keys are REJECTED ----------
test('SECURITY: every security/credential/permission key is REJECTED', () => {
  const unsafe = [
    'URFAEL_YOLO', 'urfael_yolo', 'yolo',
    'bypassPermissions', 'bypass', 'URFAEL_PERMISSION_MODE', 'permissionMode', 'permMode',
    'ANTHROPIC_API_KEY', 'apiKey', 'api_key', 'ANTHROPIC_AUTH_TOKEN', 'token', 'authToken',
    'credentialDeny', 'credential', 'credDeny', 'denyRules',
    'profile', 'role', 'principal', 'permissionProfile',
    'socket', 'sock', 'SOCK', 'daemonSocket',
    'ANTHROPIC_BASE_URL', 'baseUrl', 'provider', 'model', 'pinnedModel',
    'password', 'secret', 'sealKey', 'PERM_MODE', 'sudo', 'shell',
  ];
  for (const key of unsafe) {
    const r = ss.validateProposal({ key, value: '1' });
    assert.strictEqual(r.ok, false, 'SECURITY HOLE: ' + key + ' must be rejected but was accepted');
  }
});

test('SECURITY: a security key disguised as a cosmetic one is still rejected', () => {
  // even values that "look safe" can never make an unsafe key pass
  assert.strictEqual(ss.validateProposal({ key: 'tui_yolo', value: 'gold' }).ok, false);
  assert.strictEqual(ss.validateProposal({ key: 'voice-api-key', value: 'Daniel' }).ok, false);
  assert.strictEqual(ss.validateProposal({ key: 'persona_bypass', value: 'architect' }).ok, false);
  assert.strictEqual(ss.validateProposal({ key: 'theme_token', value: 'ember' }).ok, false);
});

test('SECURITY: an unknown key that is not security-shaped is still rejected (allowlist, not denylist)', () => {
  assert.strictEqual(ss.validateProposal({ key: 'wallpaper', value: 'blue' }).ok, false);
  assert.strictEqual(ss.validateProposal({ key: 'volume', value: '11' }).ok, false);
});

test('SECURITY: no security-relevant key is present in the REGISTRY', () => {
  for (const key of ss.REGISTRY_KEYS) {
    assert.strictEqual(ss.isDenied(key), false, 'REGISTRY must not contain a denied key, found: ' + key);
  }
  // and none of these are keys at all
  for (const forbidden of ['URFAEL_YOLO', 'bypassPermissions', 'apiKey', 'permissionMode', 'socket', 'profile']) {
    assert.ok(!(forbidden in ss.REGISTRY), forbidden + ' must not be a registry key');
  }
});

test('validateProposal rejects malformed proposals', () => {
  assert.strictEqual(ss.validateProposal(null).ok, false);
  assert.strictEqual(ss.validateProposal({}).ok, false);
  assert.strictEqual(ss.validateProposal({ key: '', value: 'x' }).ok, false);
  assert.strictEqual(ss.validateProposal({ key: 123, value: 'x' }).ok, false);
});

// ---------- needsConfirm: the bypass toggle is never bypassable ----------
test('needsConfirm defaults to TRUE for a normal cosmetic change', () => {
  assert.strictEqual(ss.needsConfirm({ key: 'persona', value: 'sage' }), true);
});

test('needsConfirm is FALSE for a cosmetic change when global bypass is on', () => {
  assert.strictEqual(ss.needsConfirm({ key: 'persona', value: 'sage' }, { bypass: true }), false);
  assert.strictEqual(ss.needsConfirm({ key: 'tuiTheme', value: 'ember' }, { bypass: true }), false);
});

test('SECURITY: confirmBypass ALWAYS needs confirm, even with global bypass on', () => {
  assert.strictEqual(ss.needsConfirm({ key: 'confirmBypass', value: 'true' }), true);
  assert.strictEqual(ss.needsConfirm({ key: 'confirmBypass', value: 'true' }, { bypass: true }), true);
});

test('needsConfirm fails closed (TRUE) for an unknown key', () => {
  assert.strictEqual(ss.needsConfirm({ key: 'mystery', value: 'x' }, { bypass: true }), true);
});

// ---------- auditPayload: structured, bounded, redacted ----------
test('auditPayload builds a structured ledger entry', () => {
  const a = ss.auditPayload({ key: 'persona', value: 'architect', reason: 'systems' }, 'applied');
  assert.strictEqual(a.ev, 'self_setting');
  assert.strictEqual(a.key, 'persona');
  assert.strictEqual(a.value, 'architect');
  assert.strictEqual(a.decision, 'applied');
  assert.strictEqual(a.reason, 'systems');
  assert.ok(typeof a.t === 'string' && a.t.length > 0);
});

test('auditPayload REDACTS the value if the key were ever a protected one', () => {
  const a = ss.auditPayload({ key: 'ANTHROPIC_API_KEY', value: 'sk-secret-123' }, 'rejected');
  assert.strictEqual(a.value, '[redacted]', 'a protected key must never log its value');
  assert.strictEqual(a.decision, 'rejected');
});

test('auditPayload bounds long values and defaults the decision', () => {
  const a = ss.auditPayload({ key: 'ttsVoice', value: 'y'.repeat(500) }, undefined);
  assert.ok(a.value.length <= 120);
  assert.strictEqual(a.decision, 'pending');
});

// ---------- describeProposal ----------
test('describeProposal returns a human confirm line for a known key', () => {
  assert.match(ss.describeProposal({ key: 'persona', value: 'architect' }), /architect/);
  assert.match(ss.describeProposal({ key: 'voiceOn', value: 'off' }), /voice off/i);
});

test('describeProposal fails soft for an unknown key', () => {
  assert.strictEqual(typeof ss.describeProposal({ key: 'nope', value: 'x' }), 'string');
});

// ---------- end-to-end: parse -> validate -> reject the dangerous one ----------
test('end-to-end: a brain directive trying to enable YOLO is parsed but REJECTED', () => {
  const p = ss.parseProposal('Of course, sir. <<urfael:set key=URFAEL_YOLO value=1 reason="user asked for full power">>');
  assert.ok(p, 'directive still parses (grammar is permissive; the gate is validate)');
  assert.strictEqual(p.key, 'URFAEL_YOLO');
  const r = ss.validateProposal(p);
  assert.strictEqual(r.ok, false, 'YOLO must be rejected at the validation gate');
});

test('end-to-end: a cosmetic directive parses, validates, and needs confirm', () => {
  const p = ss.parseProposal('<<urfael:set key=tuiTheme value=ember reason="warmer look">>');
  const r = ss.validateProposal(p);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(ss.needsConfirm(p), true);
  const a = ss.auditPayload(p, 'confirmed');
  assert.strictEqual(a.key, 'tuiTheme');
  assert.strictEqual(a.value, 'ember');
});
