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
const uiPalette = require('./ui-palette');  // unified presentation prefs -> live CSS vars (closed schema; no security knob)

const HOST = '127.0.0.1';                                  // loopback ONLY — never 0.0.0.0, never a LAN/public iface
const PORT = Math.min(Math.max(parseInt(process.env.URFAEL_DASHBOARD_PORT, 10) || 7717, 1), 65535);
const JDIR = path.join(os.homedir(), '.claude', 'urfael');
const SOCK = path.join(JDIR, 'daemon.sock');
const TOKENF = path.join(JDIR, 'dashboard.token');
const MAX_BODY = 262144;                                   // 256KB request-body cap (mirror the daemon)

// ---- PWA chrome: manifest + inline icon (static, carries NO data) --------------------------------
// The manifest and its icon are pure presentation — no brain data, no token — so they are served
// PRE-AUTH like static chrome (a browser fetches the manifest before any user gesture). They never
// expose anything the token gates. Icon is an inline gold-rune SVG as a data URL (no extra route, no fs).
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
  '<rect width="512" height="512" rx="96" fill="#0c0b09"/>' +
  '<g fill="none" stroke="#d8a23a" stroke-width="22" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M256 96 L256 416"/><path d="M256 188 L344 132"/><path d="M256 256 L168 200"/>' +
  '<path d="M256 324 L344 268"/></g></svg>';
