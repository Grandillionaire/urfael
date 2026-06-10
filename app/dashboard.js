'use strict';
// Urfael dashboard — a token-gated LOCALHOST web surface (a browser console for the brain). This is a NEW
// network surface, so it is locked down hard: bound STRICTLY to 127.0.0.1 (never 0.0.0.0 — nothing on the LAN
// can reach it), every request must present a 32-byte hex token (header x-urfael-token OR a cookie set after a
// ?token= match) compared in CONSTANT TIME, per-IP token-bucket rate limit, and NO arbitrary path serving (the
// URL never names a file → no traversal). It proxies the daemon's unix socket; it holds no secrets of its own
// beyond the page token. Refuses to start if it can't bind loopback.
//   node app/dashboard.js        (or via the com.urfael.dashboard launchd plist)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOST = '127.0.0.1';                                  // loopback ONLY — never 0.0.0.0, never a LAN/public iface
const PORT = Math.min(Math.max(parseInt(process.env.URFAEL_DASHBOARD_PORT, 10) || 7717, 1), 65535);
const JDIR = path.join(os.homedir(), '.claude', 'urfael');
const SOCK = path.join(JDIR, 'daemon.sock');
const TOKENF = path.join(JDIR, 'dashboard.token');
const MAX_BODY = 262144;                                   // 256KB request-body cap (mirror the daemon)

// ---- token: generate-once, 0600, never world-readable --------------------------------------------
function loadOrCreateToken() {
  try {
    const t = fs.readFileSync(TOKENF, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(t)) { try { fs.chmodSync(TOKENF, 0o600); } catch {} return t; } // re-assert 0600 in case it drifted
  } catch {}
  const t = crypto.randomBytes(32).toString('hex');
  try { fs.mkdirSync(JDIR, { recursive: true }); } catch {}
  fs.writeFileSync(TOKENF, t + '\n', { mode: 0o600 });     // owner-only on creation
  try { fs.chmodSync(TOKENF, 0o600); } catch {}            // belt-and-suspenders (umask can loosen the mode arg)
  return t;
}
const TOKEN = loadOrCreateToken();

// Constant-time, length-checked compare. timingSafeEqual throws on length mismatch, so guard length FIRST —
// and do it without a length-dependent early return that could leak the token length via timing.
function tokenOk(presented) {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;                 // lengths are equal for every valid token; no secret leaked
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

// ---- per-IP token bucket (defense against a local brute-force / flood) ---------------------------
class Bucket { constructor(cap, perMin) { this.cap = cap; this.tok = cap; this.rate = perMin / 60000; this.last = Date.now(); }
  take() { const n = Date.now(); this.tok = Math.min(this.cap, this.tok + (n - this.last) * this.rate); this.last = n; if (this.tok >= 1) { this.tok -= 1; return true; } return false; } }
const buckets = new Map();
function rateOk(ip) {
  let b = buckets.get(ip); if (!b) { b = new Bucket(60, 120); buckets.set(ip, b); }            // 60 burst, ~120/min/ip
  if (buckets.size > 1024) for (const k of buckets.keys()) { buckets.delete(k); if (buckets.size <= 512) break; } // bound the map
  return b.take();
}

// ---- cookie: a token cookie is only a convenience; it carries the exact token, validated like the header ----
function cookieToken(req) {
  const c = req.headers.cookie; if (!c) return '';
  for (const part of c.split(';')) { const i = part.indexOf('='); if (i < 0) continue;
    if (part.slice(0, i).trim() === 'urfael_dash') { try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ''; } } } // malformed %-escape must NOT throw (unauth DoS / crash-loop)
  return '';
}

