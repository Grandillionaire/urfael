'use strict';
// app/bridge/webhook-bridge.js — the native webhook channels (Mattermost, Google Chat, SMS, DingTalk, Home
// Assistant, BlueBubbles, Feishu, WeCom) on ONE loopback-only receiver. Mirrors the hooks receiver's hardening
// (127.0.0.1 only, Host-gate anti-rebinding, rate limit, body cap) so the daemon never opens a port: tunnel your own
// (cloudflared / ngrok) to accept public events. The adapter (webhook-lib) only verifies + extracts {senderId,text};
// THIS shell runs the one fail-closed allowlist (resolvePrincipal -> null -> DROP) before the brain, for every
// channel, then asks the daemon and answers in the HTTP response where the platform supports it.
//   node app/bridge/webhook-bridge.js
const http = require('http');
const querystring = require('querystring');
const core = require('./bridge-core');
const wh = require('./webhook-lib');

const HOST = '127.0.0.1';
const PORT = Math.min(Math.max(parseInt(process.env.URFAEL_WEBHOOK_PORT, 10) || 7719, 1), 65535);
const MAX_BODY = 262144;                                                        // 256KB (chat payloads + media metadata)
const limiter = new core.TokenBucket(120, 600);                                // bounds raw POST volume (loopback shares one ip)

function readBody(req) {
  return new Promise((resolve) => { let b = '', over = false;
    req.on('data', (c) => { if (over) return; b += c; if (b.length > MAX_BODY) { over = true; try { req.destroy(); } catch {} resolve(null); } });
    req.on('end', () => { if (!over) resolve(b); }); req.on('error', () => resolve(null)); });
}

// parse the raw body by content-type into an object (JSON or form), never throwing.
function parseBody(raw, ctype) {
  const s = String(raw || '');
  if (/json/i.test(ctype)) { try { return JSON.parse(s); } catch { return {}; } }
  if (/x-www-form-urlencoded/i.test(ctype)) { try { return querystring.parse(s); } catch { return {}; } }
  try { return JSON.parse(s); } catch {}
  try { return querystring.parse(s); } catch { return {}; }
}
const lower = (h) => { const o = {}; for (const k in (h || {})) o[k.toLowerCase()] = Array.isArray(h[k]) ? h[k][0] : h[k]; return o; };

const server = http.createServer(async (req, res) => {
  const reqHost = String(req.headers.host || '').split(':')[0];
  if (reqHost !== '127.0.0.1' && reqHost !== 'localhost') { res.writeHead(400); res.end(); return; }   // anti-rebinding
  if (!limiter.take()) { res.writeHead(429); res.end('slow down'); return; }

  let u; try { u = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end(); return; }
  const m = u.pathname.match(/^\/wh\/([a-z]+)$/);
  if (req.method !== 'POST' || !m || !wh.isChannel(m[1])) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"not found"}'); return; }
  const channel = m[1];

  const raw = await readBody(req);
  if (raw === null) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end('{"error":"too large"}'); return; }
  const headers = lower(req.headers);
  const body = parseBody(raw, headers['content-type'] || '');
  const query = Object.fromEntries(u.searchParams.entries());
  const cfg = core.loadEnv();
  // the public URL the platform signed (behind a tunnel, set URFAEL_WEBHOOK_PUBLIC_URL to the tunnel base).
  const url = (cfg.URFAEL_WEBHOOK_PUBLIC_URL ? cfg.URFAEL_WEBHOOK_PUBLIC_URL.replace(/\/+$/, '') : ('https://' + String(req.headers.host || ''))) + u.pathname;
  const ctx = { body, raw, headers, query, url, cfg };

  // Feishu URL-verification handshake (plaintext token mode): echo the challenge once the token matches.
  if (channel === 'feishu' && body && body.type === 'url_verification') {
    if (wh.tsEqual(body.token, cfg.FEISHU_VERIFY_TOKEN) && cfg.FEISHU_VERIFY_TOKEN) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ challenge: String(body.challenge || '') })); }
    else { res.writeHead(401); res.end(); }
    return;
  }

  const d = wh.dispatch(channel, ctx);
  if (!d.ok) {
    core.audit({ ev: 'webhook_reject', channel, reason: d.reason });
    res.writeHead(d.reason === 'bad-signature' ? 401 : 400, { 'Content-Type': 'application/json' }); res.end('{"error":"rejected"}');   // generic, no enumeration
    return;
  }

  // THE ALLOWLIST, before the brain: an unknown sender is dropped, every channel, fail-closed.
  const principal = core.resolvePrincipal(channel, d.senderId);
  if (!principal) {
    // a never-enrolled sender may redeem a pairing code as a GUEST only (same as the other bridges); else dropped.
    const paired = await core.tryPair(channel, d.senderId, d.text);
    if (!(paired && paired.ok)) { core.audit({ ev: 'webhook_drop', channel, sender: d.senderId }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
    core.audit({ ev: 'webhook_pair', channel, sender: d.senderId });
    const rep = wh.formatReply(channel, 'You are paired as a guest. Send a message to begin.');
    res.writeHead(200, { 'Content-Type': (rep && rep.type) || 'application/json' }); res.end((rep && rep.body) || '{"ok":true}'); return;
  }

  let reply = '';
  try { reply = core.stripSpoken(await core.askDaemon(d.text, channel, principal)); } catch {}
  const rep = wh.formatReply(channel, reply || '…');
  core.audit({ ev: 'webhook_turn', channel, role: principal.role, replied: !!rep });
  if (rep) { res.writeHead(200, { 'Content-Type': rep.type, 'Cache-Control': 'no-store' }); res.end(rep.body); }
  else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }   // async-send channels: delivery is the live-cert step
});

server.on('error', (e) => { process.stderr.write('urfael webhook bridge: cannot bind ' + HOST + ':' + PORT + ' — ' + ((e && e.message) || e) + '\n'); process.exit(1); });

if (require.main === module) {
  server.listen(PORT, HOST, () => { process.stdout.write('Urfael native webhook channels on http://' + HOST + ':' + PORT + '/wh/<channel>  (loopback only — tunnel to it for external events)\n'); });
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}
module.exports = { server, parseBody, PORT, HOST };
