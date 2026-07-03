'use strict';
// Urfael OpenAI-compatible local API — lets ANY OpenAI client (Open WebUI, LibreChat, the `openai` SDK,
// curl) talk to the same brain as the orb. This is a NEW network surface, so it is locked down EXACTLY like
// the dashboard: bound STRICTLY to 127.0.0.1 (never 0.0.0.0 — nothing on the LAN can reach it), every
// request must present a 32-byte hex bearer token compared in CONSTANT TIME, a Host-header allowlist
// (anti-DNS-rebinding), a per-IP token-bucket rate limit, and NO arbitrary path serving (the URL never names
// a file -> no traversal). It proxies the daemon's unix socket; it holds no secret of its own beyond the API
// token. Refuses to start if it can't bind loopback.
//   node app/openai-api.js        (or via the com.urfael.api launchd plist)
//
// AUTH MODEL: the bearer token is a FULL-POWER credential. Whoever can read ~/.claude/urfael/api.token (0600,
// owner-only) is the owner — exactly like the dashboard's page token. So a /v1/chat/completions request runs
// against the daemon as the LOCAL owner would (no channel sent -> the daemon's local streaming path), which is
// also the only path that streams thinking.delta. The token IS the trust boundary; guard it like one.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dc = require('./daemon-client');                    // shared unix-socket client (request + /ask NDJSON stream)

const HOST = '127.0.0.1';                                  // loopback ONLY — never 0.0.0.0, never a LAN/public iface
const PORT = Math.min(Math.max(parseInt(process.env.URFAEL_API_PORT, 10) || 7720, 1), 65535);
const JDIR = path.join(os.homedir(), '.claude', 'urfael');
const SOCK = path.join(JDIR, 'daemon.sock');
const TOKENF = path.join(JDIR, 'api.token');
const MAX_BODY = 262144;                                   // 256KB request-body cap (mirror the daemon/dashboard)
const MAX_PROMPT = 24000;                                  // cap the assembled prompt so a giant message history can't blow the turn

// ---- token: generate-once, 0600, never world-readable (mirrors dashboard.loadOrCreateToken) ------
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
let TOKEN = ''; // set in the bootstrap block below (deferred so the module can be require()'d for tests)

// Constant-time, length-checked compare. timingSafeEqual throws on length mismatch, so guard length FIRST —
// without a length-dependent early return that could leak the token length via timing.
function tokenOk(presented) {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) return false;                 // lengths are equal for every valid token; no secret leaked
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}
// OpenAI clients send 'Authorization: Bearer <token>'. Accept exactly that shape, nothing looser.
function bearerToken(req) {
  const h = req.headers['authorization'];
  if (typeof h !== 'string') return '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : '';
}

// ---- per-IP token bucket (defense against a local brute-force / flood) — identical to the dashboard ----
class Bucket { constructor(cap, perMin) { this.cap = cap; this.tok = cap; this.rate = perMin / 60000; this.last = Date.now(); }
  take() { const n = Date.now(); this.tok = Math.min(this.cap, this.tok + (n - this.last) * this.rate); this.last = n; if (this.tok >= 1) { this.tok -= 1; return true; } return false; } }
const buckets = new Map();
function rateOk(ip) {
  let b = buckets.get(ip); if (!b) { b = new Bucket(60, 120); buckets.set(ip, b); }            // 60 burst, ~120/min/ip
  if (buckets.size > 1024) for (const k of buckets.keys()) { buckets.delete(k); if (buckets.size <= 512) break; } // bound the map
  return b.take();
}

