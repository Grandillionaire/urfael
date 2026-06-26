'use strict';
// app/plugin-brokerd.js — the TRANSPORT half of the plugin egress moat. A host-reaching plugin runs in a
// --network none cell with ONE thing bind-mounted in: a per-plugin 0600 unix socket. This module is the daemon-side
// server on that socket. It is the cell's ONLY egress. The cell is always the HTTP CLIENT; nothing ever dials INTO
// the cell, and there is no new TCP port anywhere (every listener is .listen(<unixSocketPath>), the same class as the
// daemon's own 0600 socket).
//
// The DECISION stays in the frozen, pure plugin-broker.js (authorizeEgress + prepareRequest); this file is a thin,
// heavily-tested transport that:
//   • validates the request shape (fail-closed),
//   • resolves the host ONCE,
//   • asks the broker (allowlist + SSRF-on-resolved-IP + secret-by-reference),
//   • makes the real HTTPS call PINNED to the exact vetted IP (no second getaddrinfo → no DNS-rebind window),
//   • does NOT auto-follow redirects (a 3xx returns to the plugin so a new host re-enters /fetch and is re-authorized),
//   • drops any plugin-supplied Authorization/Host header before injecting the broker's,
//   • forwards ONLY {ok,reason,status,headers,body} to the plugin — never the cleartext secret header or the redactor,
//   • passes every log line through the broker's redactor; never logs the injected secret.
//
// Fully unit-testable Docker-free + network-free: the resolver and the upstream fetch are injectable. Built-ins only.
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const fs = require('fs');
const broker = require('./plugin-broker');
const { isPrivateHost } = require('./lib');

const MAX_BODY = 262144;                                   // request + response body cap (the daemon's MAX_BODY discipline)
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const RESP_HEADER_ALLOW = new Set(['content-type', 'content-length', 'location', 'retry-after', 'date', 'etag', 'last-modified', 'cache-control']);

// default resolver: real DNS, all A/AAAA records.
function defaultResolve(host) {
  return new Promise((resolve) => {
    dns.lookup(host, { all: true }, (err, addrs) => resolve(err ? [] : (addrs || []).map((a) => a.address)));
  });
}
// default upstream fetch: a real HTTPS request PINNED to `ip`, validating TLS against `servername` (the hostname),
// sending Host:servername. No DNS here (host is already an IP), so the vetted IP is exactly what we connect to.
function defaultFetch({ ip, servername, port, path, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: ip, servername, port: port || 443, path: path || '/', method, headers, timeout: 30000 }, (res) => {
      let n = 0; const chunks = [];
      res.on('data', (d) => { n += d.length; if (n > MAX_BODY) { req.destroy(); reject(new Error('response too large')); return; } chunks.push(d); });
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers || {}, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    if (body && body.length) req.write(body);
    req.end();
  });
}