// ---- daemon proxy: forward GETs and the /ask POST over the unix socket, never expose a daemon path verbatim ----
function daemonGet(p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath: SOCK, method: 'GET', path: p, timeout: 15000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); r.end();
  });
}
// POST /ask over the socket with channel:'local' absent? NO — the dashboard is a remote-ish surface but the owner
// is already proven by the page token, so it runs as the local mic would. We collapse the NDJSON to the final reply.
function daemonAsk(text) {
  return new Promise((resolve) => {
    const r = http.request({ socketPath: SOCK, method: 'POST', path: '/ask', headers: { 'Content-Type': 'application/json' }, timeout: 200000 }, (res) => {
      let buf = '', final = '';
      res.on('data', (d) => { buf += d.toString(); let i;
        while ((i = buf.indexOf('\n')) >= 0) { const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!ln) continue; try { const e = JSON.parse(ln); if (e.kind === 'done') final = e.text || ''; } catch {} } });
      res.on('end', () => resolve(final || '(no reply)'));
    });
    r.on('error', () => resolve('(brain unreachable — is the Urfael daemon running?)'));
    r.on('timeout', () => { r.destroy(); resolve('(timed out)'); });
    r.end(JSON.stringify({ text }));
  });
}

// sessions search — RANKED recall via the daemon's GET /recall (BM25), not substring grep. The daemon
// reads the private archive (bounded, never outside the sessions dir); we just shape the rows for display.
async function searchSessions(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const ranked = await daemonGet('/recall?q=' + encodeURIComponent(q.slice(0, 500)) + '&k=40').catch(() => null);
  if (!Array.isArray(ranked)) return [];
  return ranked.map((e) => ({ t: (e.t || '').slice(0, 16).replace('T', ' '), channel: e.channel || '', user: (e.user || '').slice(0, 200),
    urfael: (e.urfael || '').replace(/\[\/?SPOKEN\]/gi, '').replace(/\s+/g, ' ').slice(0, 300) }));
}

