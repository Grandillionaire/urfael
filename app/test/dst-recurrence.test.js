'use strict';
// DST regression for daily/weekly recurrence: the fixed-step advance drifted one hour at every transition
// ("daily at 9:00" became 10:00 after spring-forward). The fix steps by LOCAL WALL-CLOCK via setDate().
// DST only exists in a DST timezone, and CI runs UTC — so the assertions run in a CHILD node pinned to
// TZ=America/New_York (node honors TZ on every OS via ICU). Skip-free: UTC hosts still run the child.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

function inTz(tz, script) {
  return execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: tz }, encoding: 'utf8', cwd: path.join(__dirname, '..'), windowsHide: true,
  }).trim();
}

test('daily recurrence keeps its local wall-clock hour across the spring-forward transition', () => {
  const out = inTz('America/New_York', `
    const { nextOccurrence } = require('./lib');
    // Sat 2026-03-07 09:00 EST (UTC-5). The next night, clocks spring forward to EDT (UTC-4).
    const rem = { at: new Date(2026, 2, 7, 9, 0, 0).getTime(), repeat: 'daily' };
    const afterFire = rem.at + 1000;                       // "the 07th fired; roll to the 08th"
    if (!nextOccurrence(rem, afterFire)) throw new Error('did not advance');
    const d = new Date(rem.at);
    console.log(d.getDate() + ' ' + d.getHours() + ':' + d.getMinutes());
  `);
  assert.equal(out, '8 9:0', 'the day after spring-forward must still fire at LOCAL 9:00, not 10:00');
});

test('weekly recurrence crossing fall-back also holds its local hour', () => {
  const out = inTz('America/New_York', `
    const { nextOccurrence } = require('./lib');
    // Sun 2026-10-25 08:30 EDT; the following Sun 2026-11-01 is the fall-back day.
    const rem = { at: new Date(2026, 9, 25, 8, 30, 0).getTime(), repeat: 'weekly' };
    if (!nextOccurrence(rem, rem.at + 1000)) throw new Error('did not advance');
    const d = new Date(rem.at);
    console.log(d.getDate() + ' ' + d.getHours() + ':' + d.getMinutes());
  `);
  assert.equal(out, '1 8:30', 'the week after fall-back must still fire at LOCAL 8:30, not 7:30');
});

test('interval repeats (everyMins) stay ABSOLUTE by design — a 60-min interval is 60 real minutes across DST', () => {
  const out = inTz('America/New_York', `
    const { nextOccurrence } = require('./lib');
    const rem = { at: new Date(2026, 2, 8, 1, 30, 0).getTime(), repeat: { everyMins: 60 } };  // 01:30 EST, 30min before the jump
    if (!nextOccurrence(rem, rem.at + 1000)) throw new Error('did not advance');
    console.log(rem.at - new Date(2026, 2, 8, 1, 30, 0).getTime());
  `);
  assert.equal(out, String(3600000), 'exactly one real hour, regardless of the wall clock jumping');
});
