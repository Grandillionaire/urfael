'use strict';
// @urfael/plugin — the in-cell client a host-reaching plugin uses to make network calls and use secrets. The plugin
// runs in a --network none cell, so it has NO raw network: this is the only way out, and it goes through the daemon's
// egress broker over the bind-mounted 0600 unix socket. Built-ins only, so it works inside the minimal cell image.
//
// A plugin never holds a secret value. It references one by NAME (the REF the owner granted + set), and the broker
// injects the real value into the request to the granted host. The plugin can SPEND a secret against its granted
// host, never read it. The host + port must be in the owner-granted allowlist or the call is refused.
//
//   const { brokerFetch } = require('@urfael/plugin');
//   const res = await brokerFetch({ method: 'GET', host: 'api.example.com', path: '/v1/me', useSecret: 'EXAMPLE_KEY' });
//   // res = { ok, status, headers, body }  (body is the decoded string; the secret is never visible here)
const http = require('http');

const SOCK = process.env.URFAEL_BROKER_SOCK || '/run/urfael/broker.sock';

// brokerFetch(req) — req: { method?, host, port?, path?, headers?, body?, useSecret?, secretHeader?, secretScheme? }.
// Resolves { ok, status?, headers?, body?, redirected?, reason? }. Never throws on a denied/error call (ok:false).
function brokerFetch(req) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      method: req.method || 'GET', host: req.host, port: req.port || 443, path: req.path || '/',
      headers: req.headers || {}, body: req.body != null ? Buffer.from(String(req.body)).toString('base64') : undefined,
      useSecret: req.useSecret, secretHeader: req.secretHeader, secretScheme: req.secretScheme,
    });
    const r = http.request({ socketPath: SOCK, method: 'POST', path: '/fetch', headers: { 'Content-Type': 'application/json' }, timeout: 35000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d));
      res.on('end', () => {
        let j; try { j = JSON.parse(b); } catch { return resolve({ ok: false, reason: 'bad broker response' }); }
        if (j && j.ok && typeof j.body === 'string') { try { j.body = Buffer.from(j.body, 'base64').toString('utf8'); } catch {} }
        resolve(j || { ok: false, reason: 'empty' });
      });
    });
    r.on('error', (e) => resolve({ ok: false, reason: 'broker unreachable: ' + ((e && e.message) || e) }));
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, reason: 'broker timeout' }); });
    r.end(payload);
  });
}
// fetchJson — convenience: brokerFetch + JSON.parse the body.
async function fetchJson(req) { const res = await brokerFetch(req); if (res.ok) { try { res.json = JSON.parse(res.body); } catch {} } return res; }

module.exports = { brokerFetch, fetchJson, SOCK };
