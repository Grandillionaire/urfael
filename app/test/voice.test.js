'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const v = require('../bridge/voice-lib');
const lib = require('../lib');

test('normalizeNumber strips to E.164 digits, fail-closed on implausible input', () => {
  assert.equal(v.normalizeNumber('+1 (555) 123-4567'), '15551234567');
  assert.equal(v.normalizeNumber('555.000.1111'), '5550001111');
  assert.equal(v.normalizeNumber('12'), '');           // too short
  assert.equal(v.normalizeNumber(''), '');
  assert.equal(v.normalizeNumber(null), '');
});

test('parseTwilioVoice shapes a valid inbound webhook and is fail-closed on a bad/absent CallSid or From', () => {
  const r = v.parseTwilioVoice({ CallSid: 'CA1234567890abcdef', From: '+15551234567', SpeechResult: 'what is on my calendar', Direction: 'inbound' });
  assert.deepEqual(r, { from: '15551234567', callSid: 'CA1234567890abcdef', speech: 'what is on my calendar', direction: 'inbound' });
  assert.equal(v.parseTwilioVoice({ From: '+15551234567' }), null);              // no call sid
  assert.equal(v.parseTwilioVoice({ CallSid: 'XX123', From: '+15551234567' }), null); // not a CA sid
  assert.equal(v.parseTwilioVoice({ CallSid: 'CA1234567890abcdef', From: 'abc' }), null); // unparseable from
  assert.equal(v.parseTwilioVoice(null), null);
  // first hit (no speech yet) is still valid → drives the greeting
  assert.equal(v.parseTwilioVoice({ CallSid: 'CA1234567890abcdef', From: '+15551234567' }).speech, '');
});

test('twilioSigBase concatenates the public URL + alpha-sorted key+value (the exact thing Twilio signs)', () => {
  const base = v.twilioSigBase('https://x.tunnel/voice/turn', { From: '+1555', CallSid: 'CA9', Digits: '' });
  assert.equal(base, 'https://x.tunnel/voice/turnCallSidCA9DigitsFrom+1555');   // CallSid < Digits < From
});

test('buildVoiceTwiML escapes untrusted text so a reply with markup characters can not break the XML', () => {
  const xml = v.buildVoiceTwiML('reply', { text: 'A & B < C > "D" said it\'s <Hangup/>', action: '/voice/turn' });
  assert.ok(xml.includes('<Response>') && xml.includes('</Response>'));
  assert.ok(!xml.includes('<Hangup/></Say>'), 'an injected tag in the reply text must be escaped, not emitted as markup');
  assert.ok(xml.includes('&amp;') && xml.includes('&lt;') && xml.includes('&gt;') && xml.includes('&quot;'));
  assert.match(v.buildVoiceTwiML('greet', {}), /<Gather input="speech"[\s\S]*<Hangup\/>/);
  assert.match(v.buildVoiceTwiML('deny', { text: 'no' }), /<Say[^>]*>no<\/Say><Hangup\/>/);
  // a hostile voice value falls back to the safe default (no attribute injection)
  assert.ok(v.buildVoiceTwiML('reply', { voice: '"/><Hangup', text: 'x' }).includes('Polly.Matthew'));
});

test('the phone allowlist is fail-closed: only an enrolled caller number resolves to a principal', () => {
  const roster = { phone: [{ id: '15551234567', role: 'owner', name: 'me' }] };
  assert.ok(lib.resolvePrincipal(roster, 'phone', '15551234567'));
  assert.equal(lib.resolvePrincipal(roster, 'phone', '19998887777'), null);   // a random caller is dropped before the brain
  assert.ok(lib.TEAM_CHANNELS.includes('phone'));
});
