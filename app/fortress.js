'use strict';
// app/fortress.js — the fortress self-audit: a PURE, dependency-free verifier for Urfael's first principle,
// "no inbound port". It takes only two injected facts and returns a verdict, so it unit-tests with fakes and
// never touches the filesystem or the network itself:
//   - stat:   an fs.Stats-like for the daemon's unix socket path (or null if the socket file is absent)
//   - health: the daemon's own /health self-report (or null when the brain is asleep / unreachable)
//
// The socket verdict is on-disk truth (an AF_UNIX socket file at 0600). The TCP verdict is the daemon's
// AUTHORITATIVE self-report of what server.address() bound to — a unix path proves no port; a tcpPort proves a
// listener. Two derived booleans keep the two consumers honest:
//   - ok            : the doctor verdict. Green unless something is provably WRONG (a drifted socket, or a bound
//                     TCP port). When the brain is asleep the TCP part is UNDETERMINED, so ok defers to the socket
//                     verdict — never a false red.
//   - noInboundPort : the attestation posture. CONSERVATIVE: only true when the no-port property is PROVEN (the
//                     socket is ok AND the daemon self-reported no TCP bind). Undetermined => falsy, so
//                     `urfael attest` prints "unknown" instead of overclaiming "none".
function auditFortress(input) {
  const inp = input || {};
  const stat = inp.stat || null;
  const health = inp.health && typeof inp.health === 'object' ? inp.health : null;

  // 1) the socket file: present, a real AF_UNIX socket (not a regular file left at the path), and 0600.
  const present = !!stat;
  const isUnix = !!(stat && typeof stat.isSocket === 'function' && stat.isSocket());
  const mode = stat && typeof stat.mode === 'number' ? (stat.mode & 0o777) : null;
  const socketOk = present && isUnix && mode === 0o600;
  const socket = { present, isUnix, mode, ok: socketOk };

  // 2) the TCP verdict from the daemon's own server.address() self-report in /health.bound:
  //    a unix path (a string, or { unix }) => no port bound; { tcpPort:n } => a listener is bound; absent => unknown.
  const bound = health ? health.bound : undefined;
  let determined = false, port = null, tcpOk = false;
  if (typeof bound === 'string') { determined = true; tcpOk = true; }
  else if (bound && typeof bound === 'object') {
    if (typeof bound.tcpPort === 'number') { determined = true; port = bound.tcpPort; tcpOk = false; }
    else { determined = true; tcpOk = true; }   // { unix: '…' } (or any non-tcpPort binding) => no port
  }
  const tcp = { determined, port, ok: tcpOk };

  // the doctor verdict: red only on a provable fault; an undetermined TCP check defers to the socket (no false red).
  const ok = socketOk && (determined ? tcpOk : true);
  // the attestation posture: PROVEN-only. Undetermined (brain asleep) => falsy, so attest degrades to "unknown".
  const noInboundPort = socketOk && determined && tcpOk;

  let reason;
  if (!present) reason = 'socket file missing';
  else if (!isUnix) reason = 'path is not a unix socket';
  else if (mode !== 0o600) reason = 'socket mode ' + (mode == null ? '?' : mode.toString(8)) + ' (want 0600)';
  else if (determined && !tcpOk) reason = 'a TCP port is bound: ' + port;
  else if (!determined) reason = 'no inbound port on disk; TCP self-report unavailable (brain asleep)';
  else reason = 'no inbound port (0600 unix socket only)';

  return { ok, socket, tcp, noInboundPort, reason };
}

module.exports = { auditFortress };