// ---- prompt assembly: collapse an OpenAI messages[] into one prompt the daemon's /ask understands -------
// System messages are prepended verbatim as instructions; prior user/assistant turns are rendered as labeled
// context so the brain has the conversation; the LATEST user message is the actual question. Total length is
// capped (oldest context dropped first) so an enormous history can't exceed the turn budget.
function buildPrompt(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  const sys = [];
  const turns = [];                                        // {role, content} for non-system, in order
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const role = typeof m.role === 'string' ? m.role : '';
    const content = flattenContent(m.content);
    if (!content) continue;
    if (role === 'system') sys.push(content);
    else if (role === 'assistant') turns.push({ role: 'Assistant', content });
    else turns.push({ role: 'User', content });            // user (and any unknown role) treated as the human
  }
  // the last user turn is the live question; everything before it is prior context
  let lastUserIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) { if (turns[i].role === 'User') { lastUserIdx = i; break; } }
  const question = lastUserIdx >= 0 ? turns[lastUserIdx].content : (turns.length ? turns[turns.length - 1].content : '');
  const priorTurns = lastUserIdx >= 0 ? turns.slice(0, lastUserIdx) : turns.slice(0, Math.max(0, turns.length - 1));

  const head = sys.length ? sys.join('\n\n') + '\n\n' : '';
  let ctx = priorTurns.map((t) => t.role + ': ' + t.content).join('\n');
  // budget: keep the question + system, trim the OLDEST context lines until we fit MAX_PROMPT
  let prompt = head + (ctx ? 'Prior conversation:\n' + ctx + '\n\n' : '') + question;
  while (prompt.length > MAX_PROMPT && priorTurns.length) {
    priorTurns.shift();                                    // drop the oldest prior turn
    ctx = priorTurns.map((t) => t.role + ': ' + t.content).join('\n');
    prompt = head + (ctx ? 'Prior conversation:\n' + ctx + '\n\n' : '') + question;
  }
  if (prompt.length > MAX_PROMPT) prompt = prompt.slice(0, MAX_PROMPT); // last resort (a single giant message)
  return prompt;
}
// OpenAI content can be a plain string OR an array of {type:'text',text}/parts. Flatten to text only;
// non-text parts (images, etc.) are dropped — this brain answers text.
function flattenContent(c) {
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    return c.map((p) => (p && typeof p === 'object' && typeof p.text === 'string') ? p.text : (typeof p === 'string' ? p : ''))
      .filter(Boolean).join('\n').trim();
  }
  return '';
}
// clients want the WRITTEN answer — strip the spoken-aside remark the brain wraps for the voice path.
function stripSpoken(s) { return String(s == null ? '' : s).replace(/\[SPOKEN\][\s\S]*?\[\/SPOKEN\]/gi, '').replace(/\[SPOKEN\][\s\S]*$/i, '').replace(/\[\/?SPOKEN\]/gi, '').trim(); } // also drop an UNTERMINATED aside (open [SPOKEN] with no close) so it can't leak

