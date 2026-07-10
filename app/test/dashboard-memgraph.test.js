'use strict';
// Guards for the OPT-IN Memory Journey dashboard view (app/dashboard.js). The load-bearing invariants: with the
// flag OFF the served page is BYTE-IDENTICAL to a captured pre-feature baseline (zero graph bytes) and none of the
// graph routes are registered; with the flag ON the read-only section appears and renders via createElementNS +
// textContent ONLY (no innerHTML/iframe/foreignObject/eval/new Function on graph data); and the /api/graph routes
// sit AFTER the auth gate + rate limit, with /api/graph/prove validating seq as a non-negative integer.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// redirect HOME so requiring dashboard.js (which reads/creates a 0600 token) never touches the real home dir.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-dash-home-'));
process.env.HOME = TMP_HOME;

const DASH = path.join(__dirname, '..', 'dashboard.js');
const SRC = fs.readFileSync(DASH, 'utf8');
const BASELINE = fs.readFileSync(path.join(__dirname, 'fixtures', 'dashboard-baseline.html'), 'utf8');

// Load app/dashboard.js fresh under a given URFAEL_MEMGRAPH value (the MEMGRAPH const is fixed at module load).
function loadDashboard(flag) {
  delete require.cache[require.resolve('../dashboard')];
  if (flag == null) delete process.env.URFAEL_MEMGRAPH; else process.env.URFAEL_MEMGRAPH = flag;
  return require('../dashboard');
}

// ── DEFAULT BYTE-IDENTICAL ──
test('with URFAEL_MEMGRAPH unset, pageHtml() equals the captured pre-feature baseline (zero graph bytes)', () => {
  const html = loadDashboard(null).pageHtml();
  assert.equal(html, BASELINE, 'the flag-off page must be byte-identical to the baseline');
});

test('the flag-off page contains none of the graph markers', () => {
  const html = loadDashboard('').pageHtml();
  for (const marker of ['memjourney', '/api/graph', 'GRAPH_SECTION', 'createElementNS', 'mj-svg']) {
    assert.ok(html.indexOf(marker) < 0, 'flag-off page must not contain "' + marker + '"');
  }
  assert.ok(!/memgraph/i.test(html), 'flag-off page must not mention memgraph');
});

// ── FLAG-ON adds the read-only section ──
test('with URFAEL_MEMGRAPH=1, pageHtml() adds the read-only Memory Journey section + on-demand client', () => {
  const html = loadDashboard('1').pageHtml();
  assert.ok(html.indexOf('id="memjourney"') >= 0, 'the section is present when on');
  assert.ok(html.indexOf('id="mj-load"') >= 0, 'a load button (on-demand, not the 5s tick) is present');
  assert.ok(html.indexOf('createElementNS') >= 0, 'the client builds SVG via createElementNS');
  assert.ok(html.length > BASELINE.length, 'the on page is strictly larger');
});

// restore default so later cache state / other tests see the flag off
loadDashboard(null);

// ── SANITIZER / ALLOWLIST over the graph client block ──
function graphBlock() {
  const a = SRC.indexOf('const GRAPH_CSS =');
  const b = SRC.indexOf('MEMGRAPH GRAPH CLIENT (end)');
  assert.ok(a >= 0 && b > a, 'the graph client block markers must exist');
  return SRC.slice(a, b);
}

test('the graph client renders via createElementNS + textContent and clears via replaceChildren', () => {
  const blk = graphBlock();
  assert.ok(blk.indexOf('createElementNS') >= 0, 'uses createElementNS');
  assert.ok(blk.indexOf('textContent') >= 0, 'writes labels via textContent');
  assert.ok(blk.indexOf('replaceChildren') >= 0, 'clears via replaceChildren');
});

test('no graph-block line uses innerHTML / iframe / foreignObject / eval / new Function (source scan)', () => {
  const blk = graphBlock();
  for (const bad of ['innerHTML', '<iframe', 'foreignObject', 'eval(', 'new Function']) {
    assert.ok(blk.indexOf(bad) < 0, 'the graph client must never use "' + bad + '"');
  }
  // the ONLY innerHTML-shaped clearing is replaceChildren/textContent (asserted above); confirm no `.innerHTML =`
  assert.doesNotMatch(blk, /\.innerHTML\s*=/);
});

// ── AUTH ORDER: the graph routes sit AFTER the auth gate + rateOk() check ──
test('/api/graph and /api/graph/prove are registered AFTER the auth gate and the rateOk() check', () => {
  const authIdx = SRC.indexOf('if (!authed)');
  const rateIdx = SRC.indexOf('if (!rateOk(ip))');
  const graphIdx = SRC.indexOf("pathname === '/api/graph'");
  const proveIdx = SRC.indexOf("pathname === '/api/graph/prove'");
  assert.ok(authIdx > 0 && rateIdx > authIdx, 'the auth gate then the rate limit exist in order');
  assert.ok(graphIdx > rateIdx, '/api/graph is registered after the rate-limit gate');
  assert.ok(proveIdx > rateIdx, '/api/graph/prove is registered after the rate-limit gate');
});

test('the graph routes are gated on MEMGRAPH and /api/graph/prove validates seq as a non-negative integer', () => {
  assert.match(SRC, /if \(MEMGRAPH && req\.method === 'GET' && pathname === '\/api\/graph'\)/);
  assert.match(SRC, /if \(MEMGRAPH && req\.method === 'GET' && pathname === '\/api\/graph\/prove'\)/);
  // seq must be a non-negative integer, else 400 (no passthrough of a non-integer to the daemon)
  assert.match(SRC, /\/\^\\d\+\$\/\.test/);
  assert.match(SRC, /seq must be a non-negative integer/);
});

// ── NO NEW PORT / NO NEW SOCKET: the routes reuse daemonGet over the existing 0600 unix socket ──
test('the graph proxy reuses daemonGet (no new socket, no new listener added by the feature)', () => {
  assert.match(SRC, /daemonGet\('\/graph'/);
  assert.match(SRC, /daemonGet\('\/audit\/prove\?seq='/);
  // the only server.listen is the original, now behind the require.main guard
  assert.equal((SRC.match(/server\.listen\(/g) || []).length, 1);
  assert.match(SRC, /if \(require\.main === module\)/);
  assert.match(SRC, /module\.exports = \{ pageHtml \}/);
});
