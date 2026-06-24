'use strict';
// WhatsApp bridge (Meta Cloud API) — owner-allowlisted control of Urfael.
//
// *** THE ONE CHANNEL THAT NEEDS AN INBOUND WEBHOOK. ***  Every other Urfael bridge is outbound-only; this one
// MUST receive Meta's POSTs. We minimize the blast radius hard:
//   - the http server BINDS TO 127.0.0.1 ONLY — it is NEVER exposed on the network. You point a tunnel
//     (cloudflared / ngrok / a reverse proxy) at 127.0.0.1:PORT and give Meta the tunnel's https url.
//   - every POST's X-Hub-Signature-256 HMAC is verified with WHATSAPP_APP_SECRET via crypto.timingSafeEqual
//     BEFORE the JSON body is parsed — an unsigned/forged body is dropped untouched.
//   - any message whose `from` != WHATSAPP_OWNER_NUMBER is dropped before the brain (audited).
// Owner messages are relayed to POST /ask with channel:'whatsapp' (sandboxed 'untrusted' profile by the daemon).
// Replies go out via POST graph.facebook.com /{phoneId}/messages.
//   node whatsapp-bridge.js            run the bridge (starts the localhost webhook server)
//   node whatsapp-bridge.js --notify "text"   one-way push (used by jobs/brief) to WHATSAPP_OWNER_NUMBER
const http = require('http');
const crypto = require('crypto');
const core = require('./bridge-core');

const cfg = core.loadEnv();
const TOKEN = cfg.WHATSAPP_TOKEN;                 // Graph API access token
const PHONE_ID = cfg.WHATSAPP_PHONE_ID;           // the WhatsApp business phone-number id
const OWNER = String(cfg.WHATSAPP_OWNER_NUMBER || '').replace(/[^\d]/g, ''); // allowlisted sender, digits only
const APP_SECRET = cfg.WHATSAPP_APP_SECRET;       // for X-Hub-Signature-256
const VERIFY_TOKEN = cfg.WHATSAPP_VERIFY_TOKEN;   // echoed during GET webhook verification
const PORT = parseInt(cfg.WHATSAPP_WEBHOOK_PORT || '8788', 10) || 8788;
const bucket = new core.TokenBucket(8, 20);       // 8 burst, ~20/min sustained — bounds a flood/injection loop
const GRAPH = 'graph.facebook.com';

