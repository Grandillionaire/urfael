'use strict';
// Source-hygiene guard for daemon.js. The native `recall` tool was silently mis-wired for a while because a NEW
// module-scope `function recallText(q,k)` collided with a pre-existing `function recallText(e)`: two same-named
// function DECLARATIONS hoist so the later one wins, and every `recall: recallText` reference bound to the wrong
// function — returning garbage, invisible to the engine tests (which inject a fake recall). This freezes the class:
// daemon.js must never again declare two module-scope functions with the same name.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('daemon.js has no duplicate module-scope function declarations (the recallText-collision class)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  const seen = new Map();
  const dups = [];
  // module-scope declarations start at column 0: `function foo(` or `async function foo(`
  const re = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[1];
    const line = src.slice(0, m.index).split('\n').length;
    if (seen.has(name)) dups.push(`${name} (lines ${seen.get(name)} and ${line})`);
    else seen.set(name, line);
  }
  assert.deepStrictEqual(dups, [], 'duplicate module-scope function declarations shadow each other via hoisting: ' + dups.join('; '));
});

test('the native recall tool is wired to the BM25 archive search, not the vector-key helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
  // the native spec must reference the distinctly-named search function, and that function must query the recall index
  assert.match(src, /recall:\s*nativeRecallSearch\b/, 'the native engine spec must bind recall to nativeRecallSearch');
  const fn = src.match(/async function nativeRecallSearch\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fn, 'nativeRecallSearch must exist');
  assert.match(fn[0], /ridx\.(query|entriesFor)/, 'nativeRecallSearch must actually search the recall index (BM25), not extract vector keys');
});
