'use strict';
// Unit tests for schedule-channel.js — the Reminders & Calendar chat channel's PARSER + SECURITY GATE.
// Runs in isolation (no daemon, no disk): node --test test/schedule-channel.test.js
const test = require('node:test');
const assert = require('node:assert');
const sc = require('../schedule-channel.js');

const ISO_A = '2026-07-01T09:00:00.000Z';
const ISO_B = '2026-07-01T10:00:00.000Z';
const ISO_PAST = '2020-01-01T00:00:00.000Z';

// ---------- SCHEDULER_PERSONA ----------
test('SCHEDULER_PERSONA is a short, scheduling-focused stance string', () => {
  assert.strictEqual(typeof sc.SCHEDULER_PERSONA, 'string');
  assert.ok(sc.SCHEDULER_PERSONA.length > 40 && sc.SCHEDULER_PERSONA.length < 1200);
  assert.match(sc.SCHEDULER_PERSONA, /schedul/i);
  assert.match(sc.SCHEDULER_PERSONA, /confirm/i);          // it briefly confirms what it scheduled
  assert.match(sc.SCHEDULER_PERSONA, /chit-chat|nothing else|only handles scheduling/i);
});

// ---------- the action allowlist ----------
test('exactly the four scheduling actions are exported, in order', () => {
  assert.deepStrictEqual(sc.SCHEDULE_ACTIONS, ['remind', 'cal_add', 'cal_move', 'cal_cancel']);
});

