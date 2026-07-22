'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { assertOwnerOnly } = require('./_owner-only');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// setup.js reads/writes ~/.claude/urfael/provider.env. Point it at a scratch HOME so the test never touches
// the real config (a stray key there would override the user's subscription).
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-setup-'));
const origHome = process.env.HOME;
process.env.HOME = scratch;
const setup = require('../setup');
process.env.HOME = origHome; // restore for everything else; setup captured PROVIDER_ENV at require-time

test('writeEnv -> readEnv round-trips, strips quotes, drops empties, and is 0600', () => {
  setup.writeEnv({ ANTHROPIC_API_KEY: 'sk-ant-xyz', URFAEL_OPUS_MODEL: 'qwen2.5:32b', NOTHING: '' });
  const back = setup.readEnv();
  assert.equal(back.ANTHROPIC_API_KEY, 'sk-ant-xyz');
  assert.equal(back.URFAEL_OPUS_MODEL, 'qwen2.5:32b');
  assert.ok(!('NOTHING' in back), 'empty values are not written');
  assertOwnerOnly(assert, setup.PROVIDER_ENV, 'provider.env must be owner-only');
});

test('readEnv tolerates quotes, export prefix, comments, and blank lines (fail-soft)', () => {
  fs.writeFileSync(setup.PROVIDER_ENV, '# comment\n\nexport ANTHROPIC_API_KEY="sk-ant-q"\nANTHROPIC_BASE_URL=\'http://127.0.0.1:3456\'\nbad line here\n');
  const back = setup.readEnv();
  assert.equal(back.ANTHROPIC_API_KEY, 'sk-ant-q');
  assert.equal(back.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3456');
  assert.ok(!('bad' in back));
});

test('readEnv on a missing file returns {} (never throws)', () => {
  try { fs.unlinkSync(setup.PROVIDER_ENV); } catch {}
  assert.deepEqual(setup.readEnv(), {});
});
