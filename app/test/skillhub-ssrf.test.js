'use strict';
// SSRF regression for the skill fetcher. Before the fix, isPrivateHost() was a LITERAL-only check and fetchMd
// handed the raw hostname to https.request — so a public-looking name whose DNS A-record points at
// 169.254.169.254 / 127.0.0.1 / an RFC1918 box (a DNS-rebind) sailed past the guard and Node connected to the
// private IP. The fix resolves the name and re-checks EVERY resolved IP before connecting (and pins the socket
// to a vetted IP). The resolver is injectable, so this needs no network. Mirrors test/redteam.js's discipline
// but covers the case redteam couldn't reach: a NAME that resolves to a private address.
const { test } = require('node:test');
const assert = require('node:assert');
const skillhub = require('../skillhub');

const PRIVATE = ['169.254.169.254', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.9.9', '100.64.0.1', '::1', 'fd00::1'];

test('a public NAME that resolves to a private IP is refused BEFORE any socket opens (DNS-rebind)', async () => {
  for (const ip of PRIVATE) {
    // resolver claims the attacker domain points at a private address; fetchMd must reject, not connect.
    const resolve = async () => [ip];
    await assert.rejects(
      () => skillhub.fetchMd('https://totally-public.example/skill.md', 0, { resolve }),
      /private\/loopback ip \(SSRF\)/,
      'name → ' + ip + ' must be refused',
    );
  }
});

test('a mixed answer with ONE private IP is refused (an attacker cannot smuggle a bad IP alongside good ones)', async () => {
  const resolve = async () => ['93.184.216.34', '127.0.0.1'];
  await assert.rejects(() => skillhub.fetchMd('https://x.example/s.md', 0, { resolve }), /private\/loopback ip \(SSRF\)/);
});

test('an unresolvable host is refused fail-closed (empty answer never opens the fetch)', async () => {
  const resolve = async () => [];
  await assert.rejects(() => skillhub.fetchMd('https://nx.example/s.md', 0, { resolve }), /could not resolve host/);
});

test('a literal private host is still refused up front, before DNS is even consulted', async () => {
  let resolverCalled = false;
  const resolve = async () => { resolverCalled = true; return ['93.184.216.34']; };
  await assert.rejects(() => skillhub.fetchMd('https://169.254.169.254/latest/meta-data/', 0, { resolve }), /private\/loopback host \(SSRF\)/);
  assert.equal(resolverCalled, false, 'a literal private host short-circuits before the resolver runs');
});

test('non-https is still refused regardless of where it resolves', async () => {
  await assert.rejects(() => skillhub.fetchMd('http://public.example/s.md', 0, { resolve: async () => ['93.184.216.34'] }), /non-https/);
});
