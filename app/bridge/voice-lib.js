'use strict';
// app/bridge/voice-lib.js — the PURE, side-effect-free core of the PSTN voice channel (Twilio Programmable Voice).
// No network, no fs, never throws — fully unit-testable. The live shell (voice-bridge.js) does the loopback HTTP +
// HMAC verify + the daemon relay. Twilio does the STT (<Gather input="speech">) and TTS (<Say>), so Urfael touches
// no raw call audio. The caller's phone number is the allowlist key (normalized to digits), checked BEFORE the brain.

// normalizeNumber → digits only (E.164 without the +); '' if implausible (fail-closed).
function normalizeNumber(s) { const d = String(s == null ? '' : s).replace(/[^\d]/g, ''); return (d.length >= 7 && d.length <= 15) ? d : ''; }

// parseTwilioVoice(params) → { from, callSid, speech, direction } | null. Shapes only; no allowlist here.
// null on a missing/non-call CallSid or an unparseable From — a malformed webhook never reaches the brain.
function parseTwilioVoice(params) {
  const callSid = String((params && params.CallSid) || '').trim();
  if (!/^CA[a-f0-9]{8,}$/i.test(callSid)) return null;        // a real Twilio call sid
  const from = normalizeNumber(params && params.From);
  if (!from) return null;
  return { from, callSid, speech: String((params && params.SpeechResult) || '').trim(), direction: String((params && params.Direction) || '') };
}

// twilioSigBase(publicUrl, params) → the EXACT string Twilio signs for a POST webhook: the full public URL followed
// by each POST param's key+value, keys sorted alphabetically. The shell HMAC-SHA1s this with the auth token and
// timing-safe-compares it to X-Twilio-Signature. Pure string assembly so the signature check is testable offline.
function twilioSigBase(publicUrl, params) {
  let base = String(publicUrl || '');
  for (const k of Object.keys(params || {}).sort()) base += k + String(params[k]);
  return base;
}

function xmlEscape(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }

// buildVoiceTwiML(kind, opts) → a TwiML XML string. kind: 'greet' (ask + no-input hangup), 'reply' (speak the brain
// answer + gather the next turn), 'deny'/'bye' (speak + hangup). Every dynamic string is XML-escaped (the brain
// reply and the caller's speech are untrusted), so a reply containing &, <, or a quote can't break the markup.
function buildVoiceTwiML(kind, opts = {}) {
  const say = /^[\w.-]{1,40}$/.test(String(opts.voice || '')) ? opts.voice : 'Polly.Matthew';
  const action = xmlEscape(opts.action || '/voice/turn');
  const gather = (prompt) => `<Gather input="speech" speechTimeout="auto" speechModel="phone_call" action="${action}" method="POST"><Say voice="${say}">${xmlEscape(prompt)}</Say></Gather>`;
  const head = '<?xml version="1.0" encoding="UTF-8"?><Response>';
  if (kind === 'greet') return head + gather(opts.greeting || 'Urfael here, sir. How can I help?') + `<Say voice="${say}">${xmlEscape(opts.noInput || 'I did not catch that. Goodbye.')}</Say><Hangup/></Response>`;
  if (kind === 'reply') return head + `<Say voice="${say}">${xmlEscape(opts.text || '')}</Say>` + gather(opts.followup || 'Anything else?') + '</Response>';
  return head + `<Say voice="${say}">${xmlEscape(opts.text || 'Sorry, I can’t take this call.')}</Say><Hangup/></Response>`;   // deny / bye
}

module.exports = { normalizeNumber, parseTwilioVoice, twilioSigBase, xmlEscape, buildVoiceTwiML };
