'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path').win32;   // expectations mirror the module's explicit win32 semantics
const cb = require('../claude-bin');

// fake fs: only the given paths exist
function fakeFs(paths) { const s = new Set(paths); return { accessSync(p) { if (!s.has(p)) throw new Error('ENOENT'); } }; }
const NODE = 'C:\\nodejs\\node.exe';
const HOME = 'C:\\Users\\alice';
const ENV = { USERPROFILE: HOME, APPDATA: path.join(HOME, 'AppData', 'Roaming') };

test('POSIX resolution is byte-identical to the shipped probe (pre always empty)', () => {
  const hit = cb.resolve({}, 'darwin', fakeFs(['/opt/homebrew/bin/claude']), '/usr/bin/node');
  assert.deepEqual(hit, { bin: '/opt/homebrew/bin/claude', pre: [] });
  const env = cb.resolve({ URFAEL_CLAUDE_BIN: '/x/claude' }, 'linux', fakeFs([]), '/usr/bin/node');
  assert.deepEqual(env, { bin: '/x/claude', pre: [] });                 // override wins verbatim, no unwrapping on POSIX
  assert.deepEqual(cb.resolve({}, 'linux', fakeFs([]), '/usr/bin/node'), { bin: 'claude', pre: [] });
});

test('win32: the native installer exe is preferred and spawned directly', () => {
  const exe = path.join(HOME, '.local', 'bin', 'claude.exe');
  assert.deepEqual(cb.resolve(ENV, 'win32', fakeFs([exe]), NODE), { bin: exe, pre: [] });
});

test('win32: the npm global tree is entered via cli.js under OUR node — never the .cmd shim, never a shell', () => {
  const cli = path.join(ENV.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  assert.deepEqual(cb.resolve(ENV, 'win32', fakeFs([cli]), NODE), { bin: NODE, pre: [cli] });
});

test('win32: a PATH claude.cmd shim is unwrapped to its sibling cli.js; a PATH claude.exe is used as-is', () => {
  const dir = 'C:\\tools';
  const cli = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  const env = { ...ENV, PATH: 'C:\\other' + path.delimiter + dir };
  assert.deepEqual(cb.resolve(env, 'win32', fakeFs([path.join(dir, 'claude.cmd'), cli]), NODE), { bin: NODE, pre: [cli] });
  assert.deepEqual(cb.resolve(env, 'win32', fakeFs([path.join(dir, 'claude.exe')]), NODE), { bin: path.join(dir, 'claude.exe'), pre: [] });
});

test('win32: URFAEL_CLAUDE_BIN override handles .js, .cmd (unwrapped), and .exe forms', () => {
  assert.deepEqual(cb.resolve({ ...ENV, URFAEL_CLAUDE_BIN: 'C:\\x\\cli.js' }, 'win32', fakeFs([]), NODE), { bin: NODE, pre: ['C:\\x\\cli.js'] });
  const cli = path.join('C:\\npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  assert.deepEqual(cb.resolve({ ...ENV, URFAEL_CLAUDE_BIN: 'C:\\npm\\claude.cmd' }, 'win32', fakeFs([cli]), NODE), { bin: NODE, pre: [cli] });
  assert.deepEqual(cb.resolve({ ...ENV, URFAEL_CLAUDE_BIN: 'C:\\bin\\claude.exe' }, 'win32', fakeFs([]), NODE), { bin: 'C:\\bin\\claude.exe', pre: [] });
});

test('win32: nothing found falls back to the bare name so the existing "is claude installed?" path fires', () => {
  assert.deepEqual(cb.resolve(ENV, 'win32', fakeFs([]), NODE), { bin: 'claude', pre: [] });
});
