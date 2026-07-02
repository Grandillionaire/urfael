'use strict';
// Unit tests for the PURE fortress self-audit core (app/fortress.js). No filesystem, no daemon: every fact is an
// injected fake — a stat-like ({ isSocket, mode }) and a plain /health object — so this proves the DECISION logic
// that backs `urfael doctor`'s fortress row and `urfael attest`'s no-inbound-port posture.
const { test } = require('node:test');
const assert = require('node:assert');
const { auditFortress } = require('../fortress');

const goodSock = () => ({ isSocket: () => true, mode: 0o600 });

test('(a) PASS — 0600 unix socket + daemon self-reports a unix bind => ok, noInboundPort', () => {
  const f = auditFortress({ stat: goodSock(), health: { ok: true, bound: { unix: '/home/u/.claude/urfael/daemon.sock' }, pid: 4242 } });
  assert.equal(f.socket.ok, true);
  assert.equal(f.socket.isUnix, true);
  assert.equal(f.tcp.determined, true);
  assert.equal(f.tcp.ok, true);
  assert.equal(f.ok, true);
  assert.equal(f.noInboundPort, true);
});

test('(b) PASS — bound is a plain unix path string (no tcpPort) => ok', () => {
  const f = auditFortress({ stat: goodSock(), health: { ok: true, bound: '/home/u/.claude/urfael/daemon.sock' } });
  assert.equal(f.tcp.determined, true);
  assert.equal(f.tcp.ok, true);
  assert.equal(f.tcp.port, null);
  assert.equal(f.ok, true);
  assert.equal(f.noInboundPort, true);
});

test('(c) RED — the daemon self-reports a bound TCP port => a listener is present', () => {
  const f = auditFortress({ stat: goodSock(), health: { ok: true, bound: { tcpPort: 18789 }, pid: 99 } });
  assert.equal(f.socket.ok, true);        // the socket itself is fine
  assert.equal(f.tcp.determined, true);
  assert.equal(f.tcp.ok, false);
  assert.equal(f.tcp.port, 18789);
  assert.equal(f.ok, false);
  assert.equal(f.noInboundPort, false);
  assert.match(f.reason, /TCP port/);
});

test('(d) RED — a loosened socket (mode 0644) fails the fortress even if the brain is warm', () => {
  const f = auditFortress({ stat: { isSocket: () => true, mode: 0o644 }, health: { ok: true, bound: { unix: '/x/daemon.sock' } } });
  assert.equal(f.socket.ok, false);
  assert.equal(f.socket.mode, 0o644);
  assert.equal(f.ok, false);
  assert.equal(f.noInboundPort, false);
});

test('(e) RED — a regular file left at the socket path is not a unix socket', () => {
  const f = auditFortress({ stat: { isSocket: () => false, mode: 0o600 }, health: { ok: true, bound: { unix: '/x/daemon.sock' } } });
  assert.equal(f.socket.present, true);
  assert.equal(f.socket.isUnix, false);
  assert.equal(f.socket.ok, false);
  assert.equal(f.ok, false);
  assert.equal(f.noInboundPort, false);
});

test('(e2) RED — the socket file is absent entirely', () => {
  const f = auditFortress({ stat: null, health: { ok: true, bound: { unix: '/x/daemon.sock' } } });
  assert.equal(f.socket.present, false);
  assert.equal(f.socket.ok, false);
  assert.equal(f.ok, false);
  assert.equal(f.noInboundPort, false);
});

test('(f) UNDETERMINED — brain asleep (health null): socket verdict stands, TCP deferred, NO false red', () => {
  const f = auditFortress({ stat: goodSock(), health: null });
  assert.equal(f.socket.ok, true);
  assert.equal(f.tcp.determined, false);   // no self-report to read
  assert.equal(f.ok, true);                // doctor: green on the socket alone — never a false red
  assert.equal(f.noInboundPort, false);    // attest: PROVEN-only, so it degrades to "unknown", not "none"
});

test('(f2) UNDETERMINED — an older daemon /health without `bound` also defers the TCP check', () => {
  const f = auditFortress({ stat: goodSock(), health: { ok: true, warm: [] } });
  assert.equal(f.tcp.determined, false);
  assert.equal(f.ok, true);
  assert.equal(f.noInboundPort, false);
});

test('a bad socket AND an asleep brain still reads red (socket fault dominates)', () => {
  const f = auditFortress({ stat: { isSocket: () => true, mode: 0o666 }, health: null });
  assert.equal(f.socket.ok, false);
  assert.equal(f.ok, false);
  assert.equal(f.noInboundPort, false);
});

test('missing/empty input never throws and reads red (fail-closed)', () => {
  const f = auditFortress();
  assert.equal(f.socket.present, false);
  assert.equal(f.ok, false);
  assert.equal(f.noInboundPort, false);
});