// ---- daemon proxy over the unix socket. We never expose a daemon path verbatim to the client. ----------
// Non-streaming: collapse the NDJSON to the final {kind:'done'} reply.
// Map the daemon's token usage to the OpenAI shape. Cached reads ARE input tokens in OpenAI's accounting.
function toUsage(u) {
  const inp = (u && u.input_tokens || 0) + (u && u.cache_read_input_tokens || 0);
  const out = (u && u.output_tokens) || 0;
  return { prompt_tokens: inp, completion_tokens: out, total_tokens: inp + out };
}
function daemonAskFinal(text) {
  return new Promise((resolve) => {
    let final = '', model = '', usage = null;
    dc.streamAsk(text, {
      onDone: (e) => { final = e.text || ''; model = e.model || ''; usage = e.usage || null; },     // last done wins
      onError: (err) => {
        if (err.phase === 'error') resolve({ text: '(brain unreachable — is the Urfael daemon running?)', model: '', usage: null });
        else if (err.phase === 'timeout') resolve({ text: '(timed out)', model: '', usage: null });
        else resolve({ text: final || '(no reply)', model, usage });                                 // 'end': natural stream close
      },
    }, { socketPath: SOCK, timeoutMs: 300000 });
  });
}
// Given the RAW accumulated answer, return the prefix that is SAFE to strip-and-emit now: never reveal a
// spoken aside, even one whose [SPOKEN]…[/SPOKEN] block is still open, and hold back a trailing fragment that
// might be growing into a [SPOKEN] tag. We cut on the RAW text (where the markers still exist), then strip.
function safeRawPrefix(acc) {
  const lower = acc.toLowerCase();
  const lastOpen = lower.lastIndexOf('[spoken]');
  const lastClose = lower.lastIndexOf('[/spoken]');
  let safe = acc;
  if (lastOpen > lastClose) safe = acc.slice(0, lastOpen);  // an aside is open with no close yet -> hold from its '['
  // Hold a trailing INCOMPLETE tag that could still become a [SPOKEN]/[/SPOKEN] marker (e.g. '[', '[/SP', '[spoke').
  // A COMPLETE marker (ends in ']') must NOT be cut here — that would orphan its partner and unmask the aside;
  // stripSpoken handles complete markers. So only hold a trailing fragment that does not yet close with ']'.
  const lb = safe.lastIndexOf('[');
  if (lb >= 0 && lb >= safe.length - 9 && !safe.slice(lb).includes(']') && /^\[\/?(s(p(o(k(e(n)?)?)?)?)?)?$/i.test(safe.slice(lb))) safe = safe.slice(0, lb);
  return safe;
}
// Streaming: open the daemon's NDJSON stream and invoke callbacks. onDelta(text) for each written-answer
// fragment (with [SPOKEN] asides removed incrementally), onDone({model}) when the turn ends.
function daemonAskStream(text, onDelta, onDone) {
  let acc = '', emitted = 0, model = '', usage = null;
  dc.streamAsk(text, {
    onDelta: (e) => {
      acc += e.delta;
      const safe = stripSpoken(safeRawPrefix(acc)); // emit only the strip of the safe-to-reveal prefix
      if (safe.length > emitted) { const chunk = safe.slice(emitted); emitted = safe.length; if (chunk) onDelta(chunk); }
    },
    onDone: (e) => {
      model = e.model || model;
      usage = e.usage || usage;
      // the daemon's done.text is the authoritative full written answer; flush whatever was held back.
      const full = stripSpoken(typeof e.text === 'string' && e.text ? e.text : acc);
      if (full.length > emitted) { const chunk = full.slice(emitted); emitted = full.length; if (chunk) onDelta(chunk); }
    },
    onError: (err) => {
      if (err.phase === 'error') { onDelta('(brain unreachable — is the Urfael daemon running?)'); onDone({ model: '', usage: null }); }
      else if (err.phase === 'timeout') { onDelta('(timed out)'); onDone({ model: '', usage: null }); }
      else onDone({ model, usage });                                                                 // 'end': natural stream close
    },
  }, { socketPath: SOCK, timeoutMs: 300000 });
}

function readBody(req) {
  return new Promise((resolve) => { let b = '', over = false;
    req.on('data', (c) => { if (over) return; b += c; if (b.length > MAX_BODY) { over = true; try { req.destroy(); } catch {} resolve(''); } });
    req.on('end', () => { if (!over) resolve(b); }); req.on('error', () => resolve('')); });
}
function sendJson(res, code, obj) { const s = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(s); }
// OpenAI-shaped error body so a client surfaces it cleanly.
function sendErr(res, code, message, type) { sendJson(res, code, { error: { message, type: type || 'invalid_request_error', code: null, param: null } }); }
function unauthorized(res) { res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer' }); res.end(JSON.stringify({ error: { message: 'invalid token', type: 'invalid_request_error', code: 'invalid_api_key', param: null } })); }

function genId() { return 'chatcmpl-' + crypto.randomBytes(12).toString('hex'); }
const KNOWN_MODELS = ['urfael', 'urfael-opus'];

// ---- request handling: rate -> host allowlist -> auth -> tiny fixed API surface (no fs path from URL) ----
const server = http.createServer(async (req, res) => {
  // anti-DNS-rebinding: a loopback-only API must only answer to a loopback Host header
  const host = (req.headers.host || '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') { res.writeHead(400); res.end(); return; }

  let u; try { u = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end(); return; }
  const pathname = u.pathname;

  // auth: EVERY request needs the bearer token (no pre-auth surface here — there is no manifest/static chrome).
  const authed = tokenOk(bearerToken(req));
  if (!authed) { unauthorized(res); return; }
  // rate limit is AUTHENTICATED-only: all loopback requests share 127.0.0.1, so a pre-auth limit would let an
  // unauthenticated local process starve the real owner. Only the holder of the token can spend the bucket.
  const ip = (req.socket && req.socket.remoteAddress) || 'local';
  if (!rateOk(ip)) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'rate limit', type: 'rate_limit_error', code: null, param: null } })); return; }

  // GET /v1/models — advertise the two virtual models clients can pick from.
  if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/v1/models/')) {
    const created = Math.floor(Date.now() / 1000);
    return sendJson(res, 200, { object: 'list', data: KNOWN_MODELS.map((id) => ({ id, object: 'model', created, owned_by: 'urfael' })) });
  }

  // POST /v1/chat/completions — the real endpoint.
  if (req.method === 'POST' && pathname === '/v1/chat/completions') {
    const body = await readBody(req);
    let parsed = null; try { parsed = JSON.parse(body); } catch {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return sendErr(res, 400, 'invalid JSON body');
    const model = (typeof parsed.model === 'string' && parsed.model) ? parsed.model : 'urfael';
    const prompt = buildPrompt(parsed.messages);
    if (!prompt.trim()) return sendErr(res, 400, 'no usable message content');
    const created = Math.floor(Date.now() / 1000);
    const id = genId();

    if (parsed.stream === true) {
      // Server-Sent Events: each chunk is `data: {…}\n\n`, terminated by `data: [DONE]`.
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
      const write = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch {} };
      // first chunk carries the assistant role (OpenAI convention)
      write({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      let clientGone = false;
      res.on('close', () => { clientGone = true; });
      const wantUsage = !!(parsed.stream_options && parsed.stream_options.include_usage); // OpenAI: emit a usage chunk only if asked
      daemonAskStream(prompt,
        (chunk) => { if (!clientGone) write({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] }); },
        (done) => {
          if (!clientGone) {
            write({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
            if (wantUsage) write({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: toUsage(done && done.usage) }); // final usage chunk (choices:[]) per the OpenAI spec
            try { res.write('data: [DONE]\n\n'); } catch {}
          }
          try { res.end(); } catch {}
        });
      return;
    }

    // non-streaming: one JSON completion object — with the REAL token usage the daemon computed
    const { text, usage } = await daemonAskFinal(prompt);
    const content = stripSpoken(text);
    return sendJson(res, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: toUsage(usage),
    });
  }

  res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error', code: null, param: null } })); // no fs lookup, ever
});

