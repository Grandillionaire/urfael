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
const ipc = require('../ipc');
const WIN = process.platform === 'win32';
// on win32 the shebang stub can't be exec'd directly — claude.js is the same stub behind the resolver's .js branch
const STUB = path.join(__dirname, 'stub', WIN ? 'claude.js' : 'claude');

let HOME, SOCK, TENV, daemon;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// control-plane JSON GET/POST against the daemon (unix socket on POSIX; named pipe + token on win32)
function hdrs() { return { 'Content-Type': 'application/json', ...(WIN ? ipc.authHeaders(TENV, 'win32', fs) : {}) }; }
function sock(method, p, body) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: SOCK, method, path: p, headers: hdrs(), timeout: 20000 }, (res) => {
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
    const req = http.request({ socketPath: SOCK, method: 'POST', path: '/ask', headers: hdrs(), timeout: 30000 }, (res) => {
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
  if (WIN) env.USERPROFILE = HOME;                    // …and USERPROFILE on win32 (os.homedir() reads it there)
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
    TENV = { HOME, USERPROFILE: HOME };
    SOCK = ipc.daemonSock(TENV);                      // same derivation the daemon runs on its own env (pipe on win32)
    fs.mkdirSync(path.join(HOME, '.claude', 'urfael'), { recursive: true });
    fs.mkdirSync(path.join(HOME, 'vault'), { recursive: true });
    fs.mkdirSync(path.join(HOME, 'memory', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(HOME, 'vault', 'CLAUDE.md'), 'You are Urfael, a terse test assistant.\n');
    try { require('child_process').execFileSync('git', ['-C', path.join(HOME, 'memory'), 'init', '-q'], { stdio: 'ignore' }); } catch {}
    assert.ok(fs.existsSync(STUB), 'the offline claude stub must be present');
    if (!WIN) assert.ok(fs.statSync(STUB).mode & 0o111, 'the stub must be executable (mode bits are a POSIX concept)');
    const up = await startDaemon();
    assert.ok(up, 'the real daemon must boot and answer /health over the temp 0600 socket');
  }, { timeout: 30000 });

  after(async () => {
    try { await sock('POST', '/shutdown'); } catch {}
    await sleep(300);
    try { daemon && daemon.kill('SIGKILL'); } catch {}
    try { HOME && fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
  });

  it('the daemon guards its control plane: 0600 unix socket (POSIX) / token-gated named pipe (win32)', async () => {
    if (!WIN) {
      const st = fs.statSync(SOCK);
      assert.equal(st.mode & 0o777, 0o600, 'the daemon socket must be 0600 (owner-only)');
      return;
    }
    // win32: the boundary is the per-user token — it must exist, a tokenless request must be REFUSED with 401,
    // and the token file must live inside the isolated profile (never the runner's real one).
    const tok = ipc.loadToken(fs, TENV);
    assert.match(tok, /^[0-9a-f]{64}$/, 'the daemon must have minted its token on boot');
    assert.ok(ipc.tokenPath(TENV).startsWith(HOME), 'the token lives in the isolated profile');
    const bare = await new Promise((resolve) => {
      const req = http.request({ socketPath: SOCK, method: 'GET', path: '/health', timeout: 10000 }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => resolve(0)); req.on('timeout', () => { req.destroy(); resolve(0); }); req.end();
    });
    assert.equal(bare, 401, 'a request WITHOUT the token must be refused');
  });

  it('the daemon hardens its umask so JDIR + its logs are owner-only, not just the socket', () => {
    if (WIN) {
      // mode bits are a POSIX concept; the win32 equivalent (profile ACLs + the token gate) is asserted above.
      // Here, assert the same OBSERVABLE effect this test wants: the daemon created its state dir + wrote its log.
      const JDIR = path.join(HOME, '.claude', 'urfael');
      assert.ok(fs.existsSync(path.join(JDIR, 'urfael.log')), 'the daemon must have written its urfael.log on boot');
      return;
    }
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

  it('the native DEFAULT-BRAIN pin: unpinned by default, local-only, and a set→get→clear roundtrip persists', async () => {
    // default state: no native default pinned (the byte-identical subscription default)
    const g0 = await sock('GET', '/engine/default');
    assert.equal(g0.status, 200);
    assert.equal(g0.json && g0.json.nativeDefault, null, 'no native default brain is pinned out of the box');
    // LOCAL-only: a present channel is refused (a remote channel can never flip the owner's brain)
    const remote = await sock('POST', '/engine/default', { providerId: 'ollama', channel: 'telegram' });
    assert.equal(remote.status, 403, 'a remote channel must be refused (native default is local-only)');
    // the flat-rate subscription can never be a native default (it has no native engine)
    const sub = await sock('POST', '/engine/default', { providerId: 'claude' });
    assert.equal(sub.status, 400, 'the subscription provider cannot be pinned as a native default brain');
    // set a real native provider (ollama: a local-token provider, so hasKey is true without a stored secret), then
    // confirm it PERSISTS via a fresh GET, then CLEAR it — leaving the daemon back on the byte-identical default.
    const set = await sock('POST', '/engine/default', { providerId: 'ollama' });
    assert.equal(set.status, 200);
    assert.equal(set.json && set.json.nativeDefault, 'ollama');
    const g1 = await sock('GET', '/engine/default');
    assert.equal(g1.json && g1.json.nativeDefault, 'ollama', 'the pin persists across requests');
    const cleared = await sock('POST', '/engine/default', { action: 'clear' });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.json && cleared.json.nativeDefault, null);
    const g2 = await sock('GET', '/engine/default');
    assert.equal(g2.json && g2.json.nativeDefault, null, 'clearing removes the pin');
  });

  it('with NO native default pinned, a normal /ask still runs the CLI stub end-to-end (default path unchanged)', async () => {
    // proves the unpinned hot path is untouched: the guard is skipped and the turn resolves on the offline CLI stub.
    const ev = await ask('Reply with exactly: URFAEL_SMOKE_OK');
    const done = ev.find((e) => e.kind === 'done');
    assert.ok(done && typeof done.text === 'string' && done.text.includes('URFAEL_SMOKE_OK'), 'the unpinned turn must still complete on the CLI subscription engine');
    assert.notEqual(done.aborted, true);
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
