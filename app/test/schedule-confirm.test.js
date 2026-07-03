'use strict';
// Audit UX fix. Two concrete defects the audit flagged on the schedule/job surface:
//   (1) four verbs dumped the daemon's raw {"ok":true} JSON straight to the user — cron cancel,
//       cron run, job cancel (the `cancel` command), and unremind — instead of a house-voice line.
//   (2) the reminder-cancel verb `unremind` was undiscoverable: it had a dispatch branch but no
//       registry entry, so no help tier ever surfaced it.
// This test freezes both fixes: the four branches must format a ✓/✗ confirmation (never a raw JSON
// dump), and `unremind` must be a real registry command that tier-3 help renders.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const reg = require('../registry');
const src = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf8');

// The four confirm endpoints, each POSTed on a single dispatch line in cli.js. The branch line that
// hits the endpoint is exactly where the raw-JSON leak lived, so it is also where the fix must be.
const CONFIRM_ENDPOINTS = [
  '/cron/${rest[1]}/cancel',
  '/cron/${rest[1]}/run',
  '/job/${rest[0]}/cancel',
  '/reminder/${rest[0]}/cancel',
];

test('the four schedule/job verbs confirm in the house voice, not raw JSON', () => {
  for (const ep of CONFIRM_ENDPOINTS) {
    const lines = src.split('\n').filter((l) => l.includes(ep));
    assert.equal(lines.length, 1, ep + ' should be POSTed on exactly one dispatch line (found ' + lines.length + ')');
    const l = lines[0];
    assert.ok(!/JSON\.stringify\(\s*await req\(/.test(l), ep + ' still dumps the raw daemon reply to the user: ' + l.trim());
    assert.ok(l.includes('✓'), ep + ' must render a ✓ confirmation on success: ' + l.trim());
    assert.ok(l.includes('✗'), ep + ' must render a ✗ line when there is nothing to cancel/run: ' + l.trim());
  }
});

test('unremind is a discoverable registry command (surfaced in help)', () => {
  const c = reg.byName('unremind');
  assert.ok(c, 'unremind must be a registry entry so help can surface it');
  assert.equal(c.name, 'unremind');
  assert.equal(c.group, 'SCHEDULE');
  assert.ok(c.summary && !/\n/.test(c.summary), 'unremind needs a single-line summary');
  assert.ok(Array.isArray(c.examples) && c.examples.length >= 1, 'unremind needs at least one example');

  // tier-3 help (`urfael help unremind`) renders it with usage + example
  const id = (s) => s;
  const ui = { banner: () => '', frame: (t, ls) => t + '\n' + ls.join('\n'), gold: id, dim: id, visLen: (s) => s.length };
  const one = reg.renderOne('unremind', ui);
  assert.match(one, /unremind/);
  assert.match(one, /usage/);
  assert.match(one, /urfael unremind <id>/);

  // and it is pointed to from its parent verb's help so a user browsing reminders finds it
  const reminders = reg.byName('reminders');
  assert.ok(/unremind/.test(reminders.usage), 'reminders help should point at unremind');
});
