'use strict';
// Shared unix-socket client for the Urfael daemon. ONE place that speaks the daemon's request/response and its
// /ask NDJSON stream protocol, so a protocol change is made once instead of hand-mirrored across cli.js, tui.js,
// main.js, dashboard.js and openai-api.js (the six surfaces that used to each re-copy this transport, the highest
// probability future-bug site). Node stdlib only, zero deps, and NO side effects on require.
//
// Wire protocol (frozen to match every hand-rolled copy + the daemon's POST /ask route):
//   request(): a single unix-socket round-trip, resolves the RAW response body string. Callers layer their own
//              JSON.parse-or-fallback and error policy on top (some want parse->raw, some parse->null, some
//              reject, some swallow) so that surface-specific choice stays surface-local.
//   streamAsk(): opens POST /ask (or a path override) and frames the NDJSON reply EXACTLY as the copies did:
//              split on '\n', trim each line, skip a blank line, JSON.parse each (skip a line that will not
//              parse), then route by kind. thinking -> onTool (tool present) / onDelta (delta present) /
//              onThinking (anything else, e.g. a reset event the overlay HUD needs); say -> onSay; done ->
//              onDone; a data-plane {kind:'error'} line -> onError(phase 'stream'). The three terminal
//              transitions (socket error, timeout, natural stream end) all reach onError(err) with an
//              err.phase of 'error' | 'timeout' | 'end', so a caller reproduces its exact per-phase marker.
const http = require('http');
const ipc = require('./ipc');

// One resolver for every surface: the 0600 unix socket on POSIX, the per-user named pipe on native Windows
// (see app/ipc.js). authHeaders() is {} on POSIX and the win32 token header otherwise — merged into every
// request below so no caller ever hand-rolls the boundary.
const DEFAULT_SOCK = ipc.daemonSock();

// A single unix-socket round-trip. Resolves the raw response body string on end; rejects with the socket error
// on 'error'; rejects new Error('timeout') on a timeout (after destroying the request, matching the copies).
function request(method, p, body, opts) {
  opts = opts || {};
  const socketPath = opts.socketPath || DEFAULT_SOCK;
  return new Promise((resolve, reject) => {
    const options = { socketPath, method, path: p, headers: { 'Content-Type': 'application/json', ...ipc.authHeaders() } };
    if (opts.timeoutMs) options.timeout = opts.timeoutMs;
    const r = http.request(options, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve(b));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));   // truthy only, matching every hand-rolled copy (callers pass an object or nothing)
    r.end();
  });
}

// Open the daemon's /ask NDJSON stream and drive callbacks. Returns the underlying http.ClientRequest (some
// surfaces keep the handle). Every callback is optional; the routing precedence (tool, then delta, then the raw
// thinking passthrough) lets a surface pick exactly the events it consumed before.
function streamAsk(text, handlers, opts) {
  handlers = handlers || {};
  opts = opts || {};
  const { onDelta, onTool, onSay, onThinking, onDone, onError } = handlers;
  const socketPath = opts.socketPath || DEFAULT_SOCK;
  const reqPath = opts.path || '/ask';
  const body = ('body' in opts) ? opts.body : { text };
  const fail = (phase, err) => { if (onError) { const e = err || new Error(phase); e.phase = phase; onError(e); } };
  const options = { socketPath, method: 'POST', path: reqPath, headers: { 'Content-Type': 'application/json', ...ipc.authHeaders() } };
  if (opts.timeoutMs) options.timeout = opts.timeoutMs;
  const r = http.request(options, (res) => {
    let buf = '';
    res.on('data', (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!ln) continue;
        let e; try { e = JSON.parse(ln); } catch { continue; }   // skip a line that will not parse
        if (e.kind === 'thinking') {
          if (e.tool && onTool) onTool(e);
          else if (typeof e.delta === 'string' && onDelta) onDelta(e);
          else if (onThinking) onThinking(e);
        } else if (e.kind === 'say') { if (onSay) onSay(e); }
        else if (e.kind === 'done') { if (onDone) onDone(e); }
        else if (e.kind === 'error') { fail('stream', e); }       // data-plane error line (the daemon never emits one on /ask today; forward-safe)
      }
    });
    res.on('end', () => fail('end'));
  });
  r.on('error', (err) => fail('error', err));
  r.on('timeout', () => { r.destroy(); fail('timeout'); });
  r.end(typeof body === 'string' ? body : JSON.stringify(body));
  return r;
}

module.exports = { request, streamAsk, DEFAULT_SOCK };
