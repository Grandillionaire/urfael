'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const wh = require('../bridge/webhook-lib');

// ── timing-safe compare: equal passes, unequal/length-mismatch fails, never throws ──
test('tsEqual is correct and total', () => {
  assert.equal(wh.tsEqual('abc', 'abc'), true);
  assert.equal(wh.tsEqual('abc', 'abd'), false);
  assert.equal(wh.tsEqual('abc', 'abcd'), false);        // length mismatch → false, no throw
  assert.equal(wh.tsEqual('', 'x'), false);
  assert.equal(wh.tsEqual(null, undefined), true);       // both empty
});

// ── every adapter FAILS CLOSED when its secret is not configured ──
test('every adapter rejects when its shared secret/token is unset', () => {
  for (const ch of wh.CHANNELS) {
    const r = wh.dispatch(ch, { cfg: {}, body: {}, headers: {}, query: {} });
    assert.equal(r.ok, false, ch + ' must fail closed with no secret');
  }
});

// ── Mattermost: token + parse + JSON reply ──
test('mattermost verifies the token and extracts sender + text', () => {
  const cfg = { MATTERMOST_TOKEN: 'tok123' };
  const ok = wh.dispatch('mattermost', { cfg, body: { token: 'tok123', user_id: 'u9', text: ' hi there ' }, headers: {}, query: {} });
  assert.deepEqual(ok, { ok: true, senderId: 'u9', text: 'hi there' });
  assert.equal(wh.dispatch('mattermost', { cfg, body: { token: 'WRONG', user_id: 'u9', text: 'x' } }).reason, 'bad-signature');
  assert.match(wh.formatReply('mattermost', 'reply').body, /"text":"reply"/);
});

// ── Google Chat: shared token + nested sender/text ──
test('googlechat verifies the token and reads message.sender.name + message.text', () => {
  const cfg = { GOOGLECHAT_TOKEN: 'g-secret' };
  const ok = wh.dispatch('googlechat', { cfg, query: { token: 'g-secret' }, body: { message: { text: 'hello', sender: { name: 'users/123' } } }, headers: {} });
  assert.deepEqual(ok, { ok: true, senderId: 'users/123', text: 'hello' });
  assert.equal(wh.dispatch('googlechat', { cfg, query: { token: 'no' }, body: {} }).ok, false);
});

// ── SMS via Twilio: real HMAC-SHA1 over (url + sorted params) against X-Twilio-Signature ──
test('sms verifies the Twilio request signature and replies with escaped TwiML', () => {
  const cfg = { TWILIO_AUTH_TOKEN: 'authtok' };
  const url = 'https://me.example/wh/sms', body = { From: '+15551234567', Body: 'ping' };
  const sig = wh.hmac('sha1', cfg.TWILIO_AUTH_TOKEN, wh.twilioBase(url, body), 'base64');
  const ok = wh.dispatch('sms', { cfg, url, body, headers: { 'x-twilio-signature': sig }, query: {} });
  assert.deepEqual(ok, { ok: true, senderId: '+15551234567', text: 'ping' });
  assert.equal(wh.dispatch('sms', { cfg, url, body, headers: { 'x-twilio-signature': 'forged' } }).reason, 'bad-signature');
  assert.match(wh.formatReply('sms', 'a<b>&c').body, /a&lt;b&gt;&amp;c<\/Message>/);   // XML-escaped
});