function readBody(req) {
  return new Promise((resolve) => { let b = '', over = false;
    req.on('data', (c) => { if (over) return; b += c; if (b.length > MAX_BODY) { over = true; try { req.destroy(); } catch {} resolve(''); } });
    req.on('end', () => { if (!over) resolve(b); }); req.on('error', () => resolve('')); });
}
function sendJson(res, code, obj) { const s = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(s); }
function unauthorized(res) { res.writeHead(401, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('unauthorized'); } // no info leak

// ---- the page: one self-contained inline HTML+JS doc, gold-on-dark, Console identity ------------------------
function pageHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Urfael</title>
<style>
:root{--gold:#d8a23a;--gold2:#f0c768;--bg:#0c0b09;--bg2:#15130f;--ink:#ece6d8;--dim:#8a836f}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(1200px 600px at 70% -10%,#1c180f,#0c0b09);color:#ece6d8;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
header{display:flex;align-items:baseline;gap:12px;padding:18px 22px;border-bottom:1px solid #2a2419}
h1{margin:0;font-size:18px;letter-spacing:.18em;color:var(--gold);font-weight:600}
.sub{color:#8a836f;font-size:12px}
main{max-width:980px;margin:0 auto;padding:22px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:22px}
.card{background:var(--bg2);border:1px solid #2a2419;border-radius:10px;padding:14px 16px}
.k{color:#8a836f;font-size:11px;text-transform:uppercase;letter-spacing:.12em}
.v{color:var(--gold2);font-size:20px;margin-top:4px}
section{background:var(--bg2);border:1px solid #2a2419;border-radius:10px;padding:16px;margin-bottom:18px}
h2{margin:0 0 10px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#b79a5f;font-weight:600}
.row{padding:7px 0;border-top:1px solid #221d14;color:#cfc7b4}
.row:first-of-type{border-top:0}
.t{color:var(--gold);font-size:12px}.ch{color:#7e7660;font-size:11px}
input,textarea{width:100%;background:#0c0b09;border:1px solid #2a2419;color:#ece6d8;border-radius:8px;padding:10px 12px;font:inherit}
textarea{min-height:60px;resize:vertical}
.ask-wrap{display:flex;gap:10px;margin-top:8px}
button{background:var(--gold);color:#171307;border:0;border-radius:8px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer;white-space:nowrap}
button:disabled{opacity:.5;cursor:default}
#reply{white-space:pre-wrap;margin-top:12px;color:#e7dfc9;min-height:20px}
.muted{color:#7e7660}.empty{color:#6f6857;font-style:italic}
a{color:var(--gold2)}
</style></head><body>
<header><h1>URFAEL</h1><span class="sub" id="status">connecting…</span></header>
<main>
  <div class="grid" id="vitals"></div>
  <section><h2>Ask</h2>
    <div class="ask-wrap"><textarea id="q" placeholder="ask the brain…"></textarea><button id="send">send</button></div>
    <div id="reply"></div>
  </section>
  <section><h2>Reminders</h2><div id="reminders"><span class="empty">…</span></div></section>
  <section><h2>Jobs</h2><div id="jobs"><span class="empty">…</span></div></section>
  <section><h2>Session search</h2>
    <input id="sq" placeholder="search every past conversation…" autocomplete="off">
    <div id="sessions" style="margin-top:10px"></div>
  </section>
</main>
<script>
'use strict';
// the token rode in on ?token= and was promoted to a cookie by the server; strip it from the URL/history so it
// is not left in the address bar, then talk to the same-origin API with the cookie doing the auth.
(function(){ if (location.search) history.replaceState(null,'',location.pathname); })();
var $=function(s){return document.querySelector(s)};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function api(p,opts){return fetch(p,Object.assign({credentials:'same-origin',headers:{'Content-Type':'application/json'}},opts||{})).then(function(r){if(!r.ok)throw new Error(r.status);return r.json()})}
function vit(){return api('/api/vitals').then(function(v){
  $('#status').textContent='model '+(v.model||'?')+' · warm '+((v.warm||[]).length);
  var c=[['turns today',v.turnsToday],['avg ms',v.avgMs],['tokens',v.tokToday>=1000?Math.round(v.tokToday/1000)+'k':(v.tokToday||0)],['mem commits',v.memCommits],['uptime',Math.round((v.uptimeS||0)/60)+'m'],['restarts',v.errors]];
  $('#vitals').innerHTML=c.map(function(x){return '<div class="card"><div class="k">'+esc(x[0])+'</div><div class="v">'+esc(x[1])+'</div></div>'}).join('');
}).catch(function(){$('#status').textContent='brain offline'})}
function reminders(){return api('/api/reminders').then(function(rs){
  $('#reminders').innerHTML=(rs&&rs.length)?rs.map(function(r){return '<div class="row"><span class="t">'+esc((r.at||'').replace('T',' ').slice(0,16))+'</span> '+esc(r.text)+(r.repeat?' <span class="ch">(repeats)</span>':'')+'</div>'}).join(''):'<span class="empty">none scheduled</span>';
}).catch(function(){})}
function jobs(){return api('/api/jobs').then(function(js){
  $('#jobs').innerHTML=(js&&js.length)?js.map(function(j){return '<div class="row"><span class="t">'+esc(j.kind)+'</span> '+esc(j.state)+' <span class="ch">'+esc(j.id)+'</span></div>'}).join(''):'<span class="empty">no jobs</span>';
}).catch(function(){})}
var st;
function sessions(){var q=$('#sq').value.trim();if(!q){$('#sessions').innerHTML='';return}
  api('/api/sessions?q='+encodeURIComponent(q)).then(function(rows){
    $('#sessions').innerHTML=(rows&&rows.length)?rows.map(function(e){return '<div class="row"><span class="t">'+esc(e.t)+'</span> <span class="ch">'+esc(e.channel)+'</span><br>you: '+esc(e.user)+'<br><span class="muted">urfael: '+esc(e.urfael)+'</span></div>'}).join(''):'<span class="empty">no matches</span>';
  }).catch(function(){})}
$('#sq').addEventListener('input',function(){clearTimeout(st);st=setTimeout(sessions,300)});
function send(){var t=$('#q').value.trim();if(!t)return;var b=$('#send');b.disabled=true;$('#reply').textContent='…thinking';
  api('/api/ask',{method:'POST',body:JSON.stringify({text:t})}).then(function(r){$('#reply').textContent=(r&&r.text)||'(no reply)'}).catch(function(){$('#reply').textContent='(error)'}).then(function(){b.disabled=false})}
$('#send').addEventListener('click',send);
$('#q').addEventListener('keydown',function(e){if((e.metaKey||e.ctrlKey)&&e.key==='Enter')send()});
function tick(){vit();reminders();jobs()}
tick();setInterval(tick,5000);
</script></body></html>`;
}

// ---- request handling: auth gate -> tiny fixed API surface (no path is ever turned into a filesystem path) ----
const server = http.createServer(async (req, res) => {
  const ip = (req.socket && req.socket.remoteAddress) || 'local';
  if (!rateOk(ip)) { res.writeHead(429, { 'Content-Type': 'text/plain' }); res.end('slow down'); return; }

  // anti-DNS-rebinding: a loopback-only admin surface must only answer to a loopback Host header
  const host = (req.headers.host || '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') { res.writeHead(400); res.end(); return; }

  let u; try { u = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end(); return; }
  const pathname = u.pathname;

  // auth: header OR cookie OR a ?token= match (which then sets the cookie). Anything else -> 401, no hints.
  const header = req.headers['x-urfael-token'];
  const qtok = u.searchParams.get('token');
  let authed = tokenOk(typeof header === 'string' ? header : '') || tokenOk(cookieToken(req));
  let setCookie = false;
  if (!authed && qtok && tokenOk(qtok)) { authed = true; setCookie = true; }
  if (!authed) { unauthorized(res); return; }

  // the page (only ever the root path is served; there is NO file mapping from the URL -> traversal impossible)
  if (req.method === 'GET' && pathname === '/') {
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" };
    // HttpOnly + SameSite=Strict + Path=/ : the token cookie can't be read by JS, sent cross-site, or leaked via referrer.
    if (setCookie) headers['Set-Cookie'] = 'urfael_dash=' + encodeURIComponent(TOKEN) + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000';
    res.writeHead(200, headers); res.end(pageHtml()); return;
  }

  try {
    if (req.method === 'GET' && pathname === '/api/vitals') return sendJson(res, 200, (await daemonGet('/vitals')) || {});
    if (req.method === 'GET' && pathname === '/api/reminders') return sendJson(res, 200, (await daemonGet('/reminders')) || []);
    if (req.method === 'GET' && pathname === '/api/jobs') return sendJson(res, 200, (await daemonGet('/jobs')) || []);
    if (req.method === 'GET' && pathname === '/api/sessions') return sendJson(res, 200, await searchSessions(u.searchParams.get('q') || ''));
    if (req.method === 'POST' && pathname === '/api/ask') {
      const body = await readBody(req); let parsed = {}; try { parsed = JSON.parse(body); } catch {}
      const text = typeof parsed.text === 'string' ? parsed.text.slice(0, 8000) : '';
      if (!text.trim()) return sendJson(res, 400, { error: 'empty' });
      return sendJson(res, 200, { text: await daemonAsk(text) });
    }
  } catch { return sendJson(res, 502, { error: 'daemon unreachable' }); }

  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); // no fs lookup, ever
});

// Refuse to run if we can't bind loopback (a bind failure must not silently fall through to a wider iface).
server.on('error', (e) => { process.stderr.write('urfael dashboard: cannot bind ' + HOST + ':' + PORT + ' — ' + ((e && e.message) || e) + '\n'); process.exit(1); });
server.listen(PORT, HOST, () => {
  // NEVER print the token to stdout — under launchd stdout is a file that may not be 0600, and the token is
  // a full-power credential (the daemon treats dashboard /api/ask as the local owner). The token lives only in
  // the 0600 token file; `urfael dashboard` reads it and prints the tokened URL to YOUR terminal.
  process.stdout.write('Urfael dashboard on http://' + HOST + ':' + PORT + '  (run `urfael dashboard` for the tokened link)\n');
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
