'use strict';
// daemonctl.js — a tiny, dependency-free way for the brain (or you) to call the Urfael daemon's control
// plane from ANY OS:  node _urfael/daemonctl.js GET /reminders
//                     node _urfael/daemonctl.js POST /remind {"text":"Call Stefan","inMins":20}
// On macOS/Linux this is equivalent to `curl --unix-socket ~/.claude/urfael/daemon.sock …`. On native
// Windows curl cannot reach a named pipe, so this helper IS the way: it derives the same per-user pipe
// name the daemon listens on and presents the daemon's token file (both live under your own profile —
// possessing them is what proves you are the owner). Standalone by design: node stdlib only.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const JDIR = process.env.URFAEL_STATE_DIR ? path.resolve(process.env.URFAEL_STATE_DIR) : path.join(os.homedir(), '.claude', 'urfael');
const isWin = process.platform === 'win32';
const SOCK = isWin
  ? '\\\\.\\pipe\\urfael-daemon-' + crypto.createHash('sha256').update(JDIR.toLowerCase()).digest('hex').slice(0, 12)
  : path.join(JDIR, 'daemon.sock');
function token() { try { return String(fs.readFileSync(path.join(JDIR, 'daemon.token'), 'utf8')).trim(); } catch { return ''; } }

const [method, p, body] = [String(process.argv[2] || 'GET').toUpperCase(), String(process.argv[3] || '/health'), process.argv[4]];
const headers = { 'Content-Type': 'application/json' };
if (isWin) { const t = token(); if (t) headers['x-urfael-token'] = t; }
const req = http.request({ socketPath: SOCK, method, path: p, headers, timeout: 30000 }, (res) => {
  let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { process.stdout.write(b + '\n'); process.exit(res.statusCode >= 400 ? 1 : 0); });
});
req.on('error', (e) => { process.stderr.write('daemon unreachable: ' + e.message + '\n'); process.exit(1); });
req.on('timeout', () => { req.destroy(); process.stderr.write('timeout\n'); process.exit(1); });
if (body) req.write(body);
req.end();
