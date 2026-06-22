'use strict';
// Drift guard: the command registry (app/registry.js — the single source of truth for help + did-you-mean)
// and the real dispatcher (cli.js) must never diverge. If someone adds a `cmd === 'x'` branch without a
// registry entry (or vice-versa), or ships a command with no example, this fails the build.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const reg = require('../registry');
const src = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf8');

const DEFAULT = new Set(['ask']);   // `ask` is the default fall-through — no `cmd === 'ask'` branch by design

test('every registry command has a live dispatch branch in cli.js', () => {
  for (const c of reg.COMMANDS) {
    if (DEFAULT.has(c.name)) continue;
    const re = new RegExp("cmd === '" + c.name.replace('-', '\\-') + "'");
    assert.ok(re.test(src), 'registry names `' + c.name + '` but cli.js has no dispatch branch for it');
  }
});

test('every dispatched command exists in the registry (no orphan handlers)', () => {
  const dispatched = [...src.matchAll(/cmd === '([a-z-]+)'/g)].map((m) => m[1]);
  const known = new Set([
    ...reg.COMMANDS.map((c) => c.name),
    ...Object.keys(reg.ALIASES),      // asof, init, onboard — real handler aliases
    'unremind',                        // own branch, intentionally not a registry entry
    'help', '--help', '-h',            // help variants
    '--version', '-v',                 // version flag variants (the `version` command is in the registry)
  ]);
  for (const d of dispatched) assert.ok(known.has(d), 'cli.js dispatches `' + d + '` but the registry never names it');
});

test('did-you-mean keyword set is fully derived from the registry (no hand-list to drift)', () => {
  // cli.js builds COMMANDS from reg.COMMANDS + reg.ALIASES + 'unremind'. Assert the derivation is present
  // and that the old hand-maintained array literal is gone.
  assert.ok(/\.\.\.reg\.COMMANDS\.map\(\(c\) => c\.name\)/.test(src), 'COMMANDS must be derived from reg.COMMANDS');
  assert.ok(!/const COMMANDS = \['logo', 'help'/.test(src), 'the old hand-list must be deleted');
});

test('byName resolves real aliases to their canonical command', () => {
  assert.equal(reg.byName('asof').name, 'as-of');
  assert.equal(reg.byName('init').name, 'setup');
  assert.equal(reg.byName('onboard').name, 'setup');
  assert.equal(reg.byName('nope'), null);
});

test('every command has an honest one-line summary and 1–3 real examples', () => {
  for (const c of reg.COMMANDS) {
    assert.ok(c.summary && !/\n/.test(c.summary), c.name + ' needs a single-line summary');
    assert.ok(c.summary.length <= 62, c.name + ' summary too long for the grouped view (' + c.summary.length + ')');
    assert.ok(Array.isArray(c.examples) && c.examples.length >= 1 && c.examples.length <= 3, c.name + ' needs 1–3 examples');
    for (const e of c.examples) assert.ok(/^urfael /.test(e), c.name + ' example must start with `urfael `: ' + e);
  }
});

test('the bare card shows only first-use starters, and renders without the comment-scrape', () => {
  const starters = reg.COMMANDS.filter((c) => c.starter).map((c) => c.name);
  assert.deepEqual(starters, ['ask', 'sessions', 'code', 'remind', 'skills', 'setup', 'status', 'doctor']);
  // the renderers are pure functions of the registry + an injected ui bag (no __filename scrape anywhere)
  assert.ok(!/readFileSync\(__filename/.test(src), 'cli.js must not scrape its own file for help text');
});

test('renderers produce plain text with identity helpers (pipe-safe shape)', () => {
  const id = (s) => s;
  const ui = { banner: () => 'BANNER', frame: (t, ls) => t + '\n' + ls.join('\n'), gold: id, dim: id, visLen: (s) => s.length };
  const bare = reg.renderBare(ui);
  assert.match(bare, /start here/);
  assert.match(bare, /urfael "<anything>"/);          // line one is the first move
  assert.match(bare, /more — the full reference/);     // honest overflow pointer
  const full = reg.renderFull(ui);
  for (const k of Object.keys(reg.GROUPS)) assert.ok(full.includes(k), 'full help missing group ' + k);
  const one = reg.renderOne('cron', ui);
  assert.match(one, /usage/);
  assert.match(one, /examples/);
});
