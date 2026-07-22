'use strict';
// app/ipc.js — ONE place that knows where the daemon's control plane lives on each OS, and what proves
// you may speak to it. Everything here is pure + injected (env/platform/fs passed in), so both OS branches
// are unit-tested from any host — the same discipline as platform.js.
//
// The boundary, per OS:
//   POSIX (macOS/Linux/WSL): a unix-domain socket chmod'd 0600. The kernel enforces owner-only; there is no
//     app-level credential, and this file adds none — the POSIX wire is byte-identical to what shipped.
//   Native Windows: AF_UNIX + 0600 does not exist as a kernel guarantee, so the boundary becomes possession
//     of a per-user random token. The daemon listens on a per-user named pipe (pipe names are enumerable, so
//     the NAME is not the secret) and requires the token on EVERY request. The token file lives inside the
//     user profile (already ACL'd to the user + SYSTEM + Administrators by default) and is additionally
//     hardened with icacls to strip inheritance. Reading it == you already are the user; that is the same
//     trust statement 0600 makes on POSIX.
//
// Nothing here opens a TCP port on any OS.
const crypto = require('crypto');
const os = require('os');
const path = require('path');

function homedir(env) {
  const e = env || process.env || {};
  return String(e.HOME || e.USERPROFILE || os.homedir() || '');
}

// The state dir. URFAEL_STATE_DIR isolates a TEST daemon onto its own socket/pipe + token, exactly as
// daemon.js documents for its JDIR — honoring it here keeps that isolation guarantee on every OS.
function jdir(env) {
  const e = env || process.env || {};
  return e.URFAEL_STATE_DIR ? path.resolve(String(e.URFAEL_STATE_DIR)) : path.join(homedir(env), '.claude', 'urfael');
}

// Stable per-user (and per-state-dir) pipe suffix. NOT a secret (pipe names are enumerable via \\.\pipe\) —
// it only keeps two users, or a cert daemon and the real one, from colliding. The secret is the token.
function userTag(env) {
  return crypto.createHash('sha256').update(jdir(env).toLowerCase()).digest('hex').slice(0, 12);
}

// Where the daemon listens. `name` distinguishes co-resident servers ('daemon', 'broker', …).
function sockPath(name, env, platform) {
  const p = platform || process.platform;
  const n = String(name || 'daemon');
  if (p === 'win32') return '\\\\.\\pipe\\urfael-' + n + '-' + userTag(env);
  return path.join(jdir(env), n + '.sock');
}
function daemonSock(env, platform) { return sockPath('daemon', env, platform); }

function tokenPath(env) { return path.join(jdir(env), 'daemon.token'); }   // rides jdir → URFAEL_STATE_DIR-isolated too

// Does this host need the app-level token? Only native Windows — POSIX keeps the pure-kernel boundary.
function needsAuth(platform) { return (platform || process.platform) === 'win32'; }

// Create-or-read the shared token. Exclusive create ('wx') makes the daemon/client race benign: exactly one
// writer wins, everyone else reads the winner's bytes. Any local process that can READ this file already has
// the user's profile — which is precisely the principal the boundary admits.
function ensureToken(fsx, env) {
  const fs = fsx || require('fs');
  const file = tokenPath(env);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
  const fresh = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, fresh + '\n', { mode: 0o600, flag: 'wx' });
    return fresh;
  } catch {
    try { return String(fs.readFileSync(file, 'utf8')).trim(); } catch { return ''; }
  }
}
function loadToken(fsx, env) {
  const fs = fsx || require('fs');
  try { return String(fs.readFileSync(tokenPath(env), 'utf8')).trim(); } catch { return ''; }
}

// Best-effort ACL tightening on win32: strip inherited ACEs, grant only the current user. chmod 0600 is a
// near no-op there, and the profile default already excludes other users — this just closes the "machine
// admin added a lax inherited ACE" corner. Failure is non-fatal by design (the default ACL still holds).
function hardenWin32(file, env, execFileSync) {
  const e = env || process.env || {};
  const user = String(e.USERNAME || e.USER || '');
  if (!user) return false;
  const run = execFileSync || require('child_process').execFileSync;
  try {
    run('icacls', [file, '/inheritance:r', '/grant:r', user + ':F'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch { return false; }
}

// Headers a local client must attach. POSIX: none (the kernel already vouched for you). win32: the token —
// created on first use so whichever side boots first (client or daemon) mints it and the other reads it.
function authHeaders(env, platform, fsx) {
  if (!needsAuth(platform)) return {};
  const t = ensureToken(fsx, env);
  return t ? { 'x-urfael-token': t } : {};
}

// Constant-time check of a presented token. Empty expected token fails CLOSED (a daemon that could not mint
// or read its token must refuse everyone rather than admit anyone).
function checkAuth(presented, expected) {
  const a = Buffer.from(String(presented || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (!b.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { sockPath, daemonSock, tokenPath, needsAuth, ensureToken, loadToken, hardenWin32, authHeaders, checkAuth, userTag, jdir };
