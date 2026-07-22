'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ipc = require('../ipc');

const ENV = { HOME: '/home/alice', USERPROFILE: 'C:\\Users\\alice' };

test('sockPath: POSIX gets a filesystem socket, win32 gets a per-user named pipe', () => {
  assert.equal(ipc.daemonSock({ HOME: '/home/alice' }, 'linux'), path.join('/home/alice', '.claude', 'urfael', 'daemon.sock'));
  const pipe = ipc.daemonSock(ENV, 'win32');
  assert.ok(pipe.startsWith('\\\\.\\pipe\\urfael-daemon-'), pipe);
  assert.match(pipe, /^\\\\\.\\pipe\\urfael-daemon-[0-9a-f]{12}$/);
  // stable for the same user, distinct for another user (two users on one machine never collide)
  assert.equal(pipe, ipc.daemonSock(ENV, 'win32'));
  assert.notEqual(pipe, ipc.daemonSock({ HOME: '/home/bob' }, 'win32'));
  // co-resident servers get distinct endpoints on both OSes
  assert.notEqual(ipc.sockPath('broker', ENV, 'win32'), pipe);
  assert.notEqual(ipc.sockPath('broker', { HOME: '/h' }, 'linux'), ipc.sockPath('daemon', { HOME: '/h' }, 'linux'));
});

test('URFAEL_STATE_DIR isolates the endpoint AND the token on every OS (cert daemon never touches the real one)', () => {
  const iso = { HOME: '/home/alice', URFAEL_STATE_DIR: '/tmp/cert-a' };
  assert.equal(ipc.daemonSock(iso, 'linux'), path.join(path.resolve('/tmp/cert-a'), 'daemon.sock'));
  assert.notEqual(ipc.daemonSock(iso, 'win32'), ipc.daemonSock({ HOME: '/home/alice' }, 'win32'));
  assert.equal(ipc.tokenPath(iso), path.join(path.resolve('/tmp/cert-a'), 'daemon.token'));
});

test('needsAuth: only native win32 requires the app-level token', () => {
  assert.equal(ipc.needsAuth('win32'), true);
  assert.equal(ipc.needsAuth('darwin'), false);
  assert.equal(ipc.needsAuth('linux'), false);
});

test('ensureToken: exclusive-create race is benign — one winner, everyone reads the same bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-ipc-'));
  const env = { HOME: dir, USERPROFILE: dir };
  const a = ipc.ensureToken(fs, env);
  const b = ipc.ensureToken(fs, env);           // second caller loses the wx race and READS
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.equal(ipc.loadToken(fs, env), a);
  if (process.platform !== 'win32') {
    const mode = fs.statSync(ipc.tokenPath(env)).mode & 0o777;
    assert.equal(mode, 0o600);                  // POSIX hosts still tighten the file even though they don't use it
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('authHeaders: empty on POSIX, token header on win32', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-ipc-'));
  const env = { HOME: dir, USERPROFILE: dir };
  assert.deepEqual(ipc.authHeaders(env, 'darwin', fs), {});
  const h = ipc.authHeaders(env, 'win32', fs);
  assert.match(h['x-urfael-token'], /^[0-9a-f]{64}$/);
  // the header matches what a daemon booting later would load
  assert.equal(h['x-urfael-token'], ipc.loadToken(fs, env));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('checkAuth: constant-time equality that fails CLOSED on an empty expected token', () => {
  assert.equal(ipc.checkAuth('abc', 'abc'), true);
  assert.equal(ipc.checkAuth('abd', 'abc'), false);
  assert.equal(ipc.checkAuth('ab', 'abc'), false);            // length mismatch never throws
  assert.equal(ipc.checkAuth('', ''), false);                 // a daemon with no token refuses everyone
  assert.equal(ipc.checkAuth('anything', ''), false);
  assert.equal(ipc.checkAuth(undefined, 'abc'), false);
});

test('hardenWin32: builds the icacls argv for the current user and swallows failure', () => {
  const calls = [];
  const ok = ipc.hardenWin32('C:\\t\\daemon.token', { USERNAME: 'alice' }, (cmd, args) => { calls.push([cmd, args]); });
  assert.equal(ok, true);
  assert.deepEqual(calls[0][0], 'icacls');
  assert.deepEqual(calls[0][1], ['C:\\t\\daemon.token', '/inheritance:r', '/grant:r', 'alice:F']);
  // a throwing icacls (or no USERNAME) is non-fatal
  assert.equal(ipc.hardenWin32('f', { USERNAME: 'alice' }, () => { throw new Error('no icacls'); }), false);
  assert.equal(ipc.hardenWin32('f', {}, () => {}), false);
});
