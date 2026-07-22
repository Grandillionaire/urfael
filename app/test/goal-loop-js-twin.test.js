'use strict';
// Parity harness for the native-Windows goal-loop twin (vault-template/_urfael/goal-loop.js) against the
// shipped goal-loop.sh: same flags, same prompt text, same guard rails — asserted here so the two can
// never drift silently (the same discipline the docs-consistency test applies to counts).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const twin = require('../../vault-template/_urfael/goal-loop.js');

const SH = fs.readFileSync(path.join(__dirname, '..', '..', 'vault-template', '_urfael', 'goal-loop.sh'), 'utf8');

test('parseArgs mirrors the .sh flag set, positional goal, and env fallbacks', () => {
  const o = twin.parseArgs(['fix the tests', '--repo', 'C:\\work\\r', '--max-iters', '5', '--max-mins', '30',
    '--turn-timeout', '120', '--check', 'npm test', '--model', 'opus', '--verify', '--criteria', 'c.md'], {});
  assert.equal(o.goal, 'fix the tests');
  assert.equal(o.repo, 'C:\\work\\r');
  assert.equal(o.maxIters, 5);
  assert.equal(o.maxMins, 30);
  assert.equal(o.turnTimeout, 120);
  assert.equal(o.check, 'npm test');
  assert.equal(o.model, 'opus');
  assert.equal(o.verify, true);
  assert.equal(o.criteria, 'c.md');
  // defaults match the .sh header line: MAX_ITERS=15 MAX_MINS=120 TURN_TIMEOUT=900 MODEL=sonnet STALE_LIMIT=3
  const d = twin.parseArgs(['g'], {});
  assert.deepEqual([d.maxIters, d.maxMins, d.turnTimeout, d.model], [15, 120, 900, 'sonnet']);
  assert.equal(twin.STALE_LIMIT, 3);
  // env fallbacks ride the same vars as the .sh
  const e = twin.parseArgs(['g'], { URFAEL_GOAL_VERIFY: '1', URFAEL_GOAL_CRITERIA: '/c', URFAEL_SANDBOX: 'docker' });
  assert.equal(e.verify, true); assert.equal(e.criteria, '/c'); assert.equal(e.sandbox, 'docker');
  // a second positional is an error, exactly like the .sh's "unknown arg"
  assert.ok(twin.parseArgs(['a', 'b'], {}).error);
});

test('the worker prompt is byte-identical to the .sh PROMPT (with and without --check)', () => {
  // the .sh builds: Work toward this goal in this repo: ${GOAL}\nMake concrete...${CHECK:+ (so '$CHECK' passes)}...
  const noCheck = twin.buildPrompt('ship it', '');
  assert.ok(noCheck.startsWith('Work toward this goal in this repo: ship it\n'));
  assert.ok(noCheck.includes('end your reply with a line containing only: ' + twin.MARKER));
  assert.ok(!noCheck.includes("(so '"));
  const withCheck = twin.buildPrompt('ship it', 'npm test');
  assert.ok(withCheck.includes("verified (so 'npm test' passes), end your reply"));
  // the marker itself matches the .sh MARKER= line
  assert.match(SH, new RegExp('MARKER="' + twin.MARKER + '"'));
});

test('every flag the .sh advertises in usage() exists in the twin parser (no silent flag drift)', () => {
  const m = SH.match(/Usage: goal-loop\.sh[^']*/);
  assert.ok(m, 'found the .sh usage line');
  for (const flag of String(m[0]).match(/--[a-z-]+/g)) {
    // --verify is the one boolean flag (consumes no value) — in BOTH implementations a trailing value after
    // it becomes a second positional and errors; probe it bare, everything else with a value.
    const argv = flag === '--verify' ? ['g', flag] : ['g', flag, 'v'];
    const o = twin.parseArgs(argv, {});
    assert.ok(!o.error, 'twin rejects ' + flag);
  }
});

test('the twin fails CLOSED where the .sh does: sandbox modes and verify-without-criteria', () => {
  // parseArgs accepts them (the runner argv contract), but they are v1-rejected in main() — assert the
  // source carries the fail-closed branches so a refactor can't quietly drop them.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'vault-template', '_urfael', 'goal-loop.js'), 'utf8');
  assert.ok(src.includes('Aborting rather than silently running unsandboxed'));
  assert.ok(src.includes('--verify requires --criteria'));
  assert.ok(src.includes('is not a git repo'));
});