// ── DingTalk: HMAC-SHA256 sign + timestamp freshness ──
test('dingtalk verifies the signature and rejects a stale timestamp', () => {
  const cfg = { DINGTALK_SECRET: 'dsec' };
  const ts = 1750000000000;                              // a fixed ms timestamp
  const sign = wh.hmac('sha256', cfg.DINGTALK_SECRET, ts + '\n' + cfg.DINGTALK_SECRET, 'base64');
  // fresh path: make Date.now near ts by using a timestamp the verify treats as within ±1h of "now" → use a recent ts
  const recent = Date.now() - 1000;
  const sign2 = wh.hmac('sha256', cfg.DINGTALK_SECRET, recent + '\n' + cfg.DINGTALK_SECRET, 'base64');
  const ok = wh.dispatch('dingtalk', { cfg, query: { timestamp: String(recent), sign: sign2 }, body: { text: { content: 'hey' }, senderStaffId: 's1' }, headers: {} });
  assert.deepEqual(ok, { ok: true, senderId: 's1', text: 'hey' });
  assert.equal(wh.dispatch('dingtalk', { cfg, query: { timestamp: String(ts), sign }, body: { text: { content: 'hey' }, senderStaffId: 's1' } }).reason, 'bad-signature'); // stale → rejected
});

// ── Home Assistant: bearer/token + text ──
test('homeassistant verifies the token and reads the conversation text', () => {
  const cfg = { HOMEASSISTANT_TOKEN: 'ha-tok' };
  const ok = wh.dispatch('homeassistant', { cfg, headers: { authorization: 'Bearer ha-tok' }, body: { text: 'turn on the lights', sender: 'kitchen' }, query: {} });
  assert.deepEqual(ok, { ok: true, senderId: 'kitchen', text: 'turn on the lights' });
});

// ── BlueBubbles: password + nested handle/text ──
test('bluebubbles verifies the password and reads data.handle.address + data.text', () => {
  const cfg = { BLUEBUBBLES_PASSWORD: 'bb-pass' };
  const ok = wh.dispatch('bluebubbles', { cfg, query: { password: 'bb-pass' }, body: { data: { text: 'sup', handle: { address: '+15550001111' } } }, headers: {} });
  assert.deepEqual(ok, { ok: true, senderId: '+15550001111', text: 'sup' });
  assert.equal(wh.dispatch('bluebubbles', { cfg, query: { password: 'no' }, body: {} }).ok, false);
});

// ── Feishu: verification token + JSON-encoded message content ──
test('feishu verifies the token and decodes the message content', () => {
  const cfg = { FEISHU_VERIFY_TOKEN: 'fs-tok' };
  const ok = wh.dispatch('feishu', { cfg, body: { token: 'fs-tok', event: { message: { content: JSON.stringify({ text: 'hola' }) }, sender: { sender_id: { open_id: 'ou_1' } } } }, headers: {}, query: {} });
  assert.deepEqual(ok, { ok: true, senderId: 'ou_1', text: 'hola' });
});

// ── WeCom: msg_signature = sha1(sorted(token, timestamp, nonce, encrypt)) ──
test('wecom verifies the sorted-sha1 message signature', () => {
  const cfg = { WECOM_TOKEN: 'wc-tok' };
  const crypto = require('crypto');
  const ts = '1750000000', nonce = 'abc', enc = 'ENCRYPTED';
  const sig = crypto.createHash('sha1').update([cfg.WECOM_TOKEN, ts, nonce, enc].sort().join('')).digest('hex');
  const ok = wh.dispatch('wecom', { cfg, query: { msg_signature: sig, timestamp: ts, nonce, echostr: enc }, body: { from: 'fromuser', text: 'ni hao' }, headers: {} });
  assert.deepEqual(ok, { ok: true, senderId: 'fromuser', text: 'ni hao' });
  assert.equal(wh.dispatch('wecom', { cfg, query: { msg_signature: 'bad', timestamp: ts, nonce, echostr: enc }, body: {} }).ok, false);
});

// ── dispatch is fail-closed on an unknown channel and never throws on junk ──
test('dispatch fails closed on unknown channel and hostile input', () => {
  assert.equal(wh.dispatch('nope', { cfg: {} }).reason, 'unknown-channel');
  assert.doesNotThrow(() => wh.dispatch('mattermost', {}));
  assert.doesNotThrow(() => wh.dispatch('sms', { cfg: { TWILIO_AUTH_TOKEN: 'x' }, body: null, headers: null, query: null }));
});
