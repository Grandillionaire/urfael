'use strict';
// Urfael webhook receiver — a LOOPBACK-ONLY (127.0.0.1) front that lets external events trigger the brain
// WITHOUT ever opening a port on the daemon (the daemon stays a unix socket — the no-inbound-port moat holds).
// OFF by default; started explicitly with `urfael hooks`. Each hook authenticates with its own 256-bit secret,
// which THIS process never stores or validates: it forwards (secret, payload) to the daemon over the socket, and
// the daemon checks the secret CONSTANT-TIME against the hashed registry and runs the sandboxed action. To accept
// events from the public internet, point YOUR OWN tunnel (cloudflared / ngrok / `ssh -R`) at this port — nothing
// is ever exposed on your behalf. Mirrors the dashboard's loopback hardening (Host gate, rate limit, body cap).
//   node app/hooks.js        (or `urfael hooks`)
const http = require('http');
const os = require('os');
const path = require('path');

const HOST = '127.0.0.1';                                                       // loopback ONLY — never 0.0.0.0 / LAN
const PORT = Math.min(Math.max(parseInt(process.env.URFAEL_HOOKS_PORT, 10) || 7718, 1), 65535);
const ipc = require('./ipc');
const SOCK = ipc.daemonSock();   // 0600 unix socket on POSIX; per-user named pipe + token on native Windows (see app/ipc.js)
const MAX_BODY = 65536;                                                         // 64KB payload cap

// per-IP token bucket — all loopback shares 127.0.0.1, so this just bounds raw POST volume to protect the brain
// (the real per-hook auth + brain single-flight live in the daemon). Generous, to not throttle legitimate bursts.
class Bucket { constructor(cap, perMin) { this.cap = cap; this.tok = cap; this.rate = perMin / 60000; this.last = Date.now(); }
  take() { const n = Date.now(); this.tok = Math.min(this.cap, this.tok + (n - this.last) * this.rate); this.last = n; if (this.tok >= 1) { this.tok -= 1; return true; } return false; } }
const buckets = new Map();
function rateOk(ip) {
  let b = buckets.get(ip); if (!b) { b = new Bucket(120, 600); buckets.set(ip, b); }            // 120 burst, ~600/min/ip
  if (buckets.size > 1024) for (const k of buckets.keys()) { buckets.delete(k); if (buckets.size <= 512) break; }
  return b.take();
}

// bounded body reader: resolves null past the cap (the handler 413s) so a huge POST can't balloon memory.
function readBody(req) {
  return new Promise((resolve) => { let b = '', over = false;
    req.on('data', (c) => { if (over) return; b += c; if (b.length > MAX_BODY) { over = true; try { req.destroy(); } catch {} resolve(null); } });
    req.on('end', () => { if (!over) resolve(b); }); req.on('error', () => resolve(null)); });
}

// forward a fire to the daemon over the unix socket. The daemon does the constant-time secret check + dispatch.
function daemonFire(id, secret, payload) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ secret, payload });
    const r = http.request({ socketPath: SOCK, method: 'POST', path: '/hook/' + id, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...ipc.authHeaders() }, timeout: 20000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode || 502, body: b }));
    });
    r.on('error', () => resolve({ status: 502, body: '{"error":"daemon unreachable"}' }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 504, body: '{"error":"timeout"}' }); });
    r.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  // anti-DNS-rebinding: a loopback-only surface must only answer to a loopback Host header.
  const host = (req.headers.host || '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') { res.writeHead(400); res.end(); return; }
  const ip = (req.socket && req.socket.remoteAddress) || 'local';
  if (!rateOk(ip)) { res.writeHead(429, { 'Content-Type': 'text/plain' }); res.end('slow down'); return; }

  let u; try { u = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end(); return; }
  const m = u.pathname.match(/^\/hook\/(hk_[0-9a-f]{12})$/);                    // the ONLY route; no fs mapping ever
  if (req.method !== 'POST' || !m) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"not found"}'); return; }

  // secret rides in a header (preferred) or ?secret= (for senders that can't set headers). The daemon validates it.
  const hdr = req.headers['x-urfael-hook'];
  const secret = (typeof hdr === 'string' && hdr) || u.searchParams.get('secret') || '';
  const payload = await readBody(req);
  if (payload === null) { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end('{"error":"payload too large"}'); return; }

  const out = await daemonFire(m[1], String(secret), payload);
  res.writeHead(out.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(out.body || '{}');
});

server.on('error', (e) => { process.stderr.write('urfael hooks: cannot bind ' + HOST + ':' + PORT + ' — ' + ((e && e.message) || e) + '\n'); process.exit(1); });

if (require.main === module) {
  server.listen(PORT, HOST, () => { process.stdout.write('Urfael webhook receiver on http://' + HOST + ':' + PORT + '  (loopback only — tunnel to it for external events)\n'); });
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}
module.exports = { server, daemonFire };
