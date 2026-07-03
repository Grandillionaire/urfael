'use strict';
// CLI-drift guard. docs/manual/reference/cli.md claims it "always matches the binary" because it is generated from
// app/registry.js by generate-cli.js. That promise silently rotted once already (the doc fell ~8 commands behind the
// registry: schedule, calendar, watch, usage, blueprint were all missing). This test freezes the promise: every
// command the registry ships must be documented, and the doc may not document a command the registry does not have,
// so a new command with no `node docs/manual/reference/generate-cli.js` run can never merge green.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const reg = require('../registry.js');
const cli = fs.readFileSync(path.join(ROOT, 'docs', 'manual', 'reference', 'cli.md'), 'utf8');

const visible = reg.COMMANDS.filter((c) => !c.hidden).map((c) => c.name);
const hidden = reg.COMMANDS.filter((c) => c.hidden).map((c) => c.name);

// the doc must be present and non-trivial, so this guard can never pass vacuously on a wrong cwd
test('cli.md exists and is generated from the registry', () => {
  assert.ok(cli.length > 1000, 'cli.md was not found or is too small (cwd/path problem?)');
  assert.ok(reg.COMMANDS.length > 0, 'registry must expose commands');
});

// every VISIBLE command has its own `### `urfael <name>`` heading. The trailing backtick disambiguates prefixes
// (e.g. `hook` never matches inside `hooks`), so a plain substring check is exact.
test('every visible registry command has a matching heading in cli.md', () => {
  for (const name of visible) {
    assert.ok(cli.includes('### `urfael ' + name + '`'), 'cli.md is missing the "### `urfael ' + name + '`" heading; run: node docs/manual/reference/generate-cli.js');
  }
});

// every HIDDEN command is still listed (the generator folds them into a "Hidden subcommands" table as `urfael <name>`)
test('every hidden registry command is still documented in cli.md', () => {
  for (const name of hidden) {
    assert.ok(cli.includes('`urfael ' + name + '`'), 'cli.md is missing hidden command "' + name + '"; run: node docs/manual/reference/generate-cli.js');
  }
});

// the reverse: cli.md may not carry a heading for a command the registry no longer has (a stale/renamed command)
test('cli.md documents no command the registry does not ship', () => {
  const documented = [...cli.matchAll(/^### `urfael ([^`]+)`/gm)].map((m) => m[1]);
  const known = new Set(reg.COMMANDS.map((c) => c.name));
  for (const name of documented) {
    assert.ok(known.has(name), 'cli.md documents "### `urfael ' + name + '`" but registry.js has no such command; run: node docs/manual/reference/generate-cli.js');
  }
  // and the heading set is exactly the visible set (no dupes, no gaps)
  assert.equal(new Set(documented).size, visible.length, 'cli.md has ' + new Set(documented).size + ' command headings but the registry has ' + visible.length + ' visible commands');
});
