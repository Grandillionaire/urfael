'use strict';
// Doc-consistency guard. The stale-number drift (benchmark count, attack-class count, channel count, version cited
// differently across README / landing / PARITY / manual) bit a production-readiness audit. This test DERIVES the
// canonical values from the source of truth and fails the build if any user-facing doc cites a different number, so
// the drift can never silently recur.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; } };

// ── derive the truth from source ──
const bench = read('app/test/security-benchmark.js');
const CHECKS = (bench.match(/\bcheck\(/g) || []).length - 1;          // minus the one `function check(` definition
const CLASSES = (bench.match(/\battackClass\(/g) || []).length - 1;   // minus the one definition
const CHANNELS = require('../lib').TEAM_CHANNELS.length;
const VERSION = require('../package.json').version;

// the user-facing docs to police
function manualMd() {
  const out = []; const base = path.join(ROOT, 'docs', 'manual');
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.md')) out.push(path.relative(ROOT, p)); } };
  try { walk(base); } catch {}
  return out;
}
const DOCS = ['README.md', 'PARITY.md', 'docs/index.html', 'docs/SECURITY-BENCHMARK.md', ...manualMd()];

test('the benchmark + class counts are derivable and sane', () => {
  assert.ok(CHECKS > 0 && CLASSES > 0, 'derived counts must be positive (checks=' + CHECKS + ', classes=' + CLASSES + ')');
});

// ── the policed docs must actually be found + non-empty, so this guard can never PASS VACUOUSLY (e.g. wrong cwd in
//    CI). Without this, a missing file makes every regex match nothing and drift slips through silently. ──
test('the policed docs are present and non-empty (no vacuous pass)', () => {
  for (const rel of ['README.md', 'docs/index.html', 'docs/SECURITY-BENCHMARK.md', 'CHANGELOG.md']) {
    assert.ok(read(rel).length > 500, rel + ' was not found or is too small; the consistency guard cannot run against it (cwd/path problem?)');
  }
  assert.ok(CHANNELS > 0, 'TEAM_CHANNELS must be derivable');
});

// ── no doc may cite a benchmark CHECK count other than the real one ──
test('every "NN/NN checks" and "NN checks passed" in the docs equals the real benchmark count', () => {
  for (const rel of DOCS) {
    const txt = read(rel);
    for (const m of txt.matchAll(/(\d+)\s*\/\s*(\d+)\s+checks/gi)) {
      assert.equal(Number(m[1]), CHECKS, rel + ' cites ' + m[0] + ' but the benchmark has ' + CHECKS + ' checks');
      assert.equal(Number(m[2]), CHECKS, rel + ' cites ' + m[0] + ' but the benchmark has ' + CHECKS + ' checks');
    }
    for (const m of txt.matchAll(/(\d+)\s+checks passed/gi)) assert.equal(Number(m[1]), CHECKS, rel + ' cites "' + m[0] + '" but the benchmark has ' + CHECKS + ' checks');
  }
});

// ── no doc may cite an ATTACK-CLASS count other than the real one ──
test('every "N/N" or "N of N" attack-class count in the docs equals the real class count', () => {
  for (const rel of DOCS) {
    const txt = read(rel);
    for (const m of txt.matchAll(/(\d+)\s*\/\s*(\d+)\s+(?:real-world\s+)?attack classes/gi)) {
      assert.equal(Number(m[1]), CLASSES, rel + ' cites ' + m[0] + ' but there are ' + CLASSES + ' classes');
      assert.equal(Number(m[2]), CLASSES, rel + ' cites ' + m[0] + ' but there are ' + CLASSES + ' classes');
    }
    for (const m of txt.matchAll(/(\d+)\s+of\s+(\d+)\s+(?:real-world\s+)?attack classes/gi)) {
      assert.equal(Number(m[1]), CLASSES, rel + ' cites "' + m[0] + '" but there are ' + CLASSES + ' classes');
      assert.equal(Number(m[2]), CLASSES, rel + ' cites "' + m[0] + '" but there are ' + CLASSES + ' classes');
    }
  }
});

// ── no doc may cite a TOTAL channel count other than the real one. Sub-counts ("8 native webhook channels",
//    "11 native bridges") keep a qualifier word before "channels"/"bridges", so the `(\d+) channels` /
//    `(\d+) first-class` patterns only ever match a stated total. ──
test('every total-channel-count claim in the docs equals the real channel count', () => {
  const pats = [/(\d+)\s+channels\b/gi, /(\d+)\s+first-class\b/gi, /channel count is now (\d+)/gi];
  for (const rel of DOCS) {
    const txt = read(rel);
    for (const re of pats) for (const m of txt.matchAll(re)) {
      assert.equal(Number(m[1]), CHANNELS, rel + ' cites "' + m[0].trim() + '" but there are ' + CHANNELS + ' channels');
    }
  }
});

// ── the landing page builds its hero badges, proof tally, and cockpit animation from a JS literal (const URFAEL =
//    {classes, checks, ...}); the text scans above cannot see those numbers, so assert the literal itself is correct. ──
test('the landing page JS counts (const URFAEL) match the real benchmark', () => {
  const html = read('docs/index.html');
  const m = html.match(/const URFAEL\s*=\s*\{([^}]*)\}/);
  assert.ok(m, 'docs/index.html must define const URFAEL = { ... }');
  const cls = m[1].match(/classes:\s*(\d+)/), chk = m[1].match(/checks:\s*(\d+)/);
  assert.ok(cls && chk, 'const URFAEL must define classes: and checks:');
  assert.equal(Number(cls[1]), CLASSES, 'const URFAEL.classes is ' + cls[1] + ' but there are ' + CLASSES + ' attack classes');
  assert.equal(Number(chk[1]), CHECKS, 'const URFAEL.checks is ' + chk[1] + ' but the benchmark has ' + CHECKS + ' checks');
});

// ── the SECURITY-BENCHMARK scorecard must detail every attack class (no undercount vs the headline) ──
test('the security-benchmark scorecard lists every attack class', () => {
  const rows = (read('docs/SECURITY-BENCHMARK.md').match(/^\| \d+ \|/gm) || []).length;
  assert.equal(rows, CLASSES, 'the scorecard has ' + rows + ' numbered rows but the benchmark has ' + CLASSES + ' classes');
});

// ── the current version must be documented in the changelog ──
test('the package version has a CHANGELOG entry', () => {
  assert.match(read('CHANGELOG.md'), new RegExp('\\[' + VERSION.replace(/\./g, '\\.') + '\\]'), 'CHANGELOG.md must have an entry for v' + VERSION);
});
