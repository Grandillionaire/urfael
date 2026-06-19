'use strict';
// Frozen regressions for the battle-hardening fixes (found by the fuzz + redteam harnesses). Each asserts a
// real defect stays fixed: the SSRF-guard encoding bypass, two ReDoS, and a ledger-verifier crash. Pure + fast.
const { test } = require('node:test');
const assert = require('node:assert');
const lib = require('../lib');
const md = require('../md');
const hub = require('../skillhub');
const chain = require('../audit-chain');

test('SSRF: isPrivateHost blocks every encoding of loopback/internal (decimal/hex/octal/short/mapped)', () => {
  for (const h of ['127.0.0.1', '127.1', '0177.0.0.1', '2130706433', '0x7f000001', '0x7f.0.0.1', '017700000001',
                   '::1', '::ffff:127.0.0.1', '0.0.0.0', '10.0.0.5', '192.168.1.1', '172.16.5.5', '169.254.169.254',
                   '100.64.0.1', 'fc00::1', 'fe80::1', 'localhost', 'x.internal'])
    assert.equal(lib.isPrivateHost(h), true, h + ' must be classified private (it routes to loopback/internal)');
});

test('SSRF: isPrivateHost still ALLOWS legitimate public hosts (no over-block)', () => {
  for (const h of ['8.8.8.8', '1.1.1.1', '203.0.113.10', 'example.com', 'github.com', '142.250.0.1'])
    assert.equal(lib.isPrivateHost(h), false, h + ' is public and must stay reachable');
});

test('SSRF: a relay reply URL to an encoded loopback host is rejected by normalizeHook', () => {
  for (const h of ['2130706433', '0x7f000001', '127.1', '017700000001']) {
    const r = lib.normalizeHook({ name: 'x', action: 'relay', replyUrl: 'http://' + h + '/cb' });
    assert.ok(!(r && r.replyUrl), 'normalizeHook must not accept a relay replyUrl to ' + h);
  }
});

test('ReDoS: skillhub.scan is bounded on a long single line (was quadratic, ~3.6s at 100k)', () => {
  const s = 'curl http://' + 'a'.repeat(100000);
  const t = Date.now(); const r = hub.scan(s); const ms = Date.now() - t;
  assert.ok(ms < 400, 'scan took ' + ms + 'ms — should be ~linear (< 400ms)');
  assert.ok(r.flags.some((f) => /network|exfiltrat/.test(f.why)), 'still flags the network call (detection intact)');
});

test('ReDoS: md.toAnsi is bounded on a long run of one char (link/bold/code spans)', () => {
  for (const ch of ['[', '`', '*']) {
    const s = ch.repeat(60000);
    const t = Date.now(); md.toAnsi(s, { color: true, base: '\x1b[33m' }); const ms = Date.now() - t;
    assert.ok(ms < 400, 'md.toAnsi on 60k "' + ch + '" took ' + ms + 'ms — should be ~linear');
  }
  // and normal markdown still renders (bounds did not break real content)
  const out = md.toAnsi('a **bold** and `code` and [t](http://x)', { color: false });
  assert.equal(out, 'a bold and code and t');
});

test('Ledger: audit-chain.verify fails closed on a malformed (non-object) line, never throws', () => {
  assert.doesNotThrow(() => chain.verify(['null']));
  assert.equal(chain.verify(['null']).ok, false);
  assert.equal(chain.verify(['123']).ok, false);
  assert.equal(chain.verify(['"a string"']).ok, false);
  assert.equal(chain.verify(['[]']).ok, false);
  assert.equal(chain.verify(['not json at all']).ok, false);
});
