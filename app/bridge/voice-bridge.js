'use strict';
// app/bridge/voice-bridge.js — a live two-way phone-call channel via Twilio Programmable Voice. Twilio does the STT
// (<Gather input="speech">) and TTS (<Say>), so Urfael touches no raw audio. Inbound rides a LOOPBACK-ONLY HTTP
// receiver (127.0.0.1) that the user fronts with THEIR OWN tunnel (cloudflared/ngrok/ssh -R) and gives to Twilio as
// the number's voice webhook — Urfael opens NO public port itself (same posture as the WhatsApp bridge). The order
// is verify-BEFORE-parse, allowlist-BEFORE-the-brain: HMAC-validate X-Twilio-Signature, parse the caller number,
// resolve it against the roster (drop+audit a stranger), THEN relay the speech to the daemon's sandboxed 'phone'
// channel. STATUS: pure parse/TwiML/allowlist unit-tested; the live call path needs a real Twilio number to certify.
//   node voice-bridge.js   run the receiver (needs TWILIO_AUTH_TOKEN, VOICE_PUBLIC_URL, PHONE_OWNER_NUMBER set)
const http = require('http');
const crypto = require('crypto');
const core = require('./bridge-core');
const vl = require('./voice-lib');

const cfg = core.loadEnv();
const AUTH = cfg.TWILIO_AUTH_TOKEN || '';
const PUBLIC = (cfg.VOICE_PUBLIC_URL || '').replace(/\/$/, '');   // the tunnel base Twilio calls; MUST match or every sig fails
const PORT = Math.min(Math.max(parseInt(cfg.VOICE_WEBHOOK_PORT, 10) || 8789, 1), 65535);
const HOST = '127.0.0.1';
const VOICE = cfg.VOICE_SAY_VOICE || 'Polly.Matthew';
const bucket = new core.TokenBucket(8, 20);

const parseForm = (s) => { const o = {}; for (const kv of String(s || '').split('&')) { if (!kv) continue; const i = kv.indexOf('='); const k = decodeURIComponent((i < 0 ? kv : kv.slice(0, i)).replace(/\+/g, ' ')); const val = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' ')); o[k] = val; } return o; };

// Twilio request signature: HMAC-SHA1(authToken, publicUrl + sorted key+value), base64, vs X-Twilio-Signature.
function sigOk(publicUrl, params, header) {
  if (!AUTH || !header) return false;
  let expected; try { expected = crypto.createHmac('sha1', AUTH).update(vl.twilioSigBase(publicUrl, params)).digest('base64'); } catch { return false; }
  const a = Buffer.from(expected), b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function twiml(res, xml) { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end(xml); }
function forbid(res) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); }

const server = http.createServer((req, res) => {
  const route = (req.url || '').split('?')[0];
  if (req.method !== 'POST' || (route !== '/voice/incoming' && route !== '/voice/turn')) { res.writeHead(404); res.end(); return; }
  // anti-rebinding: only the loopback host or the configured tunnel host may be the Host header
  const host = String(req.headers.host || '').toLowerCase();
  const tunnelHost = (() => { try { return new URL(PUBLIC).host.toLowerCase(); } catch { return ''; } })();
  if (host && host !== HOST + ':' + PORT && host !== HOST && host !== tunnelHost) { forbid(res); return; }
  if (!bucket.take()) { forbid(res); return; }
  let body = '', over = false;
  req.on('data', (d) => { body += d; if (body.length > 65536) { over = true; req.destroy(); } });
  req.on('end', () => {
    if (over) return;
    const params = parseForm(body);
    if (!sigOk(PUBLIC + route, params, req.headers['x-twilio-signature'])) { core.audit({ ev: 'voice_badsig' }); forbid(res); return; }   // verify BEFORE parse/brain
    const parsed = vl.parseTwilioVoice(params);
    if (!parsed) { forbid(res); return; }
    const principal = core.resolvePrincipal('phone', parsed.from);   // ALLOWLIST before the brain, fail-closed
    if (!principal) { core.audit({ ev: 'voice_drop', from: parsed.from }); twiml(res, vl.buildVoiceTwiML('deny', { voice: VOICE, text: 'Sorry, I don’t take calls from this number.' })); return; }
    if (route === '/voice/incoming' || !parsed.speech) { twiml(res, vl.buildVoiceTwiML('greet', { voice: VOICE, action: PUBLIC + '/voice/turn' })); return; }
    // a turn with speech → the sandboxed 'phone' daemon channel, reply spoken back into the same call
    (async () => {
      const t0 = Date.now();
      const reply = core.stripSpoken(await core.askDaemon(parsed.speech, 'phone', principal));
      core.audit({ ev: 'voice_turn', principal: principal.name, role: principal.role, inLen: parsed.speech.length, outLen: reply.length, ms: Date.now() - t0 });
      twiml(res, vl.buildVoiceTwiML('reply', { voice: VOICE, text: reply || 'I have nothing to add.', action: PUBLIC + '/voice/turn' }));
    })().catch(() => { try { twiml(res, vl.buildVoiceTwiML('reply', { voice: VOICE, text: 'One moment, something went wrong.', action: PUBLIC + '/voice/turn' })); } catch {} });
  });
});

if (require.main === module) {
  if (!AUTH || !PUBLIC || !cfg.PHONE_OWNER_NUMBER) { console.error('voice-bridge: set TWILIO_AUTH_TOKEN, VOICE_PUBLIC_URL (your tunnel base), and PHONE_OWNER_NUMBER in ~/.claude/urfael/bridge.env'); process.exit(1); }
  server.listen(PORT, HOST, () => core.audit({ ev: 'voice_boot', port: PORT }));   // 127.0.0.1 ONLY — front it with your own tunnel; Urfael opens no public port
}
module.exports = { server, sigOk };
