'use strict';
// resolvePromptText is the pure core behind `urfael`'s prompt input: a question can come from argv, a file
// (`--file <path>`, alias `--message-file`), or stdin (a lone `-` or a pipe). All IO is injected, so these tests
// touch no fs, no socket, no daemon: the readers are spies that prove WHICH source was used and that the others
// were never read. The contract is fail-closed (it throws rather than send an empty / truncated prompt).
const { test } = require('node:test');
const assert = require('node:assert');
const { resolvePromptText } = require('../lib');

const never = (label) => async () => { throw new Error('reader was called but must not be: ' + label); };

test('argv text is joined and wins (file/stdin readers are never touched)', async () => {
  assert.equal(await resolvePromptText({ argv: ['hello', 'world'], readFile: never('file'), readStdin: never('stdin'), stdinIsTTY: true }), 'hello world');
});

test('--file reads the path', async () => {
  let seen = null;
  const text = await resolvePromptText({ argv: ['--file', '/p.md'], readFile: async (p) => { seen = p; return 'file body'; }, stdinIsTTY: true });
  assert.equal(seen, '/p.md');
  assert.equal(text, 'file body');
});

test('--message-file is an accepted alias for --file', async () => {
  const text = await resolvePromptText({ argv: ['--message-file', '/p.md'], readFile: async (p) => (assert.equal(p, '/p.md'), 'file body'), stdinIsTTY: true });
  assert.equal(text, 'file body');
});

test('a lone `-` reads stdin and beats a TTY', async () => {
  assert.equal(await resolvePromptText({ argv: ['-'], readStdin: async () => 'piped body', readFile: never('file'), stdinIsTTY: true }), 'piped body');
});

test('a non-TTY pipe with no args reads stdin', async () => {
  assert.equal(await resolvePromptText({ argv: [], readStdin: async () => 'piped body', readFile: never('file'), stdinIsTTY: false }), 'piped body');
});

test('an over-cap prompt is rejected LOUD (not truncated)', async () => {
  await assert.rejects(
    () => resolvePromptText({ argv: ['--file', '/p'], readFile: async () => 'x'.repeat(300000), maxBytes: 200000 }),
    /too large/);
});

test('a missing / unreadable file is a fail-closed throw', async () => {
  await assert.rejects(
    () => resolvePromptText({ argv: ['--file', '/nope'], readFile: async () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } }),
    /cannot read prompt file/);
});

test('precedence argv > file > stdin (neither reader is called when argv has text)', async () => {
  let fileCalled = false, stdinCalled = false;
  const text = await resolvePromptText({
    argv: ['hi', '--file', '/p.md'],
    readFile: async () => { fileCalled = true; return 'FILE'; },
    readStdin: async () => { stdinCalled = true; return 'STDIN'; },
    stdinIsTTY: false,
  });
  assert.equal(text, 'hi');
  assert.equal(fileCalled, false, 'readFile must not be called when argv has a prompt');
  assert.equal(stdinCalled, false, 'readStdin must not be called when argv has a prompt');
});

test('no source on an interactive TTY fails closed (never blocks on stdin)', async () => {
  await assert.rejects(() => resolvePromptText({ argv: [], readFile: never('file'), readStdin: never('stdin'), stdinIsTTY: true }), /no prompt/);
});

test('an empty / whitespace-only file is rejected', async () => {
  await assert.rejects(() => resolvePromptText({ argv: ['--file', '/p'], readFile: async () => '   \n' }), /empty prompt/);
});

test('a missing path after --file is a usage error', async () => {
  await assert.rejects(() => resolvePromptText({ argv: ['--file'], readFile: never('file'), stdinIsTTY: true }), /missing path after --file/);
});

test('a leading BOM is stripped and multiline / JSON body is preserved exactly', async () => {
  const body = '﻿first\n```json\n{"ok":true}\n```\nsecond';
  const text = await resolvePromptText({ argv: ['--file', '/p'], readFile: async () => body });
  assert.equal(text, 'first\n```json\n{"ok":true}\n```\nsecond');
  assert.ok(!text.includes('﻿'), 'BOM must be gone');
  assert.equal((text.match(/\n/g) || []).length, 4, 'every newline is preserved');
});
