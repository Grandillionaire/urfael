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

// ── the unit-test count is cited in several places (README, the site, the cockpit const). The real count can't be
//    derived statically (some tests run in a loop), so the cockpit const URFAEL.unitTests is the single source of
//    truth and every other "(N) unit tests" / "frozen by (N) tests" claim must match it. This is the guard that was
//    missing when "520" silently drifted from the real 532; update the const (to the `npm test` count) and every
//    doc must follow, or this fails. ──
test('every unit-test-count claim in the docs matches the cockpit const (no silent drift)', () => {
  const html = read('docs/index.html');
  const u = (html.match(/const URFAEL\s*=\s*\{([^}]*)\}/) || [, ''])[1].match(/unitTests:\s*(\d+)/);
  assert.ok(u, 'const URFAEL must define unitTests: so the test count has one source of truth');
  const N = Number(u[1]);
  const pats = [/(\d+)\s+unit tests/gi, /frozen by (\d+) tests/gi];
  for (const rel of [...DOCS, 'docs/honesty.html', 'docs/faq.html', 'ARCHITECTURE.md']) {
    const t = read(rel);
    for (const re of pats) { let m; while ((m = re.exec(t))) assert.equal(Number(m[1]), N, rel + ' cites "' + m[0].trim() + '" but const URFAEL.unitTests is ' + N); }
  }
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

// ── the maturity ledger is single-sourced. The "which channels are battle-tested" line drifted three ways at once
//    (README, honesty.html, and the manual disagreed, and QQ/SimpleX/PSTN-phone were in no list at all). CHANNEL_MATURITY
//    in app/lib.js is now the one source of truth: it must classify EXACTLY the real roster, and every code-complete
//    channel it names must appear in every maturity ledger, so a doc can never quietly drop or reclassify a channel. ──
const MATURITY = require('../lib').CHANNEL_MATURITY;
const CODE_COMPLETE = Object.values(MATURITY).filter((v) => v.status === 'code-complete').map((v) => v.label);

test('CHANNEL_MATURITY classifies exactly the real channel roster', () => {
  const roster = [...require('../lib').TEAM_CHANNELS].sort();
  const classified = Object.keys(MATURITY).sort();
  assert.deepEqual(classified, roster, 'CHANNEL_MATURITY must classify every TEAM_CHANNELS entry and no extras');
  for (const k of Object.keys(MATURITY)) {
    assert.ok(['certified', 'code-complete'].includes(MATURITY[k].status), k + ' has an unknown maturity status "' + MATURITY[k].status + '"');
    assert.ok(MATURITY[k].label && MATURITY[k].label.length, k + ' needs a display label');
  }
  assert.ok(CODE_COMPLETE.includes('QQ') && CODE_COMPLETE.includes('SimpleX') && CODE_COMPLETE.includes('PSTN phone'),
    'QQ, SimpleX and PSTN phone must be classified code-complete (they were previously in no maturity list)');
});

test('every maturity ledger names every code-complete channel (single-sourced, no underclaim)', () => {
  const ledgers = {
    'README.md': /## What's lightly tested([\s\S]*?)\n## /,
    'docs/honesty.html': /class="light-list">([\s\S]*?)<\/ul>/,
    'docs/manual/channels/overview.md': /## What is lightly tested([\s\S]*?)(?:\n## |$)/,
  };
  for (const [rel, re] of Object.entries(ledgers)) {
    const block = (read(rel).match(re) || [, ''])[1];
    assert.ok(block && block.length > 40, rel + ' has no maturity section for the guard to police (marker changed?)');
    for (const label of CODE_COMPLETE) {
      assert.ok(block.includes(label), rel + ' maturity section omits the code-complete channel "' + label + '"; keep it in lockstep with CHANNEL_MATURITY');
    }
  }
});

// ── SETUP.md was a pre-Console fossil (Node 18 floor, no `urfael setup` wizard). Pin it to the current flow: it must
//    cite the real Node floor from package.json engines and mention the onboarding wizard, so it cannot rot back. ──
test('SETUP.md matches the current install flow (node floor + setup wizard)', () => {
  const setup = read('docs/SETUP.md');
  const floor = (require('../package.json').engines.node.match(/(\d+)/) || [])[1];
  assert.ok(floor, 'package.json engines.node must declare a numeric floor');
  assert.ok(setup.includes('Node ' + floor), 'SETUP.md must cite the real Node floor (Node ' + floor + ')');
  assert.ok(!/Node\s*18/.test(setup), 'SETUP.md still cites the stale Node 18 floor');
  assert.ok(/urfael setup/.test(setup), 'SETUP.md must mention the `urfael setup` onboarding wizard, not just manual placeholder editing');
});
