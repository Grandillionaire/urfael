'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const qq = require('../bridge/qq-bridge');
const lib = require('../lib');

// ── parseEvent: normalize each surface, fail-closed on self / non-text / unknown ───────────────────
test('parseEvent normalizes a C2C (DM) message to the user_openid', () => {
  const r = qq.parseEvent({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'm1', content: 'hello', author: { user_openid: 'U123' } } });
  assert.deepEqual(r, { senderId: 'U123', text: 'hello', msgId: 'm1', target: { kind: 'c2c', openid: 'U123' } });
});
test('parseEvent normalizes a group @-message to the member_openid and strips the mention', () => {
  const r = qq.parseEvent({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'm2', content: '<@!999> ping', group_openid: 'G1', author: { member_openid: 'M55' } } });
  assert.deepEqual(r, { senderId: 'M55', text: 'ping', msgId: 'm2', target: { kind: 'group', openid: 'G1' } });
});
test('parseEvent normalizes a guild message to author.id + channel target', () => {
  const r = qq.parseEvent({ op: 0, t: 'AT_MESSAGE_CREATE', d: { id: 'm3', content: 'yo', channel_id: 'C9', author: { id: 'A1' } } });
  assert.deepEqual(r, { senderId: 'A1', text: 'yo', msgId: 'm3', target: { kind: 'guild', channelId: 'C9' } });
});
test('parseEvent is fail-closed: self-loop, empty text, unknown type, non-dispatch all return null', () => {
  assert.equal(qq.parseEvent({ op: 0, t: 'AT_MESSAGE_CREATE', d: { id: 'm', content: 'x', author: { id: 'BOT' } } }, 'BOT'), null);  // self
  assert.equal(qq.parseEvent({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'm', content: '   ', author: { user_openid: 'U' } } }), null); // no text
  assert.equal(qq.parseEvent({ op: 0, t: 'GUILD_CREATE', d: {} }), null);                       // unknown event
  assert.equal(qq.parseEvent({ op: 11 }), null);                                                 // heartbeat ack, not a dispatch
  assert.equal(qq.parseEvent(null), null);
});

// ── buildIntents / nextMsgSeq ───────────────────────────────────────────────────────────────────────
test('buildIntents defaults to GROUP_AND_C2C, adds the guild bits only when asked', () => {
  assert.equal(qq.buildIntents(), 1 << 25);
  assert.equal(qq.buildIntents({ guildDm: true }), (1 << 25) | (1 << 30) | (1 << 12));
});
test('nextMsgSeq increments per msg_id (passive replies need a fresh seq)', () => {
  const m = new Map();
  assert.equal(qq.nextMsgSeq(m, 'a'), 1);
  assert.equal(qq.nextMsgSeq(m, 'a'), 2);
  assert.equal(qq.nextMsgSeq(m, 'b'), 1);
});

// ── allowlist-before-the-brain: a non-enrolled openid is dropped, the owner resolves ───────────────
test('the qq allowlist is fail-closed: only an enrolled context-scoped openid resolves to a principal', () => {
  const roster = { qq: [{ id: 'U123', role: 'owner', name: 'me' }] };
  assert.ok(lib.resolvePrincipal(roster, 'qq', 'U123'));            // enrolled → principal
  assert.equal(lib.resolvePrincipal(roster, 'qq', 'STRANGER'), null);  // not enrolled → dropped before the brain
  assert.equal(lib.resolvePrincipal(roster, 'discord', 'U123'), null);  // right openid, WRONG channel → dropped (no cross-surface leak)
  assert.ok(lib.TEAM_CHANNELS.includes('qq'));
});
