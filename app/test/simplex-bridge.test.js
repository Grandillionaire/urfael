'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const lib = require('../lib');

const direct = (text, dir) => ({ type: 'newChatItems', chatItems: [{
  chatInfo: { type: 'direct', contact: { contactId: 5, localDisplayName: 'alice' } },
  chatItem: { chatDir: { type: dir || 'directRcv' }, content: { type: dir === 'directSnd' ? 'sndMsgContent' : 'rcvMsgContent', msgContent: { type: 'text', text } } },
}] });

// ── parseSimplexEvent: normalize a Direct receive, fail-closed on self / group / no-text / wrong-type ──
test('parseSimplexEvent extracts {contactId,text} from a Direct received message (key is the integer contactId)', () => {
  assert.deepEqual(lib.parseSimplexEvent(direct('hi there')), { contactId: '5', text: 'hi there' });
});
test('parseSimplexEvent is fail-closed on the self-loop, a group, no text, and the wrong response type', () => {
  assert.equal(lib.parseSimplexEvent(direct('my own echo', 'directSnd')), null);   // outbound = our own send → self-loop guard
  const group = { type: 'newChatItems', chatItems: [{ chatInfo: { type: 'group', groupInfo: {} }, chatItem: { chatDir: { type: 'groupRcv' }, content: { type: 'rcvMsgContent', msgContent: { type: 'text', text: 'x' } } } }] };
  assert.equal(lib.parseSimplexEvent(group), null);                                  // only Direct is bridged
  const noText = { type: 'newChatItems', chatItems: [{ chatInfo: { type: 'direct', contact: { contactId: 5 } }, chatItem: { chatDir: { type: 'directRcv' }, content: { type: 'rcvMsgContent', msgContent: { type: 'image' } } } }] };
  assert.equal(lib.parseSimplexEvent(noText), null);                                 // no extractable text
  assert.equal(lib.parseSimplexEvent({ type: 'contactConnected', contact: { contactId: 9 } }), null);  // not a message
  assert.equal(lib.parseSimplexEvent(null), null);
  assert.equal(lib.parseSimplexEvent('garbage'), null);
});

// ── allowlist-before-the-brain: only an enrolled contactId resolves (the local id, never the display name) ──
test('the simplex allowlist is fail-closed on the local contactId', () => {
  const roster = { simplex: [{ id: '5', role: 'owner', name: 'me' }] };
  assert.ok(lib.resolvePrincipal(roster, 'simplex', '5'));
  assert.equal(lib.resolvePrincipal(roster, 'simplex', '99'), null);     // a stranger who connected via the public address is dropped
  assert.ok(lib.TEAM_CHANNELS.includes('simplex'));
});
