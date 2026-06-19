'use strict';
// app/plugin-broker.js — the two new trusted seams that let a sandboxed plugin reach the network and use a secret
// WITHOUT either power becoming an exfiltration channel. This is the highest-value target in the system, so it is
// pure, exhaustively tested, and frozen behind benchmark probes; a net or secret grant cannot be enabled until
// these guarantees hold.
//
// A plugin runs in a --network none cell: it has NO raw network. To reach an allowlisted host it asks the HOST
// (the daemon) to make the call. The broker is that mediator. It enforces, per request:
//   1. EGRESS ALLOWLIST — the host must be one the owner granted (exact FQDN), on a granted port.
//   2. SSRF ON THE RESOLVED IP — the host's resolved address(es) must be public. Re-checked at connect time, not
//      just on the FQDN, so a DNS-rebind ("api.evil.com → 127.0.0.1") cannot turn a granted host into a loopback hit.
//   3. SECRET BY REFERENCE — a plugin names a secret (e.g. "STRIPE_KEY"); the broker injects the real value into the
//      outbound request to a GRANTED host only, and the plugin never sees the value. A compromised plugin can spend
//      a granted secret against its granted host, never read or exfiltrate it.
// Pure: the daemon supplies the DNS resolver result and the secret store; the broker decides yes/no and masks.
const net = require('net');
const { isPrivateHost } = require('./lib');

// authorizeEgress(grant, req) — req = { host, port, resolvedIps:[...] }. grant.net = [{host, ports:[...]}].
// Returns { ok, reason }. FAIL-CLOSED: anything not explicitly allowed is denied. Every gate is strict — a missing
// port, a malformed resolvedIps entry, or an IPv6-spelled loopback are all denials, not skips (in-repo red-team findings).
function authorizeEgress(grant, req) {
  const netRules = (grant && Array.isArray(grant.net)) ? grant.net : [];
  const host = (req && typeof req.host === 'string') ? req.host.toLowerCase().trim() : '';
  if (!host) return { ok: false, reason: 'no host (or non-string host)' };
  const port = Number(req && req.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: 'invalid/missing port (fail-closed)' };
  if (isPrivateHost(host)) return { ok: false, reason: 'host literal is private/loopback' };
  const rule = netRules.find((n) => n && typeof n.host === 'string' && n.host.toLowerCase() === host);
  if (!rule) return { ok: false, reason: 'host not in the granted allowlist: ' + host };
  const ports = (Array.isArray(rule.ports) && rule.ports.length) ? rule.ports : [443];
  if (!ports.includes(port)) return { ok: false, reason: 'port ' + port + ' not granted for ' + host };   // strict: a falsy port no longer skips the check
  // SSRF on the RESOLVED address(es): every entry must be a REAL IP literal AND public. Non-IP junk or an empty
  // resolution fails closed (a malformed/compromised resolver result can't sail through the last line of defense).
  const ips = (req && Array.isArray(req.resolvedIps)) ? req.resolvedIps : null;
  if (!ips || !ips.length) return { ok: false, reason: 'no resolved address (fail-closed)' };
  for (const ip of ips) {
    if (net.isIP(String(ip)) === 0) return { ok: false, reason: 'resolved entry is not a valid IP (fail-closed): ' + String(ip) };
    if (isPrivateHost(String(ip))) return { ok: false, reason: 'resolved address is private/loopback (DNS-rebind?): ' + ip };
  }
  return { ok: true, reason: 'ok' };
}

// resolveSecret(grant, ref, store) — store maps REF -> value (the daemon's 0600 secret store). Returns the value
// ONLY if the ref was granted AND present; otherwise null. The plugin never receives this; the broker uses it.
function resolveSecret(grant, ref, store) {
  const granted = (grant && Array.isArray(grant.secret)) ? grant.secret.map((s) => s.ref) : [];
  const r = String(ref || '');
  if (!r || !granted.includes(r)) return null;                          // not granted → no value
  const v = store && Object.prototype.hasOwnProperty.call(store, r) ? store[r] : null;
  return (typeof v === 'string' && v) ? v : null;
}

// prepareRequest(grant, req, store) — the full decision for one brokered outbound call. req may carry useSecret:'REF'
// and secretHeader (default 'Authorization', value 'Bearer <v>'). Returns { ok, reason, headers, redactor }.
// The returned redactor masks any injected secret value out of logs. NEVER returns the secret to the caller's plugin.
function prepareRequest(grant, req, store) {
  const auth = authorizeEgress(grant, req);
  if (!auth.ok) return { ok: false, reason: auth.reason, headers: {}, redactor: (s) => s };
  const headers = {};
  const secretValues = [];
  if (req && req.useSecret) {
    const v = resolveSecret(grant, req.useSecret, store);
    if (!v) return { ok: false, reason: 'secret "' + req.useSecret + '" not granted or not present', headers: {}, redactor: (s) => s };
    const hdr = (typeof req.secretHeader === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(req.secretHeader)) ? req.secretHeader : 'Authorization';
    headers[hdr] = (req.secretScheme === 'raw') ? v : ('Bearer ' + v);
    secretValues.push(v);
  }
  // SEAM CONTRACT: the daemon forwards ONLY { ok, reason } to the plugin — never `headers` (which holds the cleartext
  // secret) or `redactor`. And the real connection must pin to the exact `resolvedIps` checked above (no re-resolution),
  // or the DNS-rebind window reopens. Both are the daemon transport's responsibility (the next increment).
  return { ok: true, reason: 'ok', headers, redactor: (s) => redactSecrets(String(s), secretValues) };
}

// redactSecrets — mask every secret value so a broker log/trace can never print one.
function redactSecrets(text, values) {
  let out = String(text == null ? '' : text);
  for (const v of (values || [])) if (v && typeof v === 'string') out = out.split(v).join('••••');
  return out;
}

module.exports = { authorizeEgress, resolveSecret, prepareRequest, redactSecrets };
