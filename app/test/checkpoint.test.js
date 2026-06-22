'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const cp = require('../checkpoint');

test('newId is short, sortable by time at ms precision, and unique', () => {
  assert.equal(cp.newId(1750000000000, 'abcd'), (1750000000000).toString(36) + '-abcd');
  assert.match(cp.newId(), /^[a-z0-9]+-[0-9a-f]{4}$/);
  assert.notEqual(cp.newId(), cp.newId());                              // random tail → unique
  const early = cp.newId(1000000000000, '0000'), late = cp.newId(1750000000000, '0000');
  assert.ok(early < late, 'ids sort by time');
  // the whole point of ms precision: two checkpoints in the SAME second still order correctly by id
  const a = cp.newId(1750000000100, 'ffff'), b = cp.newId(1750000000900, '0000');
  assert.ok(a < b, 'same-second ids order by millisecond');
});

test('ref is namespaced + sanitized (no ref-injection)', () => {
  assert.equal(cp.ref('k3-1a2b'), 'refs/urfael/checkpoints/k3-1a2b');
  assert.equal(cp.ref('../../evil HEAD'), 'refs/urfael/checkpoints/evilHEAD');   // junk + dots stripped
});

test('msgFor / parseMsg round-trip the id + task', () => {
  const m = cp.msgFor('k3-1a2b', '  add a retry to   the client\n ');
  assert.equal(m, 'urfael-cp k3-1a2b :: add a retry to the client');
  assert.deepEqual(cp.parseMsg(m), { id: 'k3-1a2b', task: 'add a retry to the client' });
  assert.equal(cp.parseMsg('some unrelated commit'), null);            // not ours → ignored
});

test('parseList parses for-each-ref output, newest first, skipping non-checkpoint lines', () => {
  const out = [
    '2026-06-22T09:00:00+00:00\tdeadbee\turfael-cp k1-aaaa :: first task',
    '2026-06-22T11:00:00+00:00\tcafef00\turfael-cp k2-bbbb :: second task',
    '2026-06-22T10:00:00+00:00\t0badc0d\tsome random commit',           // not a checkpoint → skipped
  ].join('\n');
  const rows = cp.parseList(out);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'k2-bbbb');                                 // newest first
  assert.equal(rows[0].task, 'second task');
  assert.equal(rows[1].id, 'k1-aaaa');
  assert.equal(rows[0].sha, 'cafef00');
  assert.deepEqual(cp.parseList(''), []);
});

test('parseList breaks a same-second creatordate tie by id (ms precision), newest first', () => {
  const sameSec = '2026-06-22T11:00:00+00:00';
  const older = cp.newId(1750000000100, 'aaaa'), newer = cp.newId(1750000000900, 'bbbb');   // 800ms apart, same second
  const out = [
    sameSec + '\tsha1aaa\t' + cp.msgFor(older, 'older task'),
    sameSec + '\tsha2bbb\t' + cp.msgFor(newer, 'newer task'),
  ].join('\n');
  const rows = cp.parseList(out);
  assert.equal(rows[0].id, newer, 'the later (higher-ms) id wins the tie');
  assert.equal(rows[1].id, older);
});
