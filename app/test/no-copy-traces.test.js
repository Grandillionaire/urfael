'use strict';
// Guard: internal-only tooling, internal working notes, and origin-reveal provenance must never appear in the
// shipped public tree. Legitimate references stay allowed (the import/migration feature, the comparison pages,
// favorable positioning like "safer than Hermes" / "beats Hermes" / "OpenClaw-compatible"): these patterns target
// only the internal markers and the origin-reveal phrasing, not any ordinary mention of another product. This test
// scans the shipped source + docs with the internal-marker set, and additionally sweeps the whole tree INCLUDING
// test/ with a high-precision origin-reveal set (test/ used to hide a provenance leak because it was skipped).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const APP = path.join(__dirname, '..');
const REPO = path.join(APP, '..');
const SELF = path.basename(__filename);

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

// High-precision ORIGIN-REVEAL set: matches phrasing that reveals a feature's IDEA came from a rival, but NOT
// legitimate comparison/positioning. Fragment-built so this file's own source stays clean. These sweep the WHOLE
// tree, test/ included. Proximity is line-local ([^\n]{0,40}) so a cross-line comparison sentence never trips.
const ORIGIN_FORBIDDEN = [
  new RegExp('NousResearch' + '/hermes' + '-agent'),                                    // the rival repo slug
  new RegExp('borrow[a-z]*[^\\n]{0,40}(herm' + 'es|openc' + 'law|nous' + 'research)', 'i'),  // "borrowed from <rival>"
  new RegExp('idea (from|stud' + 'ied from)[^\\n]{0,40}(herm' + 'es|openc' + 'law|nous' + 'research)', 'i'),
  new RegExp('patt' + 'erns only[,.;)]', 'i'),                                          // the clean-room disclaimer
  new RegExp('(herm' + 'es|openc' + 'law)-style', 'i'),                                 // lineage phrasing
];

function walk(dir, acc, includeTest) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return acc; }
  for (const name of names) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    if (name === 'test' && !includeTest) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc, includeTest);
    else if (/\.(js|ts|tsx|mjs|md|html|sh|json)$/.test(name)) acc.push(p);
  }
  return acc;
}

function scan(files, patterns) {
  const hits = [];
  for (const f of files) {
    if (path.basename(f) === SELF) continue;                 // never scan this guard's own source
    let txt;
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const re of patterns) { if (re.test(txt)) hits.push(path.relative(REPO, f) + '  ~=  ' + String(re)); }
  }
  return hits;
}

test('no internal-only tooling or working-note markers leak into the public tree', () => {
  assert.ok(!fs.existsSync(path.join(APP, 'radar.js')), 'app/radar.js must not exist in the public repo');
  const files = walk(APP, [], false);                        // shipped app, test/ excluded
  walk(path.join(REPO, 'docs'), files, false);
  for (const f of fs.readdirSync(REPO)) { if (/\.md$/.test(f)) files.push(path.join(REPO, f)); }
  const hits = scan(files, FORBIDDEN);
  assert.deepEqual(hits, [], 'internal-only markers must not appear in shipped code:\n' + hits.join('\n'));
});

test('no origin-reveal provenance leaks anywhere in the tree (test/ included)', () => {
  const files = walk(APP, [], true);                         // shipped app + test/
  walk(path.join(REPO, 'docs'), files, true);
  for (const f of fs.readdirSync(REPO)) { if (/\.md$/.test(f)) files.push(path.join(REPO, f)); }
  const hits = scan(files, ORIGIN_FORBIDDEN);
  assert.deepEqual(hits, [], 'origin-reveal provenance must not appear (describe function, not origin):\n' + hits.join('\n'));
});
