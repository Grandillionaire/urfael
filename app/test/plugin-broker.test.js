'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const b = require('../plugin-broker');

const grant = {
  net: [{ host: 'api.example.com', ports: [443] }],
  secret: [{ ref: 'EXAMPLE_KEY' }],
};
const store = { EXAMPLE_KEY: 'sk-the-real-secret', OTHER: 'nope' };

// ── egress allowlist ──────────────────────────────────────────────────────────────────────────────
test('authorizeEgress allows a granted host that resolves to a public IP', () => {
  const r = b.authorizeEgress(grant, { host: 'api.example.com', port: 443, resolvedIps: ['93.184.216.34'] });
  assert.equal(r.ok, true);
});
test('authorizeEgress denies a host not in the allowlist', () => {
  assert.equal(b.authorizeEgress(grant, { host: 'evil.example.com', port: 443, resolvedIps: ['1.2.3.4'] }).ok, false);
});
test('authorizeEgress denies a non-granted port on a granted host', () => {
  assert.equal(b.authorizeEgress(grant, { host: 'api.example.com', port: 8080, resolvedIps: ['93.184.216.34'] }).ok, false);
});

// ── SSRF on the RESOLVED ip (DNS-rebind defense) ────────────────────────────────────────────────────
test('authorizeEgress denies a granted host whose RESOLVED address is loopback (DNS-rebind)', () => {
  const r = b.authorizeEgress(grant, { host: 'api.example.com', port: 443, resolvedIps: ['127.0.0.1'] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /private|loopback|rebind/i);
});
test('authorizeEgress denies if ANY resolved address is private, even when one is public', () => {
  assert.equal(b.authorizeEgress(grant, { host: 'api.example.com', port: 443, resolvedIps: ['93.184.216.34', '10.0.0.5'] }).ok, false);
  // link-local cloud-metadata address too
  assert.equal(b.authorizeEgress(grant, { host: 'api.example.com', port: 443, resolvedIps: ['169.254.169.254'] }).ok, false);
});
test('authorizeEgress fails closed with no resolved address', () => {
  assert.equal(b.authorizeEgress(grant, { host: 'api.example.com', port: 443, resolvedIps: [] }).ok, false);
  assert.equal(b.authorizeEgress(grant, { host: 'api.example.com', port: 443 }).ok, false);
});

// ── secret by reference: granted host gets it, plugin never sees the value ───────────────────────────
test('resolveSecret returns the value only for a granted+present ref', () => {
  assert.equal(b.resolveSecret(grant, 'EXAMPLE_KEY', store), 'sk-the-real-secret');
  assert.equal(b.resolveSecret(grant, 'OTHER', store), null);          // present but NOT granted
  assert.equal(b.resolveSecret(grant, 'MISSING', store), null);        // granted-form but absent
});

test('prepareRequest injects a granted secret into the outbound header for a granted host', () => {
  const r = b.prepareRequest(grant, { host: 'api.example.com', port: 443, resolvedIps: ['93.184.216.34'], useSecret: 'EXAMPLE_KEY' }, store);
  assert.equal(r.ok, true);
  assert.equal(r.headers.Authorization, 'Bearer sk-the-real-secret');
});

test('prepareRequest refuses to send a secret to a NON-granted host (no secret-to-anywhere)', () => {
  const r = b.prepareRequest(grant, { host: 'evil.example.com', port: 443, resolvedIps: ['1.2.3.4'], useSecret: 'EXAMPLE_KEY' }, store);
  assert.equal(r.ok, false);                                            // blocked at the egress gate, before any secret is touched
  assert.deepEqual(r.headers, {});
});

test('prepareRequest refuses a secret that was not granted, even to a granted host', () => {
  const r = b.prepareRequest(grant, { host: 'api.example.com', port: 443, resolvedIps: ['93.184.216.34'], useSecret: 'OTHER' }, store);
  assert.equal(r.ok, false);
});

// ── frozen in-repo red-team findings (an adversarial review found all three; never let them back) ───
test('FROZEN red-team #1: an IPv6-spelled loopback in resolvedIps is denied in ANY spelling (was a secret-exfil bypass)', () => {
  for (const ip of ['0::1', '0:0::1', '00::1', '0000::0001', '0:0:0::1', '::0.0.0.1', '0:0:0:0:0:ffff:7f00:1', '::1', '::']) {
    assert.equal(b.authorizeEgress(grant, { host: 'api.example.com', port: 443, resolvedIps: [ip] }).ok, false, ip + ' must be blocked');
  }
  // and the full path: a granted secret is NOT sent when the only resolution is IPv6 loopback
  assert.equal(b.prepareRequest(grant, { host: 'api.example.com', port: 443, resolvedIps: ['0::1'], useSecret: 'EXAMPLE_KEY' }, store).ok, false);
});
test('FROZEN red-team #2: a non-IP / malformed resolvedIps entry fails closed (no fail-open SSRF gate)', () => {
  for (const junk of [{}, null, 'not-an-ip', '[object Object]', '999.999.999.999']) {
    assert.equal(b.authorizeEgress(grant, { host: 'api.example.com', port: 443, resolvedIps: [junk] }).ok, false, JSON.stringify(junk) + ' must fail closed');
  }
});
test('FROZEN red-team #3: a missing / zero / NaN port fails closed (no falsy-port skip of the allowlist)', () => {
  assert.equal(b.authorizeEgress(grant, { host: 'api.example.com', resolvedIps: ['8.8.8.8'] }).ok, false);
  assert.equal(b.authorizeEgress(grant, { host: 'api.example.com', port: 0, resolvedIps: ['8.8.8.8'] }).ok, false);
  assert.equal(b.authorizeEgress(grant, { host: 'api.example.com', port: 'x', resolvedIps: ['8.8.8.8'] }).ok, false);
  assert.equal(b.authorizeEgress(grant, { host: 'api.example.com', port: 80, resolvedIps: ['8.8.8.8'] }).ok, false);   // non-granted port still denied
  assert.equal(b.authorizeEgress(grant, { host: 'api.example.com', port: 443, resolvedIps: ['8.8.8.8'] }).ok, true);   // the granted port still allowed
});

test('the redactor masks every injected secret value out of a log line', () => {
  const r = b.prepareRequest(grant, { host: 'api.example.com', port: 443, resolvedIps: ['93.184.216.34'], useSecret: 'EXAMPLE_KEY' }, store);
  const log = r.redactor('POST api.example.com Authorization: Bearer sk-the-real-secret');
  assert.ok(!log.includes('sk-the-real-secret'));
  assert.match(log, /••••/);
});
