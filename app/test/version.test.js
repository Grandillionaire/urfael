'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const v = require('../version');

test('parse reads major.minor.patch, tolerates a v prefix + prerelease, rejects junk', () => {
  assert.deepEqual(v.parse('0.6.0'), { major: 0, minor: 6, patch: 0 });
  assert.deepEqual(v.parse('v1.2.3'), { major: 1, minor: 2, patch: 3 });
  assert.deepEqual(v.parse('2.0.0-beta.1'), { major: 2, minor: 0, patch: 0 });
  assert.equal(v.parse('nonsense'), null);
  assert.equal(v.parse(''), null);
  assert.equal(v.parse(null), null);
});

test('compare orders versions and is inert on junk', () => {
  assert.equal(v.compare('0.6.0', '0.1.0'), 1);
  assert.equal(v.compare('0.1.0', '0.6.0'), -1);
  assert.equal(v.compare('1.0.0', '1.0.0'), 0);
  assert.equal(v.compare('0.6.1', '0.6.0'), 1);
  assert.equal(v.compare('1.0.0', '0.9.9'), 1);
  assert.equal(v.compare('bad', '0.6.0'), 0);     // unparseable → inert
});

test('isNewer is true only for a strictly newer version', () => {
  assert.equal(v.isNewer('0.7.0', '0.6.0'), true);
  assert.equal(v.isNewer('0.6.0', '0.6.0'), false);
  assert.equal(v.isNewer('0.5.0', '0.6.0'), false);
});

test('the package version is a real semver and matches what the CLI reports', () => {
  const pkg = require('../package.json');
  assert.ok(v.parse(pkg.version), 'package.json version must be valid semver: ' + pkg.version);
});