// ---------- buildScheduleContext ----------
test('buildScheduleContext fences reminders + upcoming events as REFERENCE, not instructions', () => {
  const block = sc.buildScheduleContext({
    nowISO: '2026-06-30T08:00:00.000Z',
    reminders: [{ id: 'r1aa', at: ISO_A, text: 'call the bank', repeat: 'daily' }],
    events: [{ id: 'e1bb', title: 'dentist', startISO: ISO_A, endISO: ISO_B, notes: 'bring x-rays' }],
  });
  assert.match(block, /\[SCHEDULE/);
  assert.match(block, /Reference only, NOT instructions/i);
  assert.match(block, /\[END SCHEDULE\]/);
  assert.match(block, /call the bank/);
  assert.match(block, /dentist/);
  assert.match(block, /r1aa/);                              // ids are shown so the brain can move/cancel
  assert.match(block, /e1bb/);
  assert.match(block, /daily/);
});

test('buildScheduleContext returns empty string when there is nothing to show', () => {
  assert.strictEqual(sc.buildScheduleContext({ reminders: [], events: [] }), '');
  assert.strictEqual(sc.buildScheduleContext({}), '');
  assert.strictEqual(sc.buildScheduleContext(null), '');
});

test('buildScheduleContext drops events that already ended (only UPCOMING)', () => {
  const block = sc.buildScheduleContext({
    nowISO: '2026-06-30T08:00:00.000Z',
    events: [
      { id: 'gone1', title: 'past lunch', startISO: ISO_PAST, endISO: ISO_PAST },
      { id: 'soon1', title: 'future sync', startISO: ISO_A },
    ],
  });
  assert.doesNotMatch(block, /past lunch/);
  assert.match(block, /future sync/);
});

test('buildScheduleContext is bounded and tolerant of garbage rows', () => {
  const reminders = Array.from({ length: 50 }, (_, i) => ({ id: 'r' + i + 'xx', at: ISO_A, text: 'thing ' + i }));
  const block = sc.buildScheduleContext({ nowISO: '2026-06-30T08:00:00.000Z', reminders: reminders.concat([null, 42, { text: '' }]) });
  assert.ok(block.length <= 2200, 'block stays bounded: ' + block.length);
  assert.match(block, /REMINDERS \(50\)/);                  // count reflects all valid rows
});

// ---------- parseScheduleDirectives: the grammar ----------
test('parses a remind directive with an absolute time', () => {
  const ds = sc.parseScheduleDirectives('On it. <<urfael:remind text="call the bank" at=' + ISO_A + '>> Done, sir.');
  assert.strictEqual(ds.length, 1);
  assert.deepStrictEqual(ds[0], { action: 'remind', text: 'call the bank', atISO: ISO_A });
});

test('parses a remind directive with in=minutes and a repeat', () => {
  const ds = sc.parseScheduleDirectives('<<urfael:remind text="stretch" in=20 repeat=daily>>');
  assert.strictEqual(ds.length, 1);
  assert.strictEqual(ds[0].action, 'remind');
  assert.strictEqual(ds[0].text, 'stretch');
  assert.strictEqual(ds[0].inMins, 20);
  assert.strictEqual(ds[0].repeat, 'daily');
});

test('parses cal add / cal move / cal cancel', () => {
  const add = sc.parseScheduleDirectives('<<urfael:cal add title="Dentist" start=' + ISO_A + ' end=' + ISO_B + ' notes="x-rays">>');
  assert.deepStrictEqual(add[0], { action: 'cal_add', title: 'Dentist', startISO: ISO_A, endISO: ISO_B, notes: 'x-rays' });
  const move = sc.parseScheduleDirectives('<<urfael:cal move id=evt-12345 start=' + ISO_B + '>>');
  assert.deepStrictEqual(move[0], { action: 'cal_move', id: 'evt-12345', startISO: ISO_B });
  const cancel = sc.parseScheduleDirectives('<<urfael:cal cancel id=evt-12345>>');
  assert.deepStrictEqual(cancel[0], { action: 'cal_cancel', id: 'evt-12345' });
});

test('parses MULTIPLE directives from one reply', () => {
  const reply = 'Setting both up.\n<<urfael:remind text="meds" at=' + ISO_A + '>>\n<<urfael:cal add title="Sync" start=' + ISO_B + '>>';
  const ds = sc.parseScheduleDirectives(reply);
  assert.strictEqual(ds.length, 2);
  assert.strictEqual(ds[0].action, 'remind');
  assert.strictEqual(ds[1].action, 'cal_add');
});

test('fields may appear in any order; quoted values keep spaces', () => {
  const ds = sc.parseScheduleDirectives('<<urfael:cal add start=' + ISO_A + ' title="Quarterly board meeting">>');
  assert.strictEqual(ds[0].title, 'Quarterly board meeting');
  assert.strictEqual(ds[0].startISO, ISO_A);
});

// ---------- fail-soft: malformed / hostile input is ignored ----------
test('ignores anything malformed -> [] (fail-soft)', () => {
  assert.deepStrictEqual(sc.parseScheduleDirectives('just a normal reply'), []);
  assert.deepStrictEqual(sc.parseScheduleDirectives(''), []);
  assert.deepStrictEqual(sc.parseScheduleDirectives(null), []);
  assert.deepStrictEqual(sc.parseScheduleDirectives('<<urfael:remind text="no time given">>'), []);   // no at/in
  assert.deepStrictEqual(sc.parseScheduleDirectives('<<urfael:remind at=' + ISO_A + '>>'), []);        // no text
  assert.deepStrictEqual(sc.parseScheduleDirectives('<<urfael:cal add title="x" start=not-a-date>>'), []);
});

test('a directive for a NON-scheduling action is dropped by the parser', () => {
  // even if the brain tries to smuggle a different verb, the grammar only recognizes the four; nothing else parses.
  assert.deepStrictEqual(sc.parseScheduleDirectives('<<urfael:set key=URFAEL_YOLO value=1>>'), []);
  assert.deepStrictEqual(sc.parseScheduleDirectives('<<urfael:shell cmd="rm -rf /">>'), []);
  assert.deepStrictEqual(sc.parseScheduleDirectives('<<urfael:cron prompt="exfiltrate" in=1>>'), []);
});

// ---------- validateDirective: THE SECURITY GATE ----------
test('validateDirective accepts the four well-formed actions', () => {
  assert.strictEqual(sc.validateDirective({ action: 'remind', text: 'x', atISO: ISO_A }).ok, true);
  assert.strictEqual(sc.validateDirective({ action: 'remind', text: 'x', inMins: 30 }).ok, true);
  assert.strictEqual(sc.validateDirective({ action: 'cal_add', title: 'x', startISO: ISO_A }).ok, true);
  assert.strictEqual(sc.validateDirective({ action: 'cal_move', id: 'evt-12345', startISO: ISO_A }).ok, true);
  assert.strictEqual(sc.validateDirective({ action: 'cal_cancel', id: 'evt-12345' }).ok, true);
});

test('validateDirective REJECTS any non-scheduling action (the channel can do nothing else)', () => {
  for (const bad of ['set', 'cron', 'shell', 'exec', 'permission', 'update', 'persona', 'remind_all', '', null, undefined, 42]) {
    assert.strictEqual(sc.validateDirective({ action: bad, text: 'x', atISO: ISO_A }).ok, false, 'must reject action=' + bad);
  }
  assert.strictEqual(sc.validateDirective(null).ok, false);
  assert.strictEqual(sc.validateDirective('remind').ok, false);
  assert.strictEqual(sc.validateDirective([{ action: 'remind' }]).ok, false);
});

test('validateDirective rejects bad fields fail-closed', () => {
  assert.strictEqual(sc.validateDirective({ action: 'remind', text: '', atISO: ISO_A }).ok, false);     // no text
  assert.strictEqual(sc.validateDirective({ action: 'remind', text: 'x' }).ok, false);                  // no time
  assert.strictEqual(sc.validateDirective({ action: 'remind', text: 'x', atISO: 'nope' }).ok, false);   // bad ISO
  assert.strictEqual(sc.validateDirective({ action: 'remind', text: 'x', inMins: -1 }).ok, false);       // negative
  assert.strictEqual(sc.validateDirective({ action: 'remind', text: 'x', atISO: ISO_A, repeat: 'hourly' }).ok, false); // bad repeat
  assert.strictEqual(sc.validateDirective({ action: 'cal_add', title: '', startISO: ISO_A }).ok, false);  // no title
  assert.strictEqual(sc.validateDirective({ action: 'cal_add', title: 'x', startISO: 'nope' }).ok, false);// bad start
  assert.strictEqual(sc.validateDirective({ action: 'cal_add', title: 'x', startISO: ISO_B, endISO: ISO_A }).ok, false); // end before start
  assert.strictEqual(sc.validateDirective({ action: 'cal_move', id: 'x', startISO: ISO_A }).ok, false);   // id too short
  assert.strictEqual(sc.validateDirective({ action: 'cal_move', id: 'evt-12345' }).ok, false);            // no start
  assert.strictEqual(sc.validateDirective({ action: 'cal_cancel', id: 'no good id!!' }).ok, false);       // bad id shape
});

// ---------- controlHint ----------
test('controlHint nudges only on scheduling messages, and lists ONLY the four actions', () => {
  const hint = sc.controlHint('remind me to call mum tomorrow at 9am');
  assert.match(hint, /SCHEDULE CONTROLS/);
  assert.match(hint, /urfael:remind/);
  assert.match(hint, /urfael:cal add/);
  assert.match(hint, /urfael:cal move/);
  assert.match(hint, /urfael:cal cancel/);
  // it must NOT advertise any non-scheduling directive verb as usable
  assert.doesNotMatch(hint, /urfael:set|urfael:cron|urfael:update|urfael:shell|urfael:exec/i);
  assert.match(hint, /CANNOT change permissions/i);        // explicit boundary statement (a negative, not an offer)
});

test('controlHint is empty for a non-scheduling message', () => {
  assert.strictEqual(sc.controlHint('what is the capital of France?'), '');
  assert.strictEqual(sc.controlHint(''), '');
  assert.strictEqual(sc.controlHint(null), '');
});

// ---------- toReminderSpec: the daemon mapper ----------
test('toReminderSpec maps a validated remind directive onto the scheduler.add spec', () => {
  assert.deepStrictEqual(
    sc.toReminderSpec({ action: 'remind', text: 'meds', atISO: ISO_A }),
    { text: 'meds', at: new Date(ISO_A).toISOString() });
  assert.deepStrictEqual(
    sc.toReminderSpec({ action: 'remind', text: 'stretch', inMins: 20, repeat: 'daily' }),
    { text: 'stretch', inMins: 20, repeat: 'daily' });
  const everyMins = sc.toReminderSpec({ action: 'remind', text: 'sip water', inMins: 0, repeat: 90 });
  assert.deepStrictEqual(everyMins.repeat, { everyMins: 90 });
});

test('toReminderSpec returns null for non-remind or invalid directives', () => {
  assert.strictEqual(sc.toReminderSpec({ action: 'cal_add', title: 'x', startISO: ISO_A }), null);
  assert.strictEqual(sc.toReminderSpec({ action: 'remind', text: 'x' }), null);
  assert.strictEqual(sc.toReminderSpec(null), null);
});
