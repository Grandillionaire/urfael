'use strict';
// Unit tests for the LOCAL-FIRST calendar store. Node stdlib only, no daemon, no network. Persistence is
// exercised against a temp dir under os.tmpdir() (never the real MEMORY_DIR), and torn down after.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cal = require('../calendar');

// A fixed clock so id/createdAt/bounds assertions are deterministic.
const NOW = Date.parse('2026-06-25T12:00:00Z');
const iso = (s) => Date.parse(s);

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-cal-')); }

test('newId is sortable by ms prefix, random-tailed, and unique', () => {
  assert.equal(cal.newId(1750000000000, 'abcd1234'), (1750000000000).toString(36) + '-abcd1234');
  assert.match(cal.newId(), /^[a-z0-9]+-[0-9a-f]{8}$/);
  const a = cal.newId(1000000000000, '00000000'), b = cal.newId(1750000000000, '00000000');
  assert.ok(a < b, 'earlier ms sorts first');
  assert.notEqual(cal.newId(), cal.newId());
});

test('addEvent: happy path returns a stable id + new store, original untouched', () => {
  const s0 = cal.emptyStore();
  const r = cal.addEvent(s0, { title: 'Dentist', start: '2026-07-01T09:00:00Z', notes: 'molar' }, { nowMs: NOW, id: 'k1-aaaa' });
  assert.equal(r.error, undefined);
  assert.equal(r.event.id, 'k1-aaaa');
  assert.equal(r.event.title, 'Dentist');
  assert.equal(r.event.start, iso('2026-07-01T09:00:00Z'));
  assert.equal(r.event.notes, 'molar');
  assert.equal(r.event.createdAt, new Date(NOW).toISOString());
  assert.equal(r.store.events.length, 1);
  assert.equal(s0.events.length, 0, 'input store was not mutated');
});

test('addEvent: accepts epoch-millis start and an explicit end', () => {
  const start = iso('2026-07-01T09:00:00Z');
  const r = cal.addEvent(cal.emptyStore(), { title: 'Call', start, end: start + 1800000 }, { nowMs: NOW });
  assert.equal(r.event.start, start);
  assert.equal(r.event.end, start + 1800000);
});

test('addEvent: fail-closed on bad input (no title, bad date, negative duration, far future)', () => {
  const s = cal.emptyStore();
  assert.ok(cal.addEvent(s, { title: '', start: '2026-07-01T09:00:00Z' }, { nowMs: NOW }).error);
  assert.ok(cal.addEvent(s, { title: 'x', start: 'not-a-date' }, { nowMs: NOW }).error);
  const start = iso('2026-07-01T09:00:00Z');
  assert.ok(cal.addEvent(s, { title: 'x', start, end: start - 1000 }, { nowMs: NOW }).error, 'end before start');
  assert.ok(cal.addEvent(s, { title: 'x', start: '2099-01-01T00:00:00Z' }, { nowMs: NOW }).error, 'too far out');
});

test('addEvent: sanitizes control chars / newlines in text fields', () => {
  const r = cal.addEvent(cal.emptyStore(), { title: 'a\nb\tc', start: NOW + 60000, notes: 'x\r\ny' }, { nowMs: NOW });
  assert.equal(r.event.title, 'a b c');
  assert.equal(r.event.notes, 'x y');
});

test('listEvents: range filter + sorted by start, canceled excluded', () => {
  let s = cal.emptyStore();
  s = cal.addEvent(s, { title: 'C', start: '2026-08-03T10:00:00Z' }, { nowMs: NOW, id: 'k-c' }).store;
  s = cal.addEvent(s, { title: 'A', start: '2026-08-01T10:00:00Z' }, { nowMs: NOW, id: 'k-a' }).store;
  s = cal.addEvent(s, { title: 'B', start: '2026-08-02T10:00:00Z' }, { nowMs: NOW, id: 'k-b' }).store;
  s = cal.cancelEvent(s, 'k-b', { nowMs: NOW }).store;
  const list = cal.listEvents(s, { fromISO: '2026-08-01T00:00:00Z', toISO: '2026-08-31T00:00:00Z' });
  assert.deepEqual(list.map((e) => e.title), ['A', 'C'], 'sorted, B canceled out');
  // open range
  assert.equal(cal.listEvents(s, {}).length, 2);
});

test('upcoming: next n at/after now, soonest first, n clamped', () => {
  let s = cal.emptyStore();
  s = cal.addEvent(s, { title: 'past', start: NOW - 3600000 }, { nowMs: NOW - 7200000, id: 'k-past' }).store;
  s = cal.addEvent(s, { title: 'soon', start: NOW + 3600000 }, { nowMs: NOW, id: 'k-soon' }).store;
  s = cal.addEvent(s, { title: 'later', start: NOW + 7200000 }, { nowMs: NOW, id: 'k-later' }).store;
  const up = cal.upcoming(s, 5, NOW);
  assert.deepEqual(up.map((e) => e.title), ['soon', 'later'], 'past excluded, soonest first');
  assert.equal(cal.upcoming(s, 1, NOW).length, 1, 'n honored');
  assert.equal(cal.upcoming(s, 9999, NOW).length, 2, 'n clamped, no overrun');
});

