'use strict';
// Guard: internal-only tooling and internal working notes must never appear in the shipped public tree. Legitimate
// references stay allowed (the import/migration feature, the comparison pages, favorable positioning): these
// patterns target only the internal markers, not any ordinary mention of another product. This test scans the
// shipped source + docs (never the test/ dir, so it does not match its own pattern list).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..');
const REPO = path.join(APP, '..');

const FORBIDDEN = [
  // Patterns are built from fragments so the trigger literals do not appear in this file's own source (a history
  // rewrite of those phrases therefore cannot weaken this guard). They compile to the same regexes at runtime.
  /require\((['"])\.\/radar\1\)/,                            // an internal module must not re-enter the shipped code
  new RegExp('URFAEL' + '_' + 'RADAR'),                      // an internal flag
  new RegExp('compet' + 'itor ' + 'radar', 'i'),
  new RegExp('mirror of (herm' + 'es|openc' + 'law)', 'i'),
  new RegExp('\\bborrow' + 'able\\b', 'i'),
  new RegExp('worth ' + 'borrow' + 'ing', 'i'),
  new RegExp('what did (herm' + 'es|openc' + 'law)', 'i'),
  new RegExp('scan ' + 'rivals', 'i'),
];

function walk(dir, acc) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return acc; }
  for (const name of names) {
    if (name === 'node_modules' || name === 'dist' || name === 'test' || name === '.git') continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(js|ts|tsx|mjs|md|html|sh|json)$/.test(name)) acc.push(p);
  }
  return acc;
}

test('no internal-only tooling or working-note markers leak into the public tree', () => {
  assert.ok(!fs.existsSync(path.join(APP, 'radar.js')), 'app/radar.js must not exist in the public repo');
  const files = walk(APP, []);
  walk(path.join(REPO, 'docs'), files);
  for (const f of fs.readdirSync(REPO)) { if (/\.md$/.test(f)) files.push(path.join(REPO, f)); }
  const hits = [];
  for (const f of files) {
    let txt;
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const re of FORBIDDEN) { if (re.test(txt)) hits.push(path.relative(REPO, f) + '  ~=  ' + String(re)); }
  }
  assert.deepEqual(hits, [], 'internal-only markers must not appear in shipped code:\n' + hits.join('\n'));
});
