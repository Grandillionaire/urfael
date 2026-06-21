'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const v = require('../bridge/discord-voice-lib');

const ROSTER = { discord: [{ id: 'owner1', role: 'owner' }, { id: 'mem1', role: 'member' }] };

// ── the security property: only an enrolled speaker's audio is ever gated through to the brain ──
test('speakerGate fails closed: only enrolled speakers pass, the bot and strangers are dropped', () => {
  assert.equal(v.speakerGate(ROSTER, 'owner1', { botUserId: 'bot' }).allowed, true);
  assert.equal(v.speakerGate(ROSTER, 'owner1').principal.role, 'owner');
  assert.equal(v.speakerGate(ROSTER, 'stranger', {}).allowed, false);             // not on the roster → dropped
  assert.equal(v.speakerGate(ROSTER, 'stranger', {}).reason, 'not-enrolled');
  assert.equal(v.speakerGate(ROSTER, 'bot', { botUserId: 'bot' }).reason, 'self'); // the bot's own audio is ignored
  assert.equal(v.speakerGate(ROSTER, '', {}).allowed, false);
  // owner-only mode drops a member
  assert.equal(v.speakerGate(ROSTER, 'mem1', { ownerOnly: true }).reason, 'owner-only');
  assert.equal(v.speakerGate(ROSTER, 'owner1', { ownerOnly: true }).allowed, true);
});

// ── toSpeech shapes a reply into clean speakable text ──
test('toSpeech strips control tags, code, urls, markdown and caps length', () => {
  const s = v.toSpeech('**Hi** there. [SPOKEN]aside[/SPOKEN] see ```js\ncode\n``` and `inline` at https://example.com/x');
  assert.doesNotMatch(s, /\[SPOKEN\]|```|`|\*\*|https?:/);
  assert.match(s, /Hi there/);
  assert.match(s, /a link/);
  assert.match(s, /\(code\)/);
  const long = v.toSpeech('word. '.repeat(1000), 200);
  assert.ok(long.length <= 260, 'capped');
  assert.match(long, /short version/);
  assert.equal(v.toSpeech(''), '');
});

// ── splitSentences chunks for streaming TTS ──
test('splitSentences yields sentence chunks bounded by maxChunk', () => {
  const out = v.splitSentences('One. Two! Three? Four.', 100);
  assert.ok(out.length >= 1 && out.every((c) => c.length <= 100));
  assert.match(out[0], /One/);
  const big = v.splitSentences('x'.repeat(500), 120);
  assert.ok(big.every((c) => c.length <= 120));
  assert.deepEqual(v.splitSentences(''), []);
});

// ── the listen/think/speak state machine ──
test('next models join, single-flight utterance, reply, playback, barge-in, leave', () => {
  assert.equal(v.next('idle', 'join'), 'listening');
  assert.equal(v.next('listening', 'utterance'), 'thinking');
  assert.equal(v.next('thinking', 'utterance'), 'thinking');     // single-flight: a second utterance mid-think is ignored
  assert.equal(v.next('thinking', 'reply'), 'speaking');
  assert.equal(v.next('speaking', 'playback-done'), 'listening');
  assert.equal(v.next('speaking', 'barge-in'), 'listening');     // interrupted → back to listening
  assert.equal(v.next('speaking', 'nonsense'), 'speaking');      // unknown event → unchanged
  assert.equal(v.next('listening', 'leave'), 'idle');
  assert.equal(v.next('bogus', 'utterance'), 'thinking');        // bad state coerced to idle path
});

// ── barge-in only when the OWNER speaks over the bot ──
test('isBargeIn is true only for the owner interrupting active speech', () => {
  assert.equal(v.isBargeIn('speaking', v.speakerGate(ROSTER, 'owner1')), true);
  assert.equal(v.isBargeIn('speaking', v.speakerGate(ROSTER, 'mem1')), false);   // a member does not interrupt
  assert.equal(v.isBargeIn('listening', v.speakerGate(ROSTER, 'owner1')), false);
});
