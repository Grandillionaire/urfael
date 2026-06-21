'use strict';
// app/bridge/discord-voice-lib.js — the PURE, library-agnostic core of the Discord voice-channel bridge. The heavy
// @discordjs/voice + opus stack lives in the I/O shell (discord-voice-bridge.js); everything testable and security-
// relevant lives here: WHO is allowed to speak to the agent in a voice channel, how a transcribed utterance is gated,
// how a reply is shaped for speech, and the listen/think/speak state machine (with owner barge-in). No I/O, no deps
// beyond lib.js; never throws.
//
// Why this is better than a bolt-on VC voice mode: the speaker gate is the SAME fail-closed allowlist as every other
// channel. Anyone can be in a Discord voice channel, but only an enrolled principal's speech is ever transcribed and
// sent to the brain. A stranger who joins the call is acoustically present and completely powerless. And the STT/TTS
// reuse Urfael's LOCAL pipeline (whisper.cpp in, the local voice out), so voice stays on-device, no cloud.

const lib = require('../lib');

// speakerGate(roster, userId, opts) → { allowed, principal, reason }. opts: { botUserId, ownerOnly }.
// Fail-closed: the bot's own audio is ignored, a non-enrolled speaker is dropped, and an optional owner-only mode
// drops anyone below the owner role. Only an allowed result ever reaches transcription + the brain.
function speakerGate(roster, userId, opts) {
  const o = opts || {};
  const id = String(userId == null ? '' : userId);
  if (!id) return { allowed: false, reason: 'no-id' };
  if (o.botUserId && id === String(o.botUserId)) return { allowed: false, reason: 'self' };
  const principal = lib.resolvePrincipal(roster, 'discord', id);
  if (!principal) return { allowed: false, reason: 'not-enrolled' };
  if (o.ownerOnly && principal.role !== 'owner') return { allowed: false, reason: 'owner-only' };
  return { allowed: true, principal, reason: 'ok' };
}

// toSpeech(text, maxChars) → a clean, speakable string: drop [SPOKEN] control tags, code fences, markdown emphasis,
// and bare URLs (spoken as "a link"), collapse whitespace, and cap the length so a wall of text is not read aloud
// forever. Bounded regexes only (ReDoS-safe). Returns '' for empty input.
function toSpeech(text, maxChars) {
  let s = String(text == null ? '' : text);
  s = s.replace(/\[\/?SPOKEN\]/gi, ' ');
  s = s.replace(/```[\s\S]{0,4000}?```/g, ' (code) ');           // fenced code → a short marker
  s = s.replace(/`([^`]{0,200})`/g, '$1');                       // inline code → its text
  s = s.replace(/\bhttps?:\/\/[^\s)]{1,300}/gi, 'a link');       // URLs are not speakable
  s = s.replace(/[*_#>]+/g, ' ');                                // markdown emphasis / headings
  s = s.replace(/\s+/g, ' ').trim();
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 1500;
  if (s.length > cap) { const cut = s.slice(0, cap); const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? ')); s = (lastStop > cap * 0.5 ? cut.slice(0, lastStop + 1) : cut) + ' That is the short version.'; }
  return s;
}

// splitSentences(text, maxChunk) → sentence-ish chunks for STREAMING TTS, so the bot starts speaking the first
// sentence while the rest synthesizes. Splits on sentence terminators, merges tiny fragments, caps each chunk.
function splitSentences(text, maxChunk) {
  const cap = Number.isFinite(maxChunk) && maxChunk > 0 ? maxChunk : 240;
  const parts = String(text == null ? '' : text).split(/(?<=[.!?])\s+/);
  const out = [];
  let buf = '';
  for (const raw of parts) {
    const p = raw.trim(); if (!p) continue;
    if (!buf) buf = p;
    else if ((buf + ' ' + p).length <= cap) buf += ' ' + p;
    else { out.push(buf); buf = p; }
    while (buf.length > cap) { out.push(buf.slice(0, cap)); buf = buf.slice(cap); }
  }
  if (buf) out.push(buf);
  return out;
}

// the listen → think → speak state machine, with owner barge-in. Pure transition function: next(state, event) →
// state. Events: 'utterance' (a gated speaker finished), 'reply' (brain answered), 'playback-done', 'barge-in'
// (the owner started speaking while the bot was talking → stop and listen). Unknown events leave the state unchanged.
const STATES = ['idle', 'listening', 'thinking', 'speaking'];
function next(state, event) {
  const s = STATES.includes(state) ? state : 'idle';
  switch (event) {
    case 'join': return 'listening';
    case 'utterance': return (s === 'listening' || s === 'idle') ? 'thinking' : s;   // ignore mid-think/speak (single-flight)
    case 'reply': return s === 'thinking' ? 'speaking' : s;
    case 'playback-done': return s === 'speaking' ? 'listening' : s;
    case 'barge-in': return s === 'speaking' ? 'listening' : s;                       // owner interrupts → stop, listen
    case 'leave': return 'idle';
    default: return s;
  }
}
// whether a 'barge-in' should actually interrupt (owner speaking while the bot talks). Pure helper.
function isBargeIn(state, gate) { return state === 'speaking' && gate && gate.allowed && gate.principal && gate.principal.role === 'owner'; }

module.exports = { speakerGate, toSpeech, splitSentences, next, isBargeIn, STATES };
