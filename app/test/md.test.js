'use strict';
// Tests for the terminal Markdown → ANSI renderer (so streamed answers read like Claude Code's terminal,
// not raw ## and ** ). Assertions strip ANSI and check the visible text + that raw markers are gone.
const { test } = require('node:test');
const assert = require('node:assert');
const md = require('../md');
const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');

test('plain mode (color:false) strips every marker, leaving clean text', () => {
  const out = md.toAnsi('## Title\nA **bold** and `code` and *em* and [link](http://x)', { color: false });
  assert.equal(out, 'Title\nA bold and code and em and link');
});

test('color mode drops the raw markers but keeps the words (no ## / ** / ` on screen)', () => {
  const v = strip(md.toAnsi('## Deploy\nrun the **build** then `verify`', { color: true, base: '\x1b[33m' }));
  assert.equal(v, 'Deploy\nrun the build then verify');
  assert.ok(!v.includes('#') && !v.includes('*') && !v.includes('`'));
});

test('headings/bold are actually styled (bold SGR present in colour mode)', () => {
  const raw = md.toAnsi('# H\n**b**', { color: true });
  assert.ok(/\x1b\[1m/.test(raw), 'a bold open code is emitted');
});

test('bullets become •, ordered lists keep their number, blockquotes get a bar', () => {
  assert.equal(strip(md.toAnsi('- one\n- two', { color: false })), '• one\n• two');
  assert.equal(strip(md.toAnsi('1. first\n2. second', { color: false })), '1. first\n2. second');
  assert.equal(strip(md.toAnsi('> quoted', { color: false })), '| quoted');
});

test('fenced code blocks: the ``` markers are dropped, the body is kept verbatim', () => {
  const out = strip(md.toAnsi('text\n```\nnpm run build\n```\nmore', { color: false }));
  assert.equal(out, 'text\nnpm run build\nmore');
});

test('streaming-tolerant: an UNCLOSED ** stays literal (resolves once the partner streams in)', () => {
  assert.equal(strip(md.toAnsi('a **bold start', { color: false })), 'a **bold start');
  assert.equal(strip(md.toAnsi('a **bold start', { color: true, base: '' })), 'a **bold start');
  // and once it closes, it renders
  assert.equal(strip(md.toAnsi('a **bold start** end', { color: false })), 'a bold start end');
});

test('the base colour is applied as a line prefix (gold answer stays gold)', () => {
  const out = md.toAnsi('hello', { color: true, base: '\x1b[33m' });
  assert.ok(out.startsWith('\x1b[33m'), 'line is prefixed with the base colour');
});

test('never throws on odd input', () => {
  assert.doesNotThrow(() => md.toAnsi('', {}));
  assert.doesNotThrow(() => md.toAnsi('***\n####\n```\nunterminated', { color: true }));
  assert.doesNotThrow(() => md.toAnsi(null, { color: true }));
});