// Send a text message to the owner via the Cloud API. Body capped; token in the Authorization header only.
function send(text, to) {
  return core.httpsJson({ hostname: GRAPH, path: `/v19.0/${PHONE_ID}/messages`, method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' } },
    { messaging_product: 'whatsapp', to: to || OWNER, type: 'text', text: { body: (text || '(empty)').slice(0, 4000) } });
}

async function handle(text, principal) {
  const t0 = Date.now();
  const reply = core.stripSpoken(await core.askDaemon(text, 'whatsapp', principal)); // TEAM MODE: role-scoped + attributed
  try { await send(reply, principal.id); } catch {}                                  // reply to the sender's number
  core.audit({ ev: 'whatsapp_turn', principal: principal.name, role: principal.role, inLen: text.length, outLen: reply.length, ms: Date.now() - t0 });
}

// Constant-time verify of X-Hub-Signature-256 over the RAW request bytes. Returns false on any mismatch or
// malformed header — fail closed. We compute over the exact bytes we received, BEFORE any JSON parsing.
function verifySig(rawBuf, header) {
  if (!header || !APP_SECRET) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(rawBuf).digest('hex');
  return tseq(header, expected);
}
// constant-time equality (length-checked) — used for both the HMAC sig and the GET verify token
function tseq(x, y) {
  const a = Buffer.from(String(x || '')); const b = Buffer.from(String(y || ''));
  if (a.length !== b.length) return false;          // timingSafeEqual throws on length mismatch
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

// Pull owner text messages out of a verified webhook payload. Returns an array of strings to relay.
function extractOwnerTexts(payload) {
  const out = [];
  const entries = (payload && payload.entry) || [];
  for (const entry of entries) {
    for (const ch of (entry.changes || [])) {
      const v = ch.value || {};
      for (const m of (v.messages || [])) {
        if (m.type !== 'text' || !m.text || !m.text.body) continue;     // text only
        const from = String(m.from || '').replace(/[^\d]/g, '');         // E.164 digits, as Meta sends
        const principal = core.resolvePrincipal('whatsapp', from);       // ALLOWLIST (roster ids are digits), before the brain
        if (!principal) { core.audit({ ev: 'whatsapp_drop', from }); continue; }
        out.push({ text: m.text.body, principal });
      }
    }
  }
  return out;
}

// GET = Meta's subscription handshake: echo hub.challenge iff hub.verify_token matches our VERIFY_TOKEN.
function onVerify(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const mode = u.searchParams.get('hub.mode');
  const tok = u.searchParams.get('hub.verify_token');
  const challenge = u.searchParams.get('hub.challenge');
  if (mode === 'subscribe' && tok && VERIFY_TOKEN && tseq(tok, VERIFY_TOKEN)) {
    core.audit({ ev: 'whatsapp_verify_ok' });
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(String(challenge || ''));
  } else {
    core.audit({ ev: 'whatsapp_verify_fail' });
    res.writeHead(403); res.end('forbidden');
  }
}

function onPost(req, res) {
  const chunks = [];
  let n = 0;
  let over = false;
  req.on('data', (d) => { if (over) return; n += d.length; if (n > 1024 * 1024) { over = true; try { res.writeHead(413); res.end(); } catch {} req.destroy(); return; } chunks.push(d); }); // cap body at 1MB, but ANSWER (413) so Meta doesn't retry-storm
  req.on('end', () => {
    if (over) return;                                    // already answered 413 + destroyed; don't process a truncated body
    const raw = Buffer.concat(chunks);
    // VERIFY THE HMAC FIRST, over the raw bytes, before we parse anything attacker-controlled.
    if (!verifySig(raw, req.headers['x-hub-signature-256'])) {
      core.audit({ ev: 'whatsapp_badsig' });
      res.writeHead(403); res.end('bad signature'); return;
    }
    res.writeHead(200); res.end('ok');                  // ack fast so Meta doesn't retry; process async
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { core.audit({ ev: 'whatsapp_badjson' }); return; }
    let msgs;
    try { msgs = extractOwnerTexts(payload); } catch (e) { core.audit({ ev: 'whatsapp_extract_error', err: String((e && e.message) || e) }); return; }
    for (const msg of msgs) {
      if (!bucket.take()) { core.audit({ ev: 'whatsapp_ratelimited', principal: msg.principal.name }); send('Rate limited — one sec.', msg.principal.id).catch(() => {}); continue; }
      handle(msg.text, msg.principal).catch(() => {});
    }
  });
  req.on('error', () => { try { res.writeHead(400); res.end(); } catch {} });
}

async function main() {
  const i = process.argv.indexOf('--notify');
  if (i >= 0) { if (TOKEN && PHONE_ID && OWNER) { try { await send(process.argv[i + 1] || ''); } catch {} } process.exit(0); }
  if (!TOKEN || !PHONE_ID || !OWNER || !APP_SECRET || !VERIFY_TOKEN) {
    console.error('whatsapp-bridge: set WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_OWNER_NUMBER, WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN in ~/.claude/urfael/bridge.env');
    process.exit(1);
  }
  core.warnExperimental('whatsapp');
  const server = http.createServer((req, res) => {
    try {
      if (req.method === 'GET') return onVerify(req, res);
      if (req.method === 'POST') return onPost(req, res);
      res.writeHead(405); res.end('method not allowed');
    } catch (e) { core.audit({ ev: 'whatsapp_handler_error', err: String((e && e.message) || e) }); try { res.writeHead(500); res.end(); } catch {} }
  });
  server.on('error', (e) => { core.audit({ ev: 'whatsapp_server_error', err: String((e && e.message) || e) }); console.error('whatsapp-bridge: ' + ((e && e.message) || e)); process.exit(1); });
  // BIND TO LOOPBACK ONLY. The webhook is never on the network directly — a tunnel/reverse-proxy fronts it.
  server.listen(PORT, '127.0.0.1', () => {
    core.audit({ ev: 'whatsapp_boot', port: PORT });
    console.error('whatsapp-bridge: listening on 127.0.0.1:' + PORT + ' (loopback only — front it with a tunnel; signature-verified, owner-allowlisted)');
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