// Bootstrap (only when run directly — NOT on require, so the pure functions below are unit-testable without
// minting a token or binding a port). Refuse to run if we can't bind loopback (a bind failure must NOT
// silently fall through to a wider iface).
if (require.main === module) {
  TOKEN = loadOrCreateToken();
  server.on('error', (e) => { process.stderr.write('urfael api: cannot bind ' + HOST + ':' + PORT + ' — ' + ((e && e.message) || e) + '\n'); process.exit(1); });
  server.listen(PORT, HOST, () => {
    // NEVER print the token to stdout — under launchd stdout is a log file. The token is a full-power credential
    // (the brain treats /v1/chat/completions as the local owner). It lives only in the 0600 token file; tell the
    // user where to read it. `urfael serve` reads it and prints the base URL + token path to YOUR terminal.
    process.stdout.write('Urfael OpenAI-compatible API on http://' + HOST + ':' + PORT + '/v1\n');
    process.stdout.write('  bearer token (0600): ' + TOKENF + '   (read it from that file; never logged)\n');
    process.stdout.write('  point any OpenAI client at the base URL above with that token as the API key.\n');
  });
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}
// Pure helpers exported for unit tests (the SSE [SPOKEN]-strip path is the trickiest code in this file).
module.exports = { buildPrompt, stripSpoken, safeRawPrefix, flattenContent, toUsage };
