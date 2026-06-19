'use strict';
// redteam.js — a differential adversarial harness for the SSRF moat. The static benchmark tests two fixed hosts
// (169.254.169.254, 127.0.0.1:9000); this drives the FULL space of loopback/internal encodings that the OS
// resolver accepts and proves them BOTH ways: (a) lib.isPrivateHost must classify each as private, and (b) a real
// http.request to it must NOT reach our loopback server while the guard says it is public — the exact internal-
// write SSRF primitive (the relay reply sender + skill fetcher gate on isPrivateHost). The hardest oracle:
//   guard says PUBLIC  AND  socket CONNECTS to loopback  ==  HARD FAIL.
//   npm run redteam
const http = require('http');
const lib = require('../lib');

// Every encoding of 127.0.0.1 / internal that inet_aton (and therefore http.request) accepts. All must be PRIVATE.
const LOOPBACK_FORMS = [
  '127.0.0.1', '127.1', '127.0.1', '0177.0.0.1', '2130706433', '0x7f000001', '0x7f.0.0.1', '017700000001',
  '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'localhost', '127.0.0.2', '0.0.0.0',
  // IPv6 loopback in its many compressed spellings — the class an in-repo red-team caught the guard matching textually
  '0::1', '0:0::1', '00::1', '0000::0001', '0:0:0::1', '::0.0.0.1', '0:0:0:0:0:ffff:7f00:1', '::',
];
const INTERNAL_FORMS = ['10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.64.0.1', 'fc00::1', 'fe80::1', 'foo.internal', 'bar.local'];
const PUBLIC_FORMS = ['8.8.8.8', '1.1.1.1', '203.0.113.10', 'example.com', 'github.com', 'raw.githubusercontent.com', '142.250.0.1'];

const fails = [];
const fail = (m) => fails.push(m);

// ---- 1) STATIC classification: every loopback/internal form private, every public form not -------------
for (const h of LOOPBACK_FORMS.concat(INTERNAL_FORMS)) if (lib.isPrivateHost(h) !== true) fail('isPrivateHost("' + h + '") = false — an internal host the relay/fetcher would be allowed to reach (SSRF)');
for (const h of PUBLIC_FORMS) if (lib.isPrivateHost(h) !== false) fail('isPrivateHost("' + h + '") = true — a legit public host is now wrongly blocked');

// the normalizeHook gate (the relay reply sender's allowlist) must reject every loopback form too
for (const h of LOOPBACK_FORMS.slice(0, 8)) {
  const r = lib.normalizeHook({ name: 'x', action: 'relay', replyUrl: 'http://' + h + '/path' });
  if (r && r.replyUrl) fail('normalizeHook accepted a relay replyUrl to ' + h + ' — internal-write SSRF via the relay');
}

// ---- 2) LIVE differential: a host the guard says PUBLIC must not actually reach loopback ---------------
function reaches(host, port, cb) {
  const req = http.request({ host, port, path: '/', timeout: 800 }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => cb(b === 'LOOPBACK-HIT')); });
  req.on('error', () => cb(false)); req.on('timeout', () => { req.destroy(); cb(false); });
  req.end();
}
const srv = http.createServer((q, s) => s.end('LOOPBACK-HIT')).listen(0, '127.0.0.1', () => {
  const port = srv.address().port;
  // numeric/encoded forms the OS will route to loopback — for each, if the socket connects BUT the guard says
  // public, that is the live SSRF primitive. (After hardening, every one is classified private, so none reach here.)
  const connectForms = ['127.0.0.1', '2130706433', '0x7f000001', '127.1'].filter((h) => lib.isPrivateHost(h) === false);
  let pending = connectForms.length;
  const finish = () => { srv.close(); report(); };
  if (!pending) return finish();
  for (const h of connectForms) reaches(h, port, (hit) => { if (hit) fail('LIVE SSRF: http.request("' + h + '") reached loopback while isPrivateHost said PUBLIC'); if (--pending === 0) finish(); });
});

function report() {
  if (fails.length) {
    console.error('\n✗ REDTEAM FAILED — ' + fails.length + ' finding(s):');
    for (const f of fails) console.error('  • ' + f);
    console.error('\nHarden lib.isPrivateHost (parse decimal/hex/octal/short-form + IPv4-mapped IPv6) until every form classifies private.');
    process.exit(1);
  }
  console.log('✓ redteam: SSRF moat holds — ' + (LOOPBACK_FORMS.length + INTERNAL_FORMS.length) + ' internal forms blocked (incl. decimal/hex/octal/short/mapped), '
    + PUBLIC_FORMS.length + ' public hosts allowed, relay gate rejects loopback, and no encoded host reaches loopback past the guard.');
}
