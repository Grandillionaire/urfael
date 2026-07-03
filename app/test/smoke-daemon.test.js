'use strict';
// COMPOSED-DAEMON SMOKE TEST — the one piece the unit suite could never reach.
//
// Everything that needs a real `claude` login (daemon.js's 46 routes, the warm Session turn loop, /ask) was
// only ever exercised by the LOCAL, manual e2e harness — so a live regression could (and once did: caretFor)
// ship green. This test closes that gap: it boots the REAL daemon over an isolated, 0600 unix socket with a
// deterministic OFFLINE `claude` stub (test/stub/claude) first on PATH and pinned via URFAEL_CLAUDE_BIN, then
// drives one real /ask turn end to end and hits a couple of read routes. NO network, NO real login, no port.
//
// Isolation: a throwaway $HOME (mkdtemp) so os.homedir() — and therefore the socket path, JDIR, vault and
// memory dir — all resolve under a temp tree that is torn down in `after`. Nothing touches the owner's real
// ~/.claude/urfael or a running daemon.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP = path.join(__dirname, '..');
const STUB = path.join(__dirname, 'stub', 'claude');

let HOME, SOCK, daemon;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// unix-socket JSON GET/POST against the daemon
function sock(method, p, body) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: SOCK, method, path: p, headers: { 'Content-Type': 'application/json' }, timeout: 20000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, raw: b, json: (() => { try { return JSON.parse(b); } catch { return null; } })() }));
    });
    req.on('error', () => resolve({ status: 0, raw: '', json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, raw: '', json: null }); });
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}
// NDJSON streaming /ask — collect every emitted event
function ask(text) {
  return new Promise((resolve) => {
    const events = [];
    const req = http.request({ socketPath: SOCK, method: 'POST', path: '/ask', headers: { 'Content-Type': 'application/json' }, timeout: 30000 }, (res) => {
      let buf = '';
      res.on('data', (d) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (ln) try { events.push(JSON.parse(ln)); } catch {} } });
      res.on('end', () => resolve(events));
    });
    req.on('error', () => resolve(events));
    req.on('timeout', () => { req.destroy(); resolve(events); });
    req.end(JSON.stringify({ text }));
  });
}

async function startDaemon() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;                    // never let electron-as-node reach the spawned node daemon
  env.HOME = HOME;                                    // os.homedir() honours $HOME on POSIX → isolates SOCK/JDIR/vault/memory
  env.URFAEL_VAULT_DIR = 'vault';                     // relative to the temp $HOME
  env.URFAEL_MEMORY_DIR = 'memory';
  env.URFAEL_CLAUDE_BIN = STUB;                       // the deterministic offline brain (absolute path wins over PATH lookup)
  env.PATH = path.join(__dirname, 'stub') + path.delimiter + (env.PATH || '');   // stub also FIRST on PATH, per spec
  env.URFAEL_UPDATE_CHECK = '0';                      // no network self-update probe during the test
  delete env.URFAEL_HEARTBEAT_MINS; delete env.URFAEL_YOLO;
  daemon = spawn(process.execPath, [path.join(APP, 'daemon.js')], { env, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { await sleep(250); const h = await sock('GET', '/health'); if (h.json && h.json.ok) return true; }
  return false;
}

describe('composed daemon smoke (offline claude stub)', () => {
  before(async () => {
    HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-smoke-'));
    SOCK = path.join(HOME, '.claude', 'urfael', 'daemon.sock');
    fs.mkdirSync(path.join(HOME, '.claude', 'urfael'), { recursive: true });
    fs.mkdirSync(path.join(HOME, 'vault'), { recursive: true });
    fs.mkdirSync(path.join(HOME, 'memory', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(HOME, 'vault', 'CLAUDE.md'), 'You are Urfael, a terse test assistant.\n');
    try { require('child_process').execFileSync('git', ['-C', path.join(HOME, 'memory'), 'init', '-q'], { stdio: 'ignore' }); } catch {}
    assert.ok(fs.existsSync(STUB) && (fs.statSync(STUB).mode & 0o111), 'the offline claude stub must be present and executable');
    const up = await startDaemon();
    assert.ok(up, 'the real daemon must boot and answer /health over the temp 0600 socket');
  }, { timeout: 30000 });

  after(async () => {
    try { await sock('POST', '/shutdown'); } catch {}
    await sleep(300);
    try { daemon && daemon.kill('SIGKILL'); } catch {}
    try { HOME && fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  });

  it('the daemon listens on a unix socket (no inbound port) with 0600 perms', () => {
    const st = fs.statSync(SOCK);
    assert.equal(st.mode & 0o777, 0o600, 'the daemon socket must be 0600 (owner-only)');
  });

  it('the daemon hardens its umask so JDIR + its logs are owner-only, not just the socket', () => {
    // Defense in depth: the daemon calls process.umask(0o077) at the top of boot and chmods JDIR to 0700, so the
    // state dir and the rotating logs it writes are owner-only on a multi-user box — not world/group-readable.
    const JDIR = path.join(HOME, '.claude', 'urfael');
    const jst = fs.statSync(JDIR);
    assert.equal(jst.mode & 0o077, 0, 'JDIR (~/.claude/urfael) must be owner-only (no group/other bits)');
    assert.equal(jst.mode & 0o777, 0o700, 'JDIR must be exactly 0700 even though the test pre-created it world-readable');
    // a real daemon-created state file: urfael.log is written by the daemon_start logEvent in the listen callback.
    const LOG = path.join(JDIR, 'urfael.log');
    assert.ok(fs.existsSync(LOG), 'the daemon must have written its urfael.log on boot');
    assert.equal(fs.statSync(LOG).mode & 0o077, 0, 'a daemon-created log file must be owner-only (umask 0077 in effect)');
  });

  it('GET /health reports ok + a unix bind (never a tcp port)', async () => {
    const h = await sock('GET', '/health');
    assert.equal(h.status, 200);
    assert.equal(h.json && h.json.ok, true);
    assert.ok(h.json.bound && h.json.bound.unix && !h.json.bound.tcpPort, 'health must self-report a unix bind, proving no inbound port');
  });

  it('POST /ask completes a real turn: streams thinking deltas then a done event with the brain text', async () => {
    const ev = await ask('Reply with exactly: URFAEL_SMOKE_OK');
    const streamed = ev.some((e) => e.kind === 'thinking' && typeof e.delta === 'string' && e.delta.length > 0);
    const done = ev.find((e) => e.kind === 'done');
    assert.ok(streamed, 'the Session parser must surface the stub text_delta events as streaming thinking deltas');
    assert.ok(done, 'a done event must terminate the /ask stream');
    assert.ok(typeof done.text === 'string' && done.text.includes('URFAEL_SMOKE_OK'), 'the done event must carry the brain reply (' + JSON.stringify(done && done.text) + ')');
    assert.notEqual(done.aborted, true, 'the turn must complete, not abort');
    assert.ok(done.usage && typeof done.usage.output_tokens === 'number', 'the result usage object must reach the done event');
  });

  it('GET /providers returns the curated registry as safe metadata', async () => {
    const r = await sock('GET', '/providers');
    assert.equal(r.status, 200);
    assert.ok(r.json && Array.isArray(r.json.providers), '/providers must return a providers array');
  });

  it('GET /usage returns the today / 7d / 30d rollup windows', async () => {
    const u = await sock('GET', '/usage');
    assert.equal(u.status, 200);
    assert.ok(u.json && u.json.today && u.json.last7d && u.json.last30d, '/usage must return today/last7d/last30d windows');
  });
});