test('moveEvent: reschedules; bare shift preserves duration; bad id/date fail-closed', () => {
  const start = iso('2026-07-01T09:00:00Z');
  let s = cal.addEvent(cal.emptyStore(), { title: 'M', start, end: start + 3600000 }, { nowMs: NOW, id: 'k-m' }).store;
  const newStart = iso('2026-07-02T09:00:00Z');
  const r = cal.moveEvent(s, 'k-m', newStart, undefined, { nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.event.start, newStart);
  assert.equal(r.event.end, newStart + 3600000, 'one-hour duration preserved on bare shift');
  assert.ok(r.event.updatedAt);
  assert.equal(cal.moveEvent(s, 'nope', newStart, undefined, { nowMs: NOW }).ok, false, 'unknown id');
  assert.equal(cal.moveEvent(s, 'k-m', 'bad-date', undefined, { nowMs: NOW }).ok, false, 'bad date');
  // explicit end before start is rejected
  assert.equal(cal.moveEvent(s, 'k-m', newStart, newStart - 1000, { nowMs: NOW }).ok, false);
});

test('cancelEvent: tombstones (kept, canceledAt set); idempotent on already-canceled', () => {
  let s = cal.addEvent(cal.emptyStore(), { title: 'X', start: NOW + 60000 }, { nowMs: NOW, id: 'k-x' }).store;
  const r = cal.cancelEvent(s, 'k-x', { nowMs: NOW });
  assert.equal(r.ok, true);
  s = r.store;
  const ev = cal.getEvent(s, 'k-x');
  assert.ok(ev && ev.canceledAt, 'event kept with canceledAt (tombstone, not deletion)');
  assert.equal(cal.cancelEvent(s, 'k-x', { nowMs: NOW }).ok, false, 'second cancel is a no-op');
  assert.equal(cal.upcoming(s, 5, NOW).length, 0, 'canceled not surfaced');
});

test('toICS: valid minimal calendar, escaped + folded, canceled skipped', () => {
  let s = cal.emptyStore();
  s = cal.addEvent(s, { title: 'Lunch; with, Bob', start: iso('2026-07-01T12:00:00Z'), end: iso('2026-07-01T13:00:00Z'), location: 'Cafe' }, { nowMs: NOW, id: 'k-l' }).store;
  s = cal.addEvent(s, { title: 'secret', start: NOW + 60000 }, { nowMs: NOW, id: 'k-s' }).store;
  s = cal.cancelEvent(s, 'k-s', { nowMs: NOW }).store;
  const ics = cal.toICS(cal.listEvents(s, {}), { nowMs: NOW });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'), 'CRLF + header');
  assert.ok(ics.includes('VERSION:2.0'));
  assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'));
  assert.ok(ics.includes('UID:k-l@urfael.local'));
  assert.ok(ics.includes('DTSTART:20260701T120000Z'));
  assert.ok(ics.includes('DTEND:20260701T130000Z'));
  assert.ok(ics.includes('SUMMARY:Lunch\\; with\\, Bob'), 'special chars escaped');
  assert.ok(!ics.includes('secret'), 'canceled event excluded from export');
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
});

test('toICS: long summary is folded to <=75 octets per line', () => {
  const long = 'Z'.repeat(200);
  const s = cal.addEvent(cal.emptyStore(), { title: long, start: NOW + 60000 }, { nowMs: NOW, id: 'k-f' }).store;
  const ics = cal.toICS(cal.listEvents(s, {}), { nowMs: NOW });
  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, 'no content line exceeds 75 octets');
  }
});

test('load: missing/corrupt file is fail-soft -> empty store, never throws', () => {
  const dir = tmpdir();
  try {
    const fp = cal.pathFor(dir);
    assert.deepEqual(cal.load(fp), cal.emptyStore(), 'absent file -> empty');
    fs.writeFileSync(fp, '{ this is not json');
    assert.deepEqual(cal.load(fp), cal.emptyStore(), 'corrupt file -> empty');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save: atomic, 0600, round-trips through load; returns true', () => {
  const dir = tmpdir();
  try {
    const fp = cal.pathFor(dir);
    let s = cal.addEvent(cal.emptyStore(), { title: 'Persisted', start: NOW + 3600000, location: 'Home' }, { nowMs: NOW, id: 'k-p' }).store;
    assert.equal(cal.save(fp, s), true);
    // 0600 perms
    const mode = fs.statSync(fp).mode & 0o777;
    assert.equal(mode, 0o600, 'file is owner-only 0600');
    // no leftover temp file
    assert.equal(fs.existsSync(fp + '.tmp'), false, 'temp file renamed away');
    const back = cal.load(fp);
    assert.equal(back.events.length, 1);
    assert.equal(back.events[0].id, 'k-p');
    assert.equal(back.events[0].title, 'Persisted');
    assert.equal(back.events[0].location, 'Home');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coerceStore: drops garbage rows but keeps valid ones (defensive against hand-edits)', () => {
  const raw = { version: 1, events: [
    { id: 'k-good', title: 'Good', start: NOW + 60000 },
    { id: 'bad id with spaces', title: 'x', start: NOW },        // invalid id -> dropped
    { id: 'k-nostart', title: 'x' },                              // no start -> dropped
    null,                                                        // junk -> dropped
    { id: 'k-also', title: 'Also', start: '2026-09-01T00:00:00Z' },
  ] };
  const s = cal.coerceStore(raw);
  assert.deepEqual(s.events.map((e) => e.id).sort(), ['k-also', 'k-good']);
});

test('pathFor: resolves MEMORY_DIR/calendar.json', () => {
  assert.equal(cal.pathFor('/home/u/Urfael-memory'), path.join('/home/u/Urfael-memory', 'calendar.json'));
});
