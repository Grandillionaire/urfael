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
const dc = require('./daemon-client');       // shared unix-socket client (request + /ask NDJSON stream)
// OPT-IN (default OFF): the read-only "Memory Journey" graph section + its /api/graph proxy. When OFF, the pageHtml()
// interpolations below resolve to '' (byte-identical page) and the /api/graph routes are never registered.
const MEMGRAPH = require('./lib').envOn(process.env.URFAEL_MEMGRAPH);

const HOST = '127.0.0.1';                                  // loopback ONLY — never 0.0.0.0, never a LAN/public iface
const PORT = Math.min(Math.max(parseInt(process.env.URFAEL_DASHBOARD_PORT, 10) || 7717, 1), 65535);
const JDIR = path.join(os.homedir(), '.claude', 'urfael');
const ipc = require('./ipc');
const SOCK = ipc.daemonSock();   // 0600 unix socket on POSIX; per-user named pipe + token on native Windows (see app/ipc.js)
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
  // parse the JSON reply, else null; a socket error/timeout REJECTS (callers .catch to a fallback).
  return dc.request('GET', p, undefined, { socketPath: SOCK, timeoutMs: 15000 }).then((b) => { try { return JSON.parse(b); } catch { return null; } });
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
  // ./daemon-client frames + routes the /ask NDJSON stream; we forward the written answer to the browser as plain text.
  dc.streamAsk(text, {
    onDelta: (e) => { acc += e.delta; flush(stripSpoken(safeRawPrefix(acc))); },
    onDone: (e) => { flush(stripSpoken(typeof e.text === 'string' && e.text ? e.text : acc)); finish(); },
    onError: (err) => {
      if (err.phase === 'error') finish('(brain unreachable — is the Urfael daemon running?)');
      else if (err.phase === 'timeout') finish('(timed out)');
      else finish('(no reply)');   // 'end'
    },
  }, { socketPath: SOCK, body: { text, hl: !!hl }, timeoutMs: 200000 });
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
  return dc.request('POST', p, obj || {}, { socketPath: SOCK, timeoutMs: 30000 }).then((b) => { try { return JSON.parse(b); } catch { return null; } }, () => null);
}
// Forward a per-chat ask to /chat/<id>/ask and stream its NDJSON 'done' to the browser as plain text. The chatId is
// already pattern-validated by the route regex before this is called (defence in depth: the daemon re-validates).
function daemonChatAskTo(chatId, text, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  let ended = false; const finish = (t) => { if (ended) return; ended = true; try { if (t != null) res.write(t); } catch {} try { res.end(); } catch {} };
  // the chat's warm session streams NDJSON like /ask; forward only its final done text to the browser as plain text.
  dc.streamAsk(text, {
    onDone: (e) => finish(stripSpoken(typeof e.text === 'string' ? e.text : '')),
    onError: (err) => {
      if (err.phase === 'error') finish('(brain unreachable — is the Urfael daemon running?)');
      else if (err.phase === 'timeout') finish('(timed out)');
      else finish('(no reply)');   // 'end'
    },
  }, { socketPath: SOCK, path: '/chat/' + chatId + '/ask', body: { text }, timeoutMs: 200000 });
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

// ---- OPT-IN Memory Journey graph: CSS + section shell + on-demand client. All three are interpolated into
// pageHtml() ONLY when MEMGRAPH is on (each `${MEMGRAPH ? ... : ''}` resolves to '' when off -> byte-identical
// page). RENDER SAFETY: the client builds inline SVG with document.createElementNS on a FIXED allowlist and writes
// EVERY attacker-influenceable string (belief/lesson label, file, subject, SHA) via textContent / createTextNode
// ONLY — coordinates + colours are numeric/fixed, never from data. It clears with replaceChildren()/textContent=''.
// No script/iframe/foreignObject, no innerHTML on graph data, so an adversarial distilled-memory label can NEVER
// execute; the locked CSP (default-src 'none') is unchanged.
const GRAPH_CSS = `
#mj-wrap{overflow:auto;max-height:540px;border:1px solid #221d14;border-radius:8px;background:#0c0b09;margin-top:10px}
#mj-svg{display:block}
.mj-banner{background:#3a1512;border:1px solid #e0625e;color:#f4b8b4;border-radius:8px;padding:10px 12px;margin-bottom:10px;font-weight:600;letter-spacing:.02em}
.mj-detail{margin-top:12px;background:#0c0b09;border:1px solid #2a2419;border-radius:8px;padding:12px 14px}
.mj-detail .mj-k{color:#8a836f;font-size:11px;text-transform:uppercase;letter-spacing:.1em;margin-top:8px}
.mj-detail .mj-k:first-child{margin-top:0}
.mj-detail .mj-v{color:#e7dfc9;margin:2px 0;word-break:break-word;overflow-wrap:anywhere}
.mj-badge{display:inline-block;margin-top:10px;background:#16210f;border:1px solid #4a6b2e;color:#a9c982;border-radius:6px;padding:3px 9px;font-size:11px;font-weight:600}
.mj-node{cursor:pointer}
.mj-node text{pointer-events:none}
.mj-legend{color:#7e7660;font-size:11px;margin-top:8px}`;
const GRAPH_SECTION = `
  <section id="memjourney">
    <div class="chats-head"><h2>Memory journey <span class="muted" style="font-weight:400;text-transform:none;letter-spacing:0">· opt-in, read-only</span></h2>
      <div class="chats-new"><button id="mj-load" type="button">Load journey</button></div>
    </div>
    <div id="mj-banner" class="mj-banner" style="display:none"></div>
    <div id="mj-status" class="empty">A read-only projection of your git-versioned memory and the hash-chained Ledger of Record. Every node resolves to a real git commit; loaded on demand.</div>
    <div id="mj-wrap" style="display:none"></div>
    <div id="mj-legend" class="mj-legend" style="display:none"></div>
    <div id="mj-detail" class="mj-detail" style="display:none"></div>
  </section>`;
const GRAPH_SCRIPT = `
// ---- MEMGRAPH GRAPH CLIENT (begin) — inline SVG via createElementNS on a fixed allowlist, textContent-only labels ----
var MJ_NS='http://www.w3.org/2000/svg';
var mjLedgerOk=true;
function mjSvg(tag,attrs){ var e=document.createElementNS(MJ_NS,tag); if(attrs){ for(var a in attrs){ if(Object.prototype.hasOwnProperty.call(attrs,a)) e.setAttribute(a,String(attrs[a])); } } return e; }
function mjTitle(parent,txt){ var t=mjSvg('title'); t.textContent=String(txt==null?'':txt); parent.appendChild(t); }
function mjKV(parent,k,v){ var kk=document.createElement('div'); kk.className='mj-k'; kk.textContent=String(k); var vv=document.createElement('div'); vv.className='mj-v'; vv.textContent=String(v==null?'':v); parent.appendChild(kk); parent.appendChild(vv); return vv; }
function mjDetail(n){ var det=$('#mj-detail'); det.replaceChildren(); det.style.display='block';
  mjKV(det, n.kind==='lesson'?'lesson':'belief', n.label);
  if(n.file) mjKV(det,'source file',n.file);
  if(/^[0-9a-f]+$/.test(String(n.sha||''))) mjKV(det,'current source',n.sha+'   ·   git show '+n.sha);
  if(n.firstSha && n.firstSha!==n.sha && /^[0-9a-f]+$/.test(String(n.firstSha))) mjKV(det,'first recorded',n.firstSha+'   ·   git show '+n.firstSha);
  if(n.pass) mjKV(det,'memory pass',n.pass+(n.date?'  ·  '+n.date:''));
  if(n.retired) mjKV(det,'status','retired'+(n.retiredSha?'  ·  git show '+n.retiredSha:''));
  if(n.kind==='lesson'){ mjKV(det,'lesson status',String(n.status||'')); mjKV(det,'confidence',Number(n.confidence||0).toFixed(2)); if(n.verifyNote) mjKV(det,'verifier note',n.verifyNote); }
  // provable badge is WITHHELD when the ledger's own hash chain is broken — never present a tamper-evident graph as trustworthy.
  if(mjLedgerOk && /^[0-9a-f]+$/.test(String(n.sha||''))){ var b=document.createElement('span'); b.className='mj-badge'; b.textContent='provable · reproduce with git show '+n.sha; det.appendChild(b); }
}
function mjRender(g){
  var banner=$('#mj-banner'), status=$('#mj-status'), wrap=$('#mj-wrap'), legend=$('#mj-legend'), detail=$('#mj-detail');
  detail.style.display='none'; detail.replaceChildren();
  var nodes=(g&&g.nodes)||[], edges=(g&&g.edges)||[];
  var led=(g&&g.ledger)||{ok:false};
  mjLedgerOk = led.ok!==false;
  if(led.ok===false){ banner.style.display='block'; banner.textContent='LEDGER BROKEN'+(typeof led.brokenSeq==='number'?' at seq '+led.brokenSeq:'')+' — do not trust'; }
  else { banner.style.display='none'; banner.textContent=''; }
  if(!nodes.length){ wrap.style.display='none'; legend.style.display='none'; status.style.display='block'; status.textContent='graph unavailable — no versioned memory yet (or git unavailable).'; return; }
  status.style.display='none';
  var W=920, rowH=30, padTop=18, padBottom=18, dotX=64, labelX=86;
  var H=padTop+padBottom+nodes.length*rowH;
  var pos={}, i;
  for(i=0;i<nodes.length;i++){ pos[nodes[i].id]=padTop+i*rowH+rowH/2; }
  var svg=mjSvg('svg',{id:'mj-svg',width:W,height:H,viewBox:'0 0 '+W+' '+H});
  var edgeLayer=mjSvg('g'), nodeLayer=mjSvg('g');
  for(i=0;i<edges.length;i++){ var e=edges[i]; var y1=pos[e.from], y2=pos[e.to]; if(y1==null||y2==null) continue;
    var bulge=Math.min(46,14+Math.abs(y2-y1)/4);
    var d='M '+(dotX-7)+' '+y1+' C '+(dotX-7-bulge)+' '+y1+' '+(dotX-7-bulge)+' '+y2+' '+(dotX-7)+' '+y2;
    var p=mjSvg('path',{d:d,fill:'none',stroke:'#d8a23a','stroke-width':1.4,opacity:0.55}); mjTitle(p,(e.label||'revision')+' · '+e.sha); edgeLayer.appendChild(p); }
  for(i=0;i<nodes.length;i++){ var n=nodes[i]; var y=pos[n.id];
    var grp=mjSvg('g',{'class':'mj-node'});
    var fill=n.kind==='lesson'?'#f0c768':(n.retired?'#4a4436':'#b79a5f');
    var c=mjSvg('circle',{cx:dotX,cy:y,r:6,fill:fill,stroke:'#0c0b09','stroke-width':2}); grp.appendChild(c);
    var t=mjSvg('text',{x:labelX,y:y+4,fill:n.retired?'#8a836f':'#ece6d8','font-size':12,'font-family':'ui-monospace,monospace'});
    t.textContent=(n.kind==='lesson'?'[lesson] ':'')+String(n.label||'').slice(0,78)+(n.retired?'  (retired)':''); grp.appendChild(t);
    mjTitle(grp,String(n.label||'')); (function(nn){ grp.addEventListener('click',function(){ mjDetail(nn); }); })(n);
    nodeLayer.appendChild(grp); }
  svg.appendChild(edgeLayer); svg.appendChild(nodeLayer);
  wrap.replaceChildren(svg); wrap.style.display='block';
  legend.style.display='block';
  legend.textContent=nodes.length+' node'+(nodes.length===1?'':'s')+' · '+edges.length+' revision'+(edges.length===1?'':'s')+(g&&g.truncated?' · truncated to the most recent':'')+' · click a node for its provenance';
}
function mjLoad(){ var b=$('#mj-load'); if(b) b.disabled=true; $('#mj-status').style.display='block'; $('#mj-status').textContent='loading…';
  api('/api/graph').then(function(g){ mjRender(g); }).catch(function(){ $('#mj-status').textContent='graph unavailable.'; }).then(function(){ if(b) b.disabled=false; }); }
(function(){ var b=$('#mj-load'); if(b) b.addEventListener('click',mjLoad); })();
// ---- MEMGRAPH GRAPH CLIENT (end) ----`;

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
}${MEMGRAPH ? GRAPH_CSS : ''}
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
  <section><h2>Usage &amp; cost (est.)</h2><div id="usage"><span class="empty">…</span></div>
    <div class="usage-note">cost is an estimate from override-able rates, read from the recent log tail</div>
    <div id="usage-by-principal" style="margin-top:10px"></div>
  </section>
  <section><h2>Context</h2>
    <div class="usage-note">what fills the model input for a turn — bytes are exact, tokens are an estimate (~4 chars/token)</div>
    <div id="context"><span class="empty">…</span></div>
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
  </section>${MEMGRAPH ? GRAPH_SECTION : ''}
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
// ---- context breakdown: per-category bytes + labelled token estimate of what fills the model input for a turn.
// Byte counts are exact (Urfael assembles these); the token column is an estimate and says so. The biggest measured
// consumer is flagged, and each row carries its one-command trim. The CLI-managed running window (which Urfael cannot
// see) is shown as an honest, unmeasured row rather than guessed at. Read-only.
function hbytes(n){ if(n==null)return '—'; n=Number(n)||0; if(n<1024)return n+' B'; if(n<1048576)return (n/1024).toFixed(n<10240?1:0)+' KB'; return (n/1048576).toFixed(1)+' MB'; }
function htok(n){ if(n==null)return '—'; n=Number(n)||0; return n>=1000?'~'+Math.round(n/1000)+'k':'~'+n; }
function context(){return api('/api/context').then(function(r){
  var cats=r&&r.categories; if(!cats||!cats.length){$('#context').innerHTML='<span class="empty">nothing to attribute yet</span>';return}
  var head='<div class="muted" style="margin-bottom:8px">engine <b>'+esc(r.engine||'cli')+'</b> · measured total '+esc(hbytes(r.totalBytes))+' / '+esc(htok(r.totalEstTokens))+' tok (est)</div>';
  var rows=cats.map(function(c){
    var pctv=(c.share==null)?null:Math.round(c.share*100);
    var w=(pctv==null)?0:Math.max(2,pctv);
    var meta=c.measured?(esc(hbytes(c.bytes))+' · '+esc(htok(c.estTokens))+' tok · '+(pctv==null?'—':pctv+'%')):'<span class="muted">not visible to Urfael</span>';
    var flag=c.biggest?' <span style="color:#d4a85a">◄ biggest</span>':'';
    var barcol=c.measured?'#d4a85a':'#3a3327';
    var bar='<div style="height:5px;border-radius:3px;background:'+barcol+';width:'+w+'%;margin-top:4px;opacity:'+(c.measured?1:0.4)+'"></div>';
    var trim=c.trim?'<div class="muted" style="font-size:11px;margin-top:2px">trim: '+esc(c.trim)+'</div>':'';
    return '<div class="row" style="display:block"><div><b>'+esc(c.category)+'</b>'+flag+' <span class="muted">'+meta+'</span></div>'+bar+trim+'</div>';
  }).join('');
  var note=r.note?'<div class="usage-note" style="margin-top:8px">'+esc(r.note)+'</div>':'';
  $('#context').innerHTML=head+rows+note;
}).catch(function(){})}
function audit(){return api('/api/audit').then(function(d){
  var a=d&&d.activity; if(!a||!a.length){$('#audit').innerHTML='<span class="empty">no remote (principal) activity yet</span>';return}
  $('#audit').innerHTML=a.slice(0,30).map(function(e){return '<div class="row"><span class="t">'+esc((e.t||'').replace('T',' ').slice(0,16))+'</span> <span class="ch">'+esc(e.channel||'?')+'</span> '+esc(e.principal||'—')+' <span class="muted">'+esc(e.role||'')+' · '+esc(e.profile||'')+'</span></div>'}).join('');
}).catch(function(){})}
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
function tick(){vit();usage();usageByPrincipal();context();reminders();jobs();learn();audit();prefs()}
tick();setInterval(tick,5000);${MEMGRAPH ? GRAPH_SCRIPT : ''}
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
    if (req.method === 'GET' && pathname === '/api/context') { const q = u.searchParams.get('q'); const qp = q ? '?q=' + encodeURIComponent(String(q).slice(0, 4000)) : ''; return sendJson(res, 200, (await daemonGet('/context' + qp)) || {}); }
    if (req.method === 'GET' && pathname === '/api/reminders') return sendJson(res, 200, (await daemonGet('/reminders')) || []);
    if (req.method === 'GET' && pathname === '/api/jobs') return sendJson(res, 200, (await daemonGet('/jobs')) || []);
    if (req.method === 'GET' && pathname === '/api/learn') return sendJson(res, 200, (await daemonGet('/learn')) || {});
    if (req.method === 'GET' && pathname === '/api/audit') return sendJson(res, 200, (await daemonGet('/audit')) || {});
    // OPT-IN Memory Journey (registered ONLY when MEMGRAPH). Both routes sit AFTER the auth gate + rateOk() check
    // above, reuse the existing daemonGet() over the 0600 socket (no new socket, no new port), and are read-only.
    if (MEMGRAPH && req.method === 'GET' && pathname === '/api/graph') {
      const asOf = u.searchParams.get('asOf');
      const qp = asOf ? '?asOf=' + encodeURIComponent(asOf) : '';   // the daemon re-validates asOf to a strict date charset; anything else is ignored
      return sendJson(res, 200, (await daemonGet('/graph' + qp)) || { nodes: [], edges: [], ledger: { ok: false }, truncated: false });
    }
    if (MEMGRAPH && req.method === 'GET' && pathname === '/api/graph/prove') {
      const seq = u.searchParams.get('seq');
      if (!/^\d+$/.test(String(seq == null ? '' : seq))) return sendJson(res, 400, { error: 'seq must be a non-negative integer' });
      return sendJson(res, 200, (await daemonGet('/audit/prove?seq=' + encodeURIComponent(seq))) || {});   // passthrough to the daemon's real inclusion proof for ANY recorded ledger seq
    }
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

// Only bind the loopback listener + install the process signal handlers when this file is the real entrypoint
// (cli.js launches `node app/dashboard.js` as its own process). Nothing require()s the dashboard in normal
// operation, so wrapping the listen()/signals in a require.main guard is runtime-identical for the real spawn —
// it merely lets a unit test `require('./dashboard')` and call pageHtml() WITHOUT binding the port or trapping signals.
if (require.main === module) {
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
}

module.exports = { pageHtml };
