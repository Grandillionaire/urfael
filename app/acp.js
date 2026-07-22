'use strict';
// app/acp.js — the thin ACP bridge runtime. An editor (Zed/JetBrains/Neovim/VS Code via ACP) SPAWNS this as a
// child and speaks JSON-RPC 2.0 over its inherited stdin/stdout. This file is pure I/O: it frames JSON-RPC in,
// hands every protocol decision to the PURE acp-translate.js, and proxies prompts to the daemon over the EXISTING
// 0600 unix socket. It opens NO port: its only network primitive is http.request({socketPath: SOCK}) — the same
// outbound AF_UNIX connect() the CLI and the OpenAI API already use. Killing the editor kills this child.
//
// AUTH (documented honestly): a no-channel POST /ask is the full-power local owner turn. Whoever can spawn this
// bridge AND open the 0600 socket is, by definition, the owner uid — the filesystem permission IS the credential.
// Spawning `urfael acp` therefore grants the editor owner-equivalent authority. Single-user only; see docs/ACP.md.
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const acp = require('./acp-translate');
const runScope = require('./run-scope');   // OPT-IN (URFAEL_RUN_SCOPE=1, default OFF) origin-scoped session resume; inert unless the flag is set

const ipc = require('./ipc');
const SOCK = ipc.daemonSock();   // 0600 unix socket on POSIX; per-user named pipe + token on native Windows (see app/ipc.js)
// ORIGIN-SCOPED SESSION RESUME (opt-in, default OFF): each ACP bridge process is ONE editor connection, so its
// sessions belong to a single per-process origin. When the flag is on, a session is stamped with the origin that
// created it and a session/prompt reusing it must present the SAME origin, so a session can never be driven by a
// different origin (defense-in-depth for a leaked/replayed session id). Off by default → the session map and the
// dispatch path are byte-identical, and dispatch's optional origin arg is never read.
const RUN_SCOPE_ON = runScope.enabled(process.env);
const ACP_ORIGIN = 'acp:' + process.pid;
const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const notify = (sessionId, update) => out(acp.rpcNotify('session/update', { sessionId, update }));

// a one-shot daemon call over the socket (for /model, /persona, /abort, /health). Resolves the parsed JSON or null.
function call(method, p, body) {
  return new Promise((resolve) => {
    const r = http.request({ socketPath: SOCK, method, path: p, headers: { 'Content-Type': 'application/json', ...ipc.authHeaders() }, timeout: 30000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
    if (body) r.write(JSON.stringify(body)); r.end();
  });
}

// stream a prompt: open the daemon /ask NDJSON stream, map each line to session/update notifications, resolve the
// session/prompt request with { stopReason } when the turn ends. Never throws (a transport error → a refusal).
function streamPrompt(sessionId, text, reqId) {
  const ctx = acp.newPromptCtx();
  let settled = false;
  const finish = (stopReason) => { if (settled) return; settled = true; out(acp.rpcResult(reqId, { stopReason })); };
  const r = http.request({ socketPath: SOCK, method: 'POST', path: '/ask', headers: { 'Content-Type': 'application/json', ...ipc.authHeaders() }, timeout: 300000 }, (res) => {
    let buf = '';
    res.on('data', (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!ln) continue;
        let e; try { e = JSON.parse(ln); } catch { continue; }
        const { updates, done } = acp.ndjsonLineToUpdate(e, ctx);
        for (const u of updates) notify(sessionId, u);
        if (done) finish(done.stopReason);
      }
    });
    res.on('end', () => finish('end_turn'));
  });
  r.on('error', () => { notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '(brain unreachable — is the Urfael daemon running?)' } }); finish('refusal'); });
  r.on('timeout', () => { r.destroy(); finish('refusal'); });
  r.end(JSON.stringify({ text }));
  return { abort: () => { try { r.destroy(); } catch {} } };
}

// dispatch one inbound JSON-RPC message.
const sessions = new Map();          // sessionId -> { inflight?, origin? }
async function dispatch(msg, origin) {
  if (!msg || msg.jsonrpc !== '2.0') return;
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize': return out(acp.rpcResult(id, acp.handleInitialize()));
    case 'authenticate': return out(acp.rpcResult(id, {}));        // no app-level credential; the 0600 socket is the boundary
    case 'session/new': {
      const sessionId = crypto.randomUUID();                       // editor-supplied mcpServers are intentionally NOT forwarded (moat)
      const s = {};
      if (RUN_SCOPE_ON) s.origin = origin || ACP_ORIGIN;           // bind the creating origin (opt-in); absent by default → byte-identical
      sessions.set(sessionId, s);
      return out(acp.rpcResult(id, { sessionId }));
    }
    case 'session/prompt': {
      const sessionId = params && params.sessionId;
      const s = sessions.get(sessionId);
      if (!s) return out(acp.rpcError(id, -32602, 'unknown session'));
      // ORIGIN-SCOPED RESUME (opt-in): reuse only by the origin that created this session; a cross-origin reuse is
      // refused fail-closed BEFORE the single-flight check touches any session state. Never runs when the flag is off.
      if (RUN_SCOPE_ON && !runScope.canResume(s.origin, origin || ACP_ORIGIN)) return out(acp.rpcError(id, -32603, 'cross-origin resume refused (this session belongs to another origin)'));
      if (s.inflight) return out(acp.rpcError(id, -32603, 'a prompt is already in flight (single warm conversation)'));
      const text = acp.flattenPromptBlocks(params && params.prompt);
      if (!text) return out(acp.rpcResult(id, { stopReason: 'end_turn' }));
      s.inflight = streamPrompt(sessionId, text, id);
      const clear = () => { s.inflight = null; };
      // streamPrompt resolves the request itself; we just clear the flag shortly after (best-effort)
      setTimeout(clear, 0); s._clear = clear;
      return;
    }
    case 'session/cancel': {                                       // a notification — abort the in-flight turn
      await call('POST', '/abort');
      return;
    }
    case 'session/set_mode': {
      const mode = String((params && params.modeId) || '');
      if (mode === 'opus' || mode === 'sonnet') await call('POST', '/model', { model: mode });
      else if (mode === 'auto') await call('POST', '/model', { action: 'auto' });
      else await call('POST', '/persona', { id: mode });
      if (isRequest) out(acp.rpcResult(id, {}));
      return;
    }
    default:
      if (isRequest) out(acp.rpcError(id, -32601, 'method not found: ' + method));
  }
}

function run() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const ln = buf.slice(0, i); buf = buf.slice(i + 1); const m = acp.parseFramedLine(ln); if (m) dispatch(m).catch(() => {}); }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}
// --probe: a human-facing readiness check (NOT the JSON-RPC loop) — confirm the daemon is reachable + print config.
async function probe() {
  const h = await call('GET', '/health');
  const ok = !!(h && h.ok);
  process.stderr.write((ok ? 'urfael acp: daemon reachable.\n' : 'urfael acp: daemon NOT reachable — start it (urfael doctor).\n')
    + 'Editor config (Zed agent_servers): { "urfael": { "command": "urfael", "args": ["acp"] } }\n'
    + 'WARNING: spawning this bridge grants the editor OWNER-EQUIVALENT authority (it drives the full-power local turn). Single-user only.\n');
  process.exit(ok ? 0 : 1);
}

module.exports = { run, probe, streamPrompt, dispatch, SOCK };
if (require.main === module) { (process.argv.includes('--probe') ? probe() : run()); }
