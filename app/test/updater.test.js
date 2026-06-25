'use strict';
// Unit tests for updater.js — the self-update pillar. The security-critical assertion is that runGitUpdate
// REFUSES anything but a fast-forward of the official remote. Runs in isolation (temp git repos, no network).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const up = require('../updater.js');

// ---------- isOfficialRemote: only the one official repo, any URL form ----------
test('isOfficialRemote accepts the official repo in https/ssh/.git forms, rejects everything else', () => {
  for (const ok of [
    'https://github.com/Grandillionaire/urfael',
    'https://github.com/Grandillionaire/urfael.git',
    'git@github.com:Grandillionaire/urfael.git',
    'HTTPS://GitHub.com/grandillionaire/URFAEL',
  ]) assert.strictEqual(up.isOfficialRemote(ok), true, 'should accept: ' + ok);
  for (const bad of [
    'https://github.com/attacker/urfael',
    'https://github.com/Grandillionaire/urfael-evil',
    'https://evil.com/Grandillionaire/urfael',
    'https://github.com.evil.com/Grandillionaire/urfael',
    'https://gitlab.com/Grandillionaire/urfael',
    '', null, undefined, 'urfael',
  ]) assert.strictEqual(up.isOfficialRemote(bad), false, 'should reject: ' + bad);
});

// ---------- compareVersions ----------
test('compareVersions orders semver, tolerates v-prefix + missing parts', () => {
  assert.strictEqual(up.compareVersions('0.8.7', '0.8.8'), -1);
  assert.strictEqual(up.compareVersions('v0.8.8', '0.8.7'), 1);
  assert.strictEqual(up.compareVersions('0.8.7', 'v0.8.7'), 0);
  assert.strictEqual(up.compareVersions('1.2', '1.2.0'), 0);
  assert.strictEqual(up.compareVersions('0.9.0', '0.10.0'), -1); // numeric, not lexical
});

// ---------- parseLatestTag ----------
test('parseLatestTag extracts tag_name, fails soft to ""', () => {
  assert.strictEqual(up.parseLatestTag('{"tag_name":"v0.8.9"}'), 'v0.8.9');
  assert.strictEqual(up.parseLatestTag({ tag_name: 'v1.0.0' }), 'v1.0.0');
  assert.strictEqual(up.parseLatestTag('not json'), '');
  assert.strictEqual(up.parseLatestTag('{}'), '');
});

// ---------- summarize ----------
test('summarize produces a notification only when available', () => {
  assert.strictEqual(up.summarize(null), '');
  assert.strictEqual(up.summarize({ available: false }), '');
  assert.match(up.summarize({ kind: 'git', available: true, behind: 3, branch: 'main' }), /3 commits on main/);
  assert.match(up.summarize({ kind: 'app', available: true, latest: 'v0.9.0', current: '0.8.7' }), /v0\.9\.0 is available/);
});

// ---------- runGitUpdate: the SECURITY gate (real temp git repos) ----------
function tmpRepo(originUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urf-upd-'));
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t.t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'f'), 'x');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'init']);
  if (originUrl) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', originUrl]);
  return dir;
}

test('runGitUpdate REFUSES a non-official origin (cannot self-update from an attacker repo)', async () => {
  const dir = tmpRepo('https://github.com/attacker/urfael.git');
  const r = await up.runGitUpdate(dir);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not the official/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runGitUpdate REFUSES an app install (no git checkout)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urf-app-'));
  const r = await up.runGitUpdate(dir);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /app install|no git/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('runGitUpdate REFUSES a dirty tree even on the official origin', async () => {
  const dir = tmpRepo('git@github.com:Grandillionaire/urfael.git');
  fs.writeFileSync(path.join(dir, 'dirty'), 'y');   // uncommitted change
  const r = await up.runGitUpdate(dir);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /local changes/i);
  fs.rmSync(dir, { recursive: true, force: true });
});
