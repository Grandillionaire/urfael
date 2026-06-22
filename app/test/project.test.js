'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const p = require('../project');

test('idFor prefers the git remote (so the same repo shares one memory across clones)', () => {
  assert.equal(p.idFor('/anywhere', 'git@github.com:Grandillionaire/urfael.git'), 'grandillionaire-urfael');
  assert.equal(p.idFor('/elsewhere', 'https://github.com/Grandillionaire/urfael'), 'grandillionaire-urfael');
});

test('idFor falls back to basename + a path hash (no collision on same basename)', () => {
  const a = p.idFor('/home/me/work/app', '');
  const b = p.idFor('/home/me/other/app', '');
  assert.match(a, /^app-[0-9a-f]{6}$/);
  assert.notEqual(a, b);                                  // same basename, different path → different id
  assert.equal(a, p.idFor('/home/me/work/app', ''));      // stable
});

test('memDir + templates', () => {
  assert.equal(p.memDir('/Urfael-memory', 'x-repo'), require('path').join('/Urfael-memory', 'projects', 'x-repo'));
  assert.match(p.conventionsTemplate('myrepo'), /# Conventions for myrepo/);
  const h = p.historyEntry('add retries', 'added a retry wrapper', 'k3-1a2b', '2026-06-22T10:30:00Z');
  assert.match(h, /2026-06-22 10:30/);
  assert.match(h, /urfael rewind k3-1a2b/);
  assert.match(h, /\*\*Task:\*\* add retries/);
  assert.match(h, /added a retry wrapper/);
});

test('contextBlock fences the conventions, caps length, and is empty on empty', () => {
  assert.equal(p.contextBlock(''), '');
  assert.equal(p.contextBlock('   '), '');
  const c = p.contextBlock('use tabs, never push to main');
  assert.match(c, /^\[PROJECT MEMORY/);
  assert.match(c, /use tabs, never push to main/);
  assert.match(c, /\[END PROJECT MEMORY\]$/);
  assert.ok(p.contextBlock('x'.repeat(9000)).length < 4200);
});