// startBrokerd({ sockPath, grant, store, limits?, log?, resolve?, fetchImpl? }) → { server, stop() }.
// `grant` is the plugin's GRANTED caps ({net:[...], secret:[...]}); `store` maps secret REF -> value (daemon-only).
function startBrokerd(opts) {
  const sockPath = opts.sockPath;
  const grant = opts.grant || {};
  const store = opts.store || {};
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const resolve = typeof opts.resolve === 'function' ? opts.resolve : defaultResolve;
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : defaultFetch;

  const server = http.createServer((req, res) => {
    const send = (code, obj) => { const s = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(s); };
    if (req.method !== 'POST' || req.url !== '/fetch') return send(404, { ok: false, reason: 'only POST /fetch' });
    let body = ''; let over = false;
    req.on('data', (d) => { body += d; if (body.length > MAX_BODY) { over = true; req.destroy(); } });
    req.on('end', () => { if (over) return; handle(body).then((r) => send(r.code, r.obj)).catch((e) => send(500, { ok: false, reason: 'broker error: ' + redact(String((e && e.message) || e)) })); });
  });

  // redact any secret value out of a string (defense in depth for logs/errors).
  const secretRefs = (grant.secret || []).map((s) => s.ref);
  function redact(s) { let out = String(s); for (const r of secretRefs) { const v = store[r]; if (v) out = out.split(v).join('••••'); } return out; }

  async function handle(raw) {
    let r; try { r = JSON.parse(raw || '{}'); } catch { return { code: 400, obj: { ok: false, reason: 'bad json' } }; }
    if (!r || typeof r !== 'object') return { code: 400, obj: { ok: false, reason: 'bad request' } };
    const method = String(r.method || 'GET').toUpperCase();
    if (!METHODS.has(method)) return { code: 400, obj: { ok: false, reason: 'method not allowed: ' + method } };
    const host = typeof r.host === 'string' ? r.host.toLowerCase().trim() : '';
    const port = Number(r.port || 443);
    const reqPath = (typeof r.path === 'string' && r.path[0] === '/') ? r.path : '/';
    if (!host) return { code: 400, obj: { ok: false, reason: 'no host' } };

    // 1) resolve ONCE
    let ips = []; try { ips = await resolve(host); } catch { ips = []; }
    ips = (Array.isArray(ips) ? ips : []).filter((x) => net.isIP(String(x)) !== 0);

    // 2) the frozen broker decides: allowlist + SSRF on the resolved IP + secret-by-reference
    const reqObj = { host, port, resolvedIps: ips, useSecret: r.useSecret, secretHeader: r.secretHeader, secretScheme: r.secretScheme };
    const decision = broker.prepareRequest(grant, reqObj, store);
    if (!decision.ok) { log('deny ' + method + ' ' + host + ':' + port + ' — ' + decision.reason); return { code: 200, obj: { ok: false, reason: decision.reason } }; }

    const ip = ips[0];
    if (!ip || isPrivateHost(String(ip))) return { code: 200, obj: { ok: false, reason: 'resolved ip failed the final guard' } };   // belt-and-suspenders

    // 3) build upstream headers: the plugin's, MINUS any collision with the injected secret header or Host, PLUS broker's
    const injected = Object.keys(decision.headers).map((k) => k.toLowerCase());
    const block = new Set([...injected, 'host', 'content-length']);
    const headers = {};
    if (r.headers && typeof r.headers === 'object') for (const k of Object.keys(r.headers)) { if (block.has(k.toLowerCase())) continue; const v = r.headers[k]; if (typeof v === 'string' && !/[\r\n]/.test(v) && /^[A-Za-z0-9-]{1,64}$/.test(k)) headers[k] = v; }
    headers.Host = host;
    Object.assign(headers, decision.headers);            // the cleartext secret lives ONLY here, in daemon memory

    const reqBody = (typeof r.body === 'string') ? Buffer.from(r.body, 'base64') : null;
    if (reqBody && reqBody.length > MAX_BODY) return { code: 413, obj: { ok: false, reason: 'request body too large' } };

    // 4) the real call, PINNED to the vetted IP. Redirects are NOT auto-followed.
    let up; try { up = await fetchImpl({ ip, servername: host, port, path: reqPath, method, headers, body: reqBody }); }
    catch (e) { log('upstream-error ' + host + ' — ' + redact(String((e && e.message) || e))); return { code: 502, obj: { ok: false, reason: 'upstream error' } }; }

    // 5) return ONLY a safe view to the plugin — never the injected secret header, never the redactor
    const outHeaders = {};
    for (const k of Object.keys(up.headers || {})) if (RESP_HEADER_ALLOW.has(k.toLowerCase())) outHeaders[k] = up.headers[k];
    const buf = Buffer.isBuffer(up.body) ? up.body : Buffer.from(String(up.body || ''));
    log('ok ' + method + ' ' + host + ' → ' + up.status);
    return { code: 200, obj: { ok: true, status: up.status, headers: outHeaders, body: buf.slice(0, MAX_BODY).toString('base64'), redirected: up.status >= 300 && up.status < 400 } };
  }

  try { fs.mkdirSync(require('path').dirname(sockPath), { recursive: true, mode: 0o700 }); } catch {}
  try { fs.unlinkSync(sockPath); } catch {}
  server.on('error', (e) => { try { process.stderr.write('plugin-brokerd: socket bind failed: ' + String((e && e.message) || e) + '\n'); } catch {} });   // an EADDRINUSE/EACCES on listen would otherwise be an uncaught throw
  server.listen(sockPath, () => { try { fs.chmodSync(sockPath, 0o600); } catch {} });   // 0600 unix socket — the same class as the daemon's own; NO TCP port
  return {
    server,
    stop() { try { server.close(); } catch {} try { fs.unlinkSync(sockPath); } catch {} },
  };
}

module.exports = { startBrokerd, MAX_BODY, defaultFetch, defaultResolve };