const ICON_DATA_URL = 'data:image/svg+xml;base64,' + Buffer.from(ICON_SVG).toString('base64');
function manifestJson() {
  return JSON.stringify({
    name: 'Urfael', short_name: 'Urfael', description: 'Urfael brain console',
    start_url: '/', scope: '/', display: 'standalone', orientation: 'portrait-primary',
    background_color: '#0c0b09', theme_color: '#d8a23a',
    icons: [{ src: ICON_DATA_URL, sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
  });
}

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
// STREAM the daemon's /ask NDJSON to the browser as incremental plain text (the brain already streams; we no
// longer collapse it to one reply). [SPOKEN] asides are stripped exactly as the OpenAI server does (reused, not
// reimplemented). The dashboard is the local owner (proven by the page token), so it runs as the mic would.
const { stripSpoken, safeRawPrefix } = require('./openai-api'); // require-safe (bootstrap is guarded), pure helpers
function daemonAskStreamTo(text, res, hl) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  let acc = '', emitted = 0, ended = false;
  const flush = (full) => { if (full.length > emitted) { try { res.write(full.slice(emitted)); } catch {} emitted = full.length; } };
  const finish = (fallback) => { if (ended) return; ended = true; if (fallback != null && !emitted) { try { res.write(fallback); } catch {} } try { res.end(); } catch {} };
  const r = http.request({ socketPath: SOCK, method: 'POST', path: '/ask', headers: { 'Content-Type': 'application/json' }, timeout: 200000 }, (resp) => {
    let buf = '';
    resp.on('data', (d) => { buf += d.toString(); let i;
      while ((i = buf.indexOf('\n')) >= 0) { const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!ln) continue; let e; try { e = JSON.parse(ln); } catch { continue; }
        if (e.kind === 'thinking' && typeof e.delta === 'string') { acc += e.delta; flush(stripSpoken(safeRawPrefix(acc))); }
        else if (e.kind === 'done') { flush(stripSpoken(typeof e.text === 'string' && e.text ? e.text : acc)); finish(); }
      } });
    resp.on('end', () => finish('(no reply)'));
  });
  r.on('error', () => finish('(brain unreachable — is the Urfael daemon running?)'));
  r.on('timeout', () => { r.destroy(); finish('(timed out)'); });
  r.end(JSON.stringify({ text, hl: !!hl }));
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
// POST JSON to a daemon path over the socket, resolve the parsed reply (or null). Used by the multi-chat manager.
function daemonPostJson(p, obj) {
  return new Promise((resolve) => {
    const body = JSON.stringify(obj || {});
    const r = http.request({ socketPath: SOCK, method: 'POST', path: p, headers: { 'Content-Type': 'application/json' }, timeout: 30000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); r.end(body);
  });
}
// Forward a per-chat ask to /chat/<id>/ask and stream its NDJSON 'done' to the browser as plain text. The chatId is
// already pattern-validated by the route regex before this is called (defence in depth: the daemon re-validates).
function daemonChatAskTo(chatId, text, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  let ended = false; const finish = (t) => { if (ended) return; ended = true; try { if (t != null) res.write(t); } catch {} try { res.end(); } catch {} };
  const r = http.request({ socketPath: SOCK, method: 'POST', path: '/chat/' + chatId + '/ask', headers: { 'Content-Type': 'application/json' }, timeout: 200000 }, (resp) => {
    let buf = '';
    resp.on('data', (d) => { buf += d.toString(); let i;
      while ((i = buf.indexOf('\n')) >= 0) { const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!ln) continue; let e; try { e = JSON.parse(ln); } catch { continue; }
        if (e.kind === 'done') finish(stripSpoken(typeof e.text === 'string' ? e.text : '')); } });
    resp.on('end', () => finish('(no reply)'));
  });
  r.on('error', () => finish('(brain unreachable — is the Urfael daemon running?)'));
  r.on('timeout', () => { r.destroy(); finish('(timed out)'); });
  r.end(JSON.stringify({ text }));
}
function sendJson(res, code, obj) { const s = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(s); }
function unauthorized(res) { res.writeHead(401, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('unauthorized'); } // no info leak

// ---- live presentation prefs: resolve ui-prefs.json into a flat { '--token': color } map so an ALREADY-OPEN
// dashboard can recolor live (the 5s poll diffs it and style.setProperty's each var) without a full reload.
// ui-prefs.json stays the single source of truth; the palette is presentation-only (closed schema, no credential
// or permission key). Every value is re-gated with uiPalette.isSafeColor so nothing unsafe can reach the DOM —
// the same final gate toCssVars uses; we emit a JSON object (no <style> string, no innerHTML on the client).
function livePrefsVars() {
  const out = {};
  try {
    const pal = uiPalette.resolvePalette(uiPalette.loadPrefs());
    for (const key of uiPalette.TOKEN_KEYS) {
      const v = pal[key];
      if (typeof v === 'string' && uiPalette.isSafeColor(v)) out['--' + key] = v.trim();
    }
    // the two aliases the inline :root block actually consumes: --ink <- body, --gold2 <- accent
    if (uiPalette.isSafeColor(pal.body)) out['--ink'] = pal.body.trim();
    if (uiPalette.isSafeColor(pal.accent)) out['--gold2'] = pal.accent.trim();
  } catch {}
  return out;
}

// ---- the page: one self-contained inline HTML+JS doc, gold-on-dark, Console identity ------------------------
function pageHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#d8a23a">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Urfael">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="${ICON_DATA_URL}">
<link rel="apple-touch-icon" href="${ICON_DATA_URL}">
<title>Urfael</title>
<style>
:root{--gold:#d8a23a;--gold2:#f0c768;--bg:#0c0b09;--bg2:#15130f;--ink:#ece6d8;--dim:#8a836f}
${(() => { try { return uiPalette.toCssVars(uiPalette.resolvePalette(uiPalette.loadPrefs())); } catch { return ''; } })()}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:radial-gradient(1200px 600px at 70% -10%,#1c180f,#0c0b09);color:#ece6d8;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
header{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px 12px;padding:18px 22px;padding-left:max(22px,env(safe-area-inset-left));padding-right:max(22px,env(safe-area-inset-right));border-bottom:1px solid #2a2419}
h1{margin:0;font-size:18px;letter-spacing:.18em;color:var(--gold);font-weight:600}
.sub{color:#8a836f;font-size:12px}
main{max-width:980px;margin:0 auto;padding:22px;padding-left:max(22px,env(safe-area-inset-left));padding-right:max(22px,env(safe-area-inset-right));padding-bottom:max(22px,env(safe-area-inset-bottom))}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:22px}
.card{background:var(--bg2);border:1px solid #2a2419;border-radius:10px;padding:14px 16px}
.k{color:#8a836f;font-size:11px;text-transform:uppercase;letter-spacing:.12em}
.v{color:var(--gold2);font-size:20px;margin-top:4px}
section{background:var(--bg2);border:1px solid #2a2419;border-radius:10px;padding:16px;margin-bottom:18px}
h2{margin:0 0 10px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#b79a5f;font-weight:600}
.row{padding:7px 0;border-top:1px solid #221d14;color:#cfc7b4;word-break:break-word;overflow-wrap:anywhere}
.row:first-of-type{border-top:0}
.t{color:var(--gold);font-size:12px}.ch{color:#7e7660;font-size:11px}
#usage{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.ucard{background:#0c0b09;border:1px solid #221d14;border-radius:8px;padding:10px 12px}
.ucard .uk{color:#8a836f;font-size:11px;text-transform:uppercase;letter-spacing:.1em}
.ucard .uc{color:var(--gold2);font-size:18px;margin-top:3px}
.ucard .ut{color:#7e7660;font-size:11px;margin-top:2px}
.usage-note{color:#6f6857;font-size:11px;font-style:italic;margin-top:10px}
input,textarea{width:100%;background:#0c0b09;border:1px solid #2a2419;color:#ece6d8;border-radius:8px;padding:10px 12px;font:inherit}
textarea{min-height:60px;resize:vertical}
.ask-wrap{display:flex;gap:10px;margin-top:8px}
button{background:var(--gold);color:#171307;border:0;border-radius:8px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer;white-space:nowrap;min-height:44px}
button:disabled{opacity:.5;cursor:default}
#reply{white-space:pre-wrap;margin-top:12px;color:#e7dfc9;min-height:20px;word-break:break-word;overflow-wrap:anywhere}
.muted{color:#7e7660}.empty{color:#6f6857;font-style:italic}
a{color:var(--gold2)}
/* key-point highlight: a gold marker-pen sweep so the eye lands on the point. Pops in once, on completion. */
mark.hl{background:linear-gradient(180deg,rgba(240,199,104,.08),rgba(240,199,104,.26));color:#fff8e8;
  border-bottom:2px solid var(--gold2);border-radius:2px;padding:0 3px;box-decoration-break:clone;-webkit-box-decoration-break:clone;
  text-decoration:none;animation:hlpop .5s cubic-bezier(.2,.8,.2,1) both}
@keyframes hlpop{from{background-size:0 100%;border-color:transparent}to{background-size:100% 100%}}
/* ---- multi-chat manager: open independent provider-bound chats, each its own tile (like new terminal windows) ---- */
.chats-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.chats-head h2{margin:0}
.chats-new{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.chats-new select{width:auto;min-height:38px;padding:6px 10px}
.chats-new button{min-height:38px;padding:8px 14px}
#chatgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;margin-top:14px}
#chatgrid:empty::after{content:"No open chats. Click + New chat to start one, each runs its own model/provider, side by side.";color:#6f6857;font-style:italic;font-size:13px}
.chat-tile{display:flex;flex-direction:column;background:#0c0b09;border:1px solid #2a2419;border-radius:10px;overflow:hidden;min-height:200px}
.chat-tile.min{min-height:0}
.chat-tile.min .ct-body,.chat-tile.min .ct-foot{display:none}
.ct-head{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid #221d14;background:#100e0a}
.ct-title{font-size:12px;color:var(--gold);font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ct-title .prov{color:#8a836f;font-weight:400}
.ct-dot{width:7px;height:7px;border-radius:50%;background:#4a4436;flex:none}
.ct-dot.busy{background:var(--gold2);box-shadow:0 0 6px var(--gold2)}
.ct-dot.attn{background:#e0625e;box-shadow:0 0 6px #e0625e;animation:pulse 1.1s infinite}
@keyframes pulse{50%{opacity:.4}}
.ct-btn{background:none;color:#8a836f;border:0;padding:2px 6px;min-height:0;font-size:13px;cursor:pointer;font-weight:400}
.ct-btn:hover{color:var(--gold)}
.ct-body{flex:1;overflow-y:auto;padding:10px 11px;display:flex;flex-direction:column;gap:8px;max-height:340px}
.ct-msg{font-size:13px;line-height:1.5;word-break:break-word;overflow-wrap:anywhere}
.ct-msg.u{color:#9a8f74}.ct-msg.u::before{content:"› ";color:#5f5847}
.ct-msg.a{color:#e7dfc9;white-space:pre-wrap}
.ct-foot{display:flex;gap:7px;padding:9px 11px;border-top:1px solid #221d14}
.ct-foot input{padding:7px 10px;min-height:36px}
.ct-foot button{min-height:36px;padding:6px 12px}
@media (max-width:640px){
  header{padding:14px 16px}main{padding:16px}
  h1{font-size:16px;letter-spacing:.14em}
  section{padding:13px}
  .v{font-size:18px}
  .ask-wrap{flex-direction:column}
  button{width:100%}
  textarea,input{font-size:16px} /* >=16px stops iOS auto-zoom on focus */
}
</style></head><body>
<header><h1>URFAEL</h1><span class="sub" id="status">connecting…</span></header>
<main>
  <div class="grid" id="vitals"></div>
  <section id="chats-section">
    <div class="chats-head">
      <h2>Chats</h2>
      <div class="chats-new">
        <select id="newmodel" title="model"><option value="sonnet">Sonnet</option><option value="opus">Opus</option></select>
        <select id="newprovider" title="provider"><option value="">Claude (subscription)</option></select>
        <button id="newchat">+ New chat</button>
      </div>
    </div>
    <div id="chatgrid"></div>
  </section>
  <section id="radar-section" hidden>
    <h2>Radar <span class="muted" id="radar-pending" style="font-size:12px"></span></h2>
    <div class="usage-note">Internal tool. Nothing is auto-implemented; approve the worthwhile ones and Urfael builds them when you next work together.</div>
    <div id="radar-list" style="margin-top:10px"><span class="empty">…</span></div>
    <div id="radar-view" hidden></div>
  </section>
  <section><h2>Usage &amp; cost (est.)</h2><div id="usage"><span class="empty">…</span></div>
    <div class="usage-note">cost is an estimate from override-able rates, read from the recent log tail</div>
    <div id="usage-by-principal" style="margin-top:10px"></div>
  </section>
  <section><h2>Ask</h2>
    <div class="ask-wrap"><textarea id="q" placeholder="ask the brain…"></textarea><button id="send">send</button></div>
    <div id="reply"></div>
  </section>
  <section><h2>Reminders</h2><div id="reminders"><span class="empty">…</span></div></section>
  <section><h2>Jobs</h2><div id="jobs"><span class="empty">…</span></div></section>
  <section><h2>Learning</h2><div id="learn"><span class="empty">…</span></div></section>
  <section><h2>Team activity</h2><div id="audit"><span class="empty">…</span></div></section>
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
function ktok(n){n=n||0;return n>=1000?Math.round(n/1000)+'k':String(n)}
function usage(){return api('/api/usage').then(function(u){
  if(!u||!u.today){$('#usage').innerHTML='<span class="empty">no usage yet</span>';return}
  var rows=[['today',u.today],['last 7d',u.last7d],['last 30d',u.last30d]];
  $('#usage').innerHTML=rows.map(function(r){var b=r[1]||{};
    return '<div class="ucard"><div class="uk">'+esc(r[0])+'</div><div class="uc">$'+esc((b.costUsd||0).toFixed(2))+'<span class="muted" style="font-size:11px"> est.</span></div><div class="ut">'+esc(b.turns||0)+' turns · '+esc(ktok((b.tokIn||0)+(b.tokOut||0)))+' tok</div></div>';
  }).join('');
}).catch(function(){})}
// per-principal cost rollup — who/which sender spent what. The 'local' bucket is the owner's own compute, not a
// teammate; presentational only (the daemon already gated this socket to the owner). Hidden until there is data.
function usageByPrincipal(){return api('/api/usage?by=principal').then(function(u){
  var box=$('#usage-by-principal'); if(!box)return;
  var groups=(u&&u.groups)||{}; var keys=Object.keys(groups).sort(function(a,b){return (groups[b].costUsd-groups[a].costUsd)||(groups[b].turns-groups[a].turns)});
  if(!keys.length){box.innerHTML='';return}
  var dec=u.local?2:4;
  var head='<div class="muted" style="margin:6px 0">by principal'+(u.local?' · LOCAL_MODE (cost meter off)':'')+'</div>';
  box.innerHTML=head+keys.map(function(k){var g=groups[k];
    return '<div class="row"><span class="ch">'+esc(k)+'</span> <span class="t">'+esc(g.turns||0)+' turns · '+esc(ktok((g.tokIn||0)+(g.tokOut||0)))+' tok</span> <span class="muted">$'+esc((g.costUsd||0).toFixed(dec))+' est</span></div>';
  }).join('');
}).catch(function(){})}
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
  fetch('/api/ask',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t,hl:1})}).then(function(r){
    if(!r.ok||!r.body){return r.text().then(function(x){$('#reply').textContent=x||'(error)'})}
    $('#reply').textContent='';var reader=r.body.getReader();var dec=new TextDecoder();
    function pump(){return reader.read().then(function(res){if(res.done){$('#reply').innerHTML=renderHL($('#reply').textContent);return}$('#reply').textContent+=dec.decode(res.value,{stream:true});return pump()})}
    return pump();
  }).catch(function(){$('#reply').textContent='(error)'}).then(function(){b.disabled=false})}
$('#send').addEventListener('click',send);
$('#q').addEventListener('keydown',function(e){if((e.metaKey||e.ctrlKey)&&e.key==='Enter')send()});
function learn(){return api('/api/learn').then(function(d){
  var s=d&&d.stats; if(!s||!s.total){$('#learn').innerHTML='<span class="empty">nothing learned yet</span>';return}
  var head='<div class="muted" style="margin-bottom:8px">'+esc(s.trusted)+' trusted · '+esc(s.proposed)+' proposed · '+esc(s.retired)+' retired · avg confidence '+esc(s.avgConfidence)+'</div>';
  var ord={trusted:0,proposed:1,retired:2};
  var items=(d.items||[]).slice().sort(function(a,b){return (ord[a.status]-ord[b.status])||(b.confidence-a.confidence)}).slice(0,30);
  $('#learn').innerHTML=head+items.map(function(i){var c=i.status==='trusted'?'#8fae6e':i.status==='retired'?'#888':'#d4a85a';
    return '<div class="row"><span class="ch" style="color:'+c+'">'+esc(i.status)+'</span> <span class="t">'+(i.status==='retired'?'':esc(Number(i.confidence||0).toFixed(2)))+'</span> '+esc(String(i.ref||'').slice(0,90))+'</div>'}).join('');
}).catch(function(){})}
function audit(){return api('/api/audit').then(function(d){
  var a=d&&d.activity; if(!a||!a.length){$('#audit').innerHTML='<span class="empty">no remote (principal) activity yet</span>';return}
  $('#audit').innerHTML=a.slice(0,30).map(function(e){return '<div class="row"><span class="t">'+esc((e.t||'').replace('T',' ').slice(0,16))+'</span> <span class="ch">'+esc(e.channel||'?')+'</span> '+esc(e.principal||'—')+' <span class="muted">'+esc(e.role||'')+' · '+esc(e.profile||'')+'</span></div>'}).join('');
}).catch(function(){})}
// ---- internal tool: list reports, read one, approve/dismiss ----
function radar(){return api('/api/radar').then(function(d){
  // OWNER-ONLY: the daemon reports enabled=false for a normal/downloaded copy -> keep the whole section hidden.
  if(!d||!d.enabled){ $('#radar-section').hidden=true; return; }
  $('#radar-section').hidden=false;
  var rs=(d&&d.reports)||[]; var pend=(d&&d.pending)||0;
  $('#radar-pending').textContent = pend ? ('· '+pend+' pending') : '';
  if(!rs.length){$('#radar-list').innerHTML='<span class="empty">no reports yet (the daily scan writes one only when a rival ships)</span>';return}
  $('#radar-list').innerHTML=rs.map(function(r){
    var badge = r.status==='approved' ? '<span class="ch" style="color:#8fae6e">approved</span>' : r.status==='dismissed' ? '<span class="ch" style="color:#888">dismissed</span>' : '<span class="ch" style="color:var(--gold2)">pending</span>';
    return '<div class="row" style="display:flex;align-items:center;gap:10px"><span class="t" style="flex:1">'+esc(r.date)+'</span> '+badge+' <button data-rf="'+esc(r.file)+'" class="rv" style="padding:5px 11px;min-height:0">view</button></div>';
  }).join('');
  document.querySelectorAll('#radar-list .rv').forEach(function(b){ b.addEventListener('click',function(){ radarView(b.getAttribute('data-rf')); }); });
}).catch(function(){})}
function radarView(file){
  api('/api/radar/'+encodeURIComponent(file)).then(function(d){
    var md=(d&&d.markdown)||'(could not read report)';
    var v=$('#radar-view'); v.hidden=false;
    v.innerHTML='<div style="margin:12px 0 8px"><button id="radar-back" style="padding:5px 11px;min-height:0">‹ back</button> '
      +'<button data-st="approved" class="ra" style="padding:5px 11px;min-height:0;background:#3a4a2a;color:#cfe6b0">✓ approve</button> '
      +'<button data-st="dismissed" class="ra" style="padding:5px 11px;min-height:0;background:#2a2419;color:#998">dismiss</button></div>'
      +'<pre style="white-space:pre-wrap;word-break:break-word;background:#0c0b09;border:1px solid #2a2419;border-radius:8px;padding:14px;color:#e7dfc9;font:12.5px/1.6 ui-monospace,Menlo,monospace;max-height:60vh;overflow:auto">'+esc(md)+'</pre>';
    $('#radar-list').hidden=true;
    $('#radar-back').addEventListener('click',function(){ v.hidden=true; $('#radar-list').hidden=false; });
    v.querySelectorAll('.ra').forEach(function(b){ b.addEventListener('click',function(){
      api('/api/radar/approve',{method:'POST',body:JSON.stringify({file:file,status:b.getAttribute('data-st')})}).then(function(){ v.hidden=true; $('#radar-list').hidden=false; radar(); }).catch(function(){});
    }); });
  }).catch(function(){});
}
// ---- key-point highlighting: after generation completes, the brain's ==marked== phrases get a gold marker so the
// eye lands on the point first. Escape FIRST (XSS-safe), then turn the escaped ==...== into a <mark>. Only applied
// on completion, never mid-stream, so the highlight is a deliberate finish, not a flicker.
function renderHL(text){ return esc(text).replace(/==([^=]+?)==/g,'<mark class="hl">$1</mark>'); }

// ---- multi-chat manager: open independent provider-bound chats, each its own tile (like new terminal windows) ----
function loadProviders(){return api('/api/providers').then(function(d){
  var ps=(d&&d.providers)||[]; var sel=$('#newprovider');
  ps.forEach(function(p){ if(!p||!p.id)return; var o=document.createElement('option'); o.value=p.id;
    o.textContent=(p.label||p.id)+(p.verified===false?' (needs key)':''); sel.appendChild(o); });
}).catch(function(){})}
function newChat(){
  var model=$('#newmodel').value, providerId=$('#newprovider').value, b=$('#newchat'); b.disabled=true;
  api('/api/chat',{method:'POST',body:JSON.stringify({model:model,providerId:providerId})}).then(function(c){
    if(c&&c.chatId) addTile(c); else alert('Could not open the chat'+(c&&c.error?': '+c.error:'')+'.');
  }).catch(function(){}).then(function(){b.disabled=false});
}
function addTile(c){
  var provLabel=c.providerId?c.providerId:'subscription';
  var tile=document.createElement('div'); tile.className='chat-tile';
  tile.setAttribute('data-chat-id',c.chatId);  // lets the pagehide teardown find every open chat to disconnect
  tile.innerHTML='<div class="ct-head"><span class="ct-dot"></span>'+
    '<span class="ct-title">'+esc(c.model||'sonnet')+' <span class="prov">· '+esc(provLabel)+'</span></span>'+
    '<button class="ct-btn ct-min" title="minimize">–</button>'+
    '<button class="ct-btn ct-close" title="close chat">✕</button></div>'+
    '<div class="ct-body"></div>'+
    '<div class="ct-foot"><input type="text" placeholder="message this chat…" autocomplete="off"><button>send</button></div>';
  $('#chatgrid').appendChild(tile);
  var body=tile.querySelector('.ct-body'), input=tile.querySelector('.ct-foot input'),
      sendb=tile.querySelector('.ct-foot button'), dot=tile.querySelector('.ct-dot');
  function doSend(){
    var t=input.value.trim(); if(!t)return; input.value='';
    var u=document.createElement('div'); u.className='ct-msg u'; u.textContent=t; body.appendChild(u);
    var a=document.createElement('div'); a.className='ct-msg a'; a.textContent='…'; body.appendChild(a);
    body.scrollTop=body.scrollHeight; dot.className='ct-dot busy'; sendb.disabled=true;
    fetch('/api/chat/'+encodeURIComponent(c.chatId)+'/ask',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})}).then(function(r){
      if(!r.ok||!r.body){return r.text().then(function(x){a.textContent=x||'(error)'})}
      a.textContent=''; var reader=r.body.getReader(), dec=new TextDecoder();
      function pump(){return reader.read().then(function(res){if(res.done){a.innerHTML=renderHL(a.textContent);return}a.textContent+=dec.decode(res.value,{stream:true});body.scrollTop=body.scrollHeight;return pump()})}
      return pump();
    }).catch(function(){a.textContent='(error)'}).then(function(){dot.className='ct-dot';sendb.disabled=false;body.scrollTop=body.scrollHeight});
  }
  sendb.addEventListener('click',doSend);
  input.addEventListener('keydown',function(e){if(e.key==='Enter')doSend()});
  tile.querySelector('.ct-min').addEventListener('click',function(){tile.classList.toggle('min')});
  tile.querySelector('.ct-close').addEventListener('click',function(){
    api('/api/chat/'+encodeURIComponent(c.chatId)+'/disconnect',{method:'POST',body:'{}'}).catch(function(){});
    tile.remove();
  });
  input.focus();
}
$('#newchat').addEventListener('click',newChat);
// rehydrate chats orphaned by a page reload: the daemon still holds them warm, so list /api/chats and rebuild a tile
// for each. addTile REUSES the existing daemon chat (it does NOT re-POST /api/chat), so a refreshed page can see,
// reuse and close them again instead of leaking invisible, unclosable brain processes.
function rehydrateChats(){return api('/api/chats').then(function(cs){
  (cs&&cs.length?cs:[]).forEach(function(c){ if(c&&c.chatId) addTile(c); });
}).catch(function(){})}
loadProviders().then(rehydrateChats);
// best-effort teardown on leave: pagehide (more reliable than beforeunload for PWA/mobile) beacons a disconnect for
// every still-open tile so the daemon can reclaim the warm process instead of orphaning it. Same-origin sendBeacon
// carries the HttpOnly cookie, so the loopback+token gate still authenticates it.
window.addEventListener('pagehide',function(){ try{
  var tiles=document.querySelectorAll('#chatgrid .chat-tile[data-chat-id]');
  for(var i=0;i<tiles.length;i++){ var id=tiles[i].getAttribute('data-chat-id');
    if(id&&navigator.sendBeacon) navigator.sendBeacon('/api/chat/'+encodeURIComponent(id)+'/disconnect',new Blob(['{}'],{type:'application/json'})); }
}catch(e){} });
// live-recolor an already-open dashboard: ui-prefs.json is the single source of truth, so the 5s poll fetches the
// resolved {'--token':color} map (each value already isSafeColor-gated on the server) and, only when it changed,
// pushes each onto document.documentElement via style.setProperty. No innerHTML, no injected <style> string.
var _prefSig='';
function prefs(){return api('/api/prefs').then(function(d){
  var v=(d&&d.vars)||{}; var sig=JSON.stringify(v); if(sig===_prefSig)return; _prefSig=sig;
  var rs=document.documentElement.style;
  for(var k in v){ if(!Object.prototype.hasOwnProperty.call(v,k))continue; var val=v[k];
    // belt-and-suspenders (server already gated): only our token names + a conservative color charset
    if(/^--[a-z0-9]+$/i.test(k)&&typeof val==='string'&&/^[#a-z0-9(),.%/ -]+$/i.test(val)) rs.setProperty(k,val); }
}).catch(function(){})}
function tick(){vit();usage();usageByPrincipal();reminders();jobs();learn();audit();prefs();radar()}
tick();setInterval(tick,5000);
</script></body></html>`;
}

// ---- request handling: auth gate -> tiny fixed API surface (no path is ever turned into a filesystem path) ----
const server = http.createServer(async (req, res) => {
  // anti-DNS-rebinding: a loopback-only admin surface must only answer to a loopback Host header
  const host = (req.headers.host || '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') { res.writeHead(400); res.end(); return; }

  let u; try { u = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end(); return; }
  const pathname = u.pathname;

  // PWA manifest: pure static chrome (no brain data, no token) served PRE-AUTH — a browser fetches the
  // manifest WITHOUT credentials, so gating it would silently break installability. It exposes nothing the
  // token protects. Still a fixed path (no fs lookup, no traversal); the icon is inlined as a data URL.
  if (req.method === 'GET' && pathname === '/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(manifestJson()); return;
  }

  // auth: header OR cookie OR a ?token= match (which then sets the cookie). Anything else -> 401, no hints.
  const header = req.headers['x-urfael-token'];
  const qtok = u.searchParams.get('token');
  let authed = tokenOk(typeof header === 'string' ? header : '') || tokenOk(cookieToken(req));
  let setCookie = false;
  if (!authed && qtok && tokenOk(qtok)) { authed = true; setCookie = true; }
  if (!authed) { unauthorized(res); return; }

  // rate limit is AUTHENTICATED-only: all loopback requests share remoteAddress '127.0.0.1', so a pre-auth
  // limit would let an unauthenticated co-resident process drain the shared bucket and lock the owner out.
  // Only the token holder can spend it. (openai-api.js does the same; this was a regression of that fix.)
  const ip = (req.socket && req.socket.remoteAddress) || 'local';
  if (!rateOk(ip)) { res.writeHead(429, { 'Content-Type': 'text/plain' }); res.end('slow down'); return; }

  // the page (only ever the root path is served; there is NO file mapping from the URL -> traversal impossible)
  if (req.method === 'GET' && pathname === '/') {
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; manifest-src 'self'" };
    // HttpOnly + SameSite=Strict + Path=/ : the token cookie can't be read by JS, sent cross-site, or leaked via referrer.
    if (setCookie) headers['Set-Cookie'] = 'urfael_dash=' + encodeURIComponent(TOKEN) + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000';
    res.writeHead(200, headers); res.end(pageHtml()); return;
  }

  try {
    if (req.method === 'GET' && pathname === '/api/vitals') return sendJson(res, 200, (await daemonGet('/vitals')) || {});
    if (req.method === 'GET' && pathname === '/api/usage') { const by = u.searchParams.get('by'); const qp = (by === 'principal' || by === 'channel') ? '?by=' + by : ''; return sendJson(res, 200, (await daemonGet('/usage' + qp)) || {}); }
    if (req.method === 'GET' && pathname === '/api/reminders') return sendJson(res, 200, (await daemonGet('/reminders')) || []);
    if (req.method === 'GET' && pathname === '/api/jobs') return sendJson(res, 200, (await daemonGet('/jobs')) || []);
    if (req.method === 'GET' && pathname === '/api/learn') return sendJson(res, 200, (await daemonGet('/learn')) || {});
    if (req.method === 'GET' && pathname === '/api/audit') return sendJson(res, 200, (await daemonGet('/audit')) || {});
    if (req.method === 'GET' && pathname === '/api/sessions') return sendJson(res, 200, await searchSessions(u.searchParams.get('q') || ''));
    if (req.method === 'GET' && pathname === '/api/prefs') return sendJson(res, 200, { vars: livePrefsVars() }); // live recolor source (already-gated tokens)
    if (req.method === 'POST' && pathname === '/api/ask') {
      const body = await readBody(req); let parsed = {}; try { parsed = JSON.parse(body); } catch {}
      const text = typeof parsed.text === 'string' ? parsed.text.slice(0, 8000) : '';
      if (!text.trim()) return sendJson(res, 400, { error: 'empty' });
      return daemonAskStreamTo(text, res, !!parsed.hl); // streams the answer; hl asks the brain to mark key points
    }
    // ---- multi-chat manager: open/list/talk-to/close independent provider-bound chats (like new terminal windows) ----
    if (req.method === 'GET' && pathname === '/api/providers') return sendJson(res, 200, (await daemonGet('/providers')) || { providers: [] });
    if (req.method === 'GET' && pathname === '/api/chats') { const v = await daemonGet('/vitals'); return sendJson(res, 200, (v && v.chats) || []); }
    // internal tool: list reports + their approval status, read one, approve/dismiss
    if (req.method === 'GET' && pathname === '/api/radar') return sendJson(res, 200, (await daemonGet('/radar')) || { reports: [] });
    if (req.method === 'GET' && /^\/api\/radar\/[0-9TZ:.\-]+\.md$/.test(pathname)) return sendJson(res, 200, (await daemonGet('/radar/' + encodeURIComponent(pathname.slice('/api/radar/'.length)))) || {});
    if (req.method === 'POST' && pathname === '/api/radar/approve') { const body = await readBody(req); let p = {}; try { p = JSON.parse(body); } catch {} return sendJson(res, 200, (await daemonPostJson('/radar/approve', { file: p.file, status: p.status })) || { ok: false }); }
    if (req.method === 'POST' && pathname === '/api/chat') {
      const body = await readBody(req); let p = {}; try { p = JSON.parse(body); } catch {}
      const model = (p.model === 'opus' || p.model === 'sonnet') ? p.model : 'sonnet';
      const providerId = typeof p.providerId === 'string' ? p.providerId.slice(0, 60) : '';
      return sendJson(res, 200, (await daemonPostJson('/chat', { model, providerId })) || { error: 'failed' });
    }
    if (req.method === 'POST' && /^\/api\/chat\/[A-Za-z0-9-]{4,80}\/ask$/.test(pathname)) {
      const id = pathname.split('/')[3];
      const body = await readBody(req); let p = {}; try { p = JSON.parse(body); } catch {}
      const text = typeof p.text === 'string' ? p.text.slice(0, 8000) : '';
      if (!text.trim()) return sendJson(res, 400, { error: 'empty' });
      return daemonChatAskTo(id, text, res);
    }
    if (req.method === 'POST' && /^\/api\/chat\/[A-Za-z0-9-]{4,80}\/disconnect$/.test(pathname)) {
      const id = pathname.split('/')[3];
      return sendJson(res, 200, (await daemonPostJson('/chat/' + id + '/disconnect', {})) || { ok: false });
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
// RESILIENCE: a localhost server callback throw must not kill the dashboard; log to stderr and keep serving.
process.on('uncaughtException', (e) => { try { process.stderr.write('urfael dashboard uncaught: ' + String((e && e.stack) || e).slice(0, 600) + '\n'); } catch {} });
process.on('unhandledRejection', (e) => { try { process.stderr.write('urfael dashboard rejection: ' + String((e && (e.stack || e.message)) || e).slice(0, 600) + '\n'); } catch {} });
