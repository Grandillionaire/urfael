'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { startBrokerd } = require('../plugin-brokerd');

const GRANT = { net: [{ host: 'api.example.com', ports: [443] }], secret: [{ ref: 'EXAMPLE_KEY' }] };
const STORE = { EXAMPLE_KEY: 'sk-the-real-secret' };
const PUBLIC_IP = '93.184.216.34';

// POST /fetch over the brokerd's unix socket and resolve the parsed JSON.
function fetchOverSock(sockPath, reqObj) {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath: sockPath, method: 'POST', path: '/fetch', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, json: b }); } });
    });
    r.on('error', reject); r.write(JSON.stringify(reqObj)); r.end();
  });
}

// spin up a brokerd with injected resolver + upstream; returns { sock, stop, calls } where calls records fetchImpl args.
function withBrokerd(t, { grant = GRANT, store = STORE, resolve, fetchImpl }) {
  const sock = path.join(os.tmpdir(), 'ubd-' + crypto.randomBytes(6).toString('hex') + '.sock');
  const calls = [];
  const fi = fetchImpl || (async (a) => { calls.push(a); return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":1}') }; });
  const h = startBrokerd({ sockPath: sock, grant, store, resolve: resolve || (async () => [PUBLIC_IP]), fetchImpl: fi, log: () => {} });
  t.after(() => h.stop());
  return { sock, calls, handle: h };
}
const ready = (sock) => new Promise((res) => { const tryIt = () => { const r = http.request({ socketPath: sock, method: 'POST', path: '/ping' }, () => res()).on('error', () => setTimeout(tryIt, 15)); r.end(); }; setTimeout(tryIt, 15); });

// ── allow path: the broker's secret is injected to the VETTED ip; the plugin never sees the secret ──
test('allow: a granted host resolves to a public ip → fetch is pinned to that ip with the injected secret header', async (t) => {
  const { sock, calls } = withBrokerd(t, {});
  await ready(sock);
  const r = await fetchOverSock(sock, { method: 'GET', host: 'api.example.com', port: 443, path: '/v1/data', useSecret: 'EXAMPLE_KEY' });
  assert.equal(r.json.ok, true);
  assert.equal(calls.length, 1, 'upstream was called exactly once');
  assert.equal(calls[0].ip, PUBLIC_IP, 'connected to the vetted resolved ip (IP-pin), not a re-resolved host');
  assert.equal(calls[0].servername, 'api.example.com', 'TLS validated against the hostname');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-the-real-secret', 'broker injected the secret');
  // the secret value must NOT appear anywhere in the response the plugin receives
  assert.ok(!JSON.stringify(r.json).includes('sk-the-real-secret'), 'secret never returned to the plugin');
});

// ── deny paths: nothing is fetched, no secret is touched ──
test('deny: a non-granted host is refused and the upstream is NEVER called', async (t) => {
  const { sock, calls } = withBrokerd(t, {});
  await ready(sock);
  const r = await fetchOverSock(sock, { method: 'GET', host: 'evil.example.com', port: 443, useSecret: 'EXAMPLE_KEY' });
  assert.equal(r.json.ok, false);
  assert.equal(calls.length, 0, 'no upstream fetch on a denied host');
});

test('deny: DNS-rebind — a granted host that RESOLVES to loopback is refused, upstream never called', async (t) => {
  const { sock, calls } = withBrokerd(t, { resolve: async () => ['127.0.0.1'] });
  await ready(sock);
  const r = await fetchOverSock(sock, { method: 'GET', host: 'api.example.com', port: 443 });
  assert.equal(r.json.ok, false);
  assert.equal(calls.length, 0);
});
test('deny: IPv6-spelled loopback (0::1) resolution is refused', async (t) => {
  const { sock, calls } = withBrokerd(t, { resolve: async () => ['0::1'] });
  await ready(sock);
  const r = await fetchOverSock(sock, { method: 'GET', host: 'api.example.com', port: 443 });
  assert.equal(r.json.ok, false);
  assert.equal(calls.length, 0);
});
test('deny: a non-granted port is refused', async (t) => {
  const { sock, calls } = withBrokerd(t, {});
  await ready(sock);
  const r = await fetchOverSock(sock, { method: 'GET', host: 'api.example.com', port: 8080 });
  assert.equal(r.json.ok, false);
  assert.equal(calls.length, 0);
});

// ── header-collision defense: a plugin can't pre-seed Authorization to read the secret back ──
test('a plugin-supplied Authorization header is STRIPPED before the broker injects the real one', async (t) => {
  const { sock, calls } = withBrokerd(t, {});
  await ready(sock);
  await fetchOverSock(sock, { method: 'GET', host: 'api.example.com', port: 443, useSecret: 'EXAMPLE_KEY', headers: { Authorization: 'Bearer attacker-controlled', 'X-Fine': 'kept' } });
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-the-real-secret', 'attacker header overwritten by the injected secret');
  assert.equal(calls[0].headers['X-Fine'], 'kept', 'a harmless plugin header passes through');
  assert.equal(calls[0].headers.Host, 'api.example.com', 'Host is set by the broker, not the plugin');
});

// ── redirects are not auto-followed (a new host must re-enter /fetch and be re-authorized) ──
test('a 3xx upstream is returned to the plugin, not auto-followed', async (t) => {
  const { sock, calls } = withBrokerd(t, { fetchImpl: async (a) => { calls.push(a); return { status: 302, headers: { location: 'https://evil.example.com/' }, body: Buffer.alloc(0) }; } });
  await ready(sock);
  const r = await fetchOverSock(sock, { method: 'GET', host: 'api.example.com', port: 443 });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.status, 302);
  assert.equal(r.json.redirected, true);
  assert.equal(calls.length, 1, 'exactly one upstream call — the redirect was NOT followed by the broker');
});

// ── shape validation: fail-closed, never throws ──
test('shape validation: bad json / bad method / missing host fail closed', async (t) => {
  const { sock } = withBrokerd(t, {});
  await ready(sock);
  for (const bad of [{ method: 'CONNECT', host: 'api.example.com', port: 443 }, { method: 'GET', port: 443 }]) {
    const r = await fetchOverSock(sock, bad);
    assert.equal(r.json.ok, false, JSON.stringify(bad) + ' must be refused');
  }
});

// ── per-plugin isolation: a brokerd is closed over ONE grant ──
test('per-plugin isolation: a brokerd built for plugin A cannot reach plugin B\'s host', async (t) => {
  const { sock, calls } = withBrokerd(t, { grant: { net: [{ host: 'a-only.example.com', ports: [443] }], secret: [] } });
  await ready(sock);
  const r = await fetchOverSock(sock, { method: 'GET', host: 'b-only.example.com', port: 443 });
  assert.equal(r.json.ok, false);
  assert.equal(calls.length, 0);
});
