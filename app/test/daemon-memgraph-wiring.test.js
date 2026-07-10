'use strict';
// Source-assert guard for the opt-in Memory Journey route in app/daemon.js. Requiring daemon.js boots the brain
// (it binds the unix socket at load), so we read it as TEXT and assert the load-bearing invariants: the feature is
// env-gated OFF (envOn(URFAEL_MEMGRAPH)), the /graph route is guarded by the flag so it falls through to the
// existing 404 when off (byte-identical socket surface), it runs ONE shell-free execFileSync git over the dedicated
// 5-file GRAPH_FILES set (NOT the 4-file MEMORY_FILES that omits USER.json), it is fail-closed (empty graph on any
// error, never a crash), it never recomputes the chain (auditChain.verify result is passed in), no new inbound port
// is opened, and app/package.json dependencies stays {}.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const daemon = fs.readFileSync(path.join(APP, 'daemon.js'), 'utf8');
const pkg = require('../package.json');

// ── ZERO-DEP ──
test('app/package.json dependencies stays {} (Node built-ins only)', () => {
  assert.deepStrictEqual(pkg.dependencies || {}, {});
});

// ── ENV GATE (default OFF via the shared envOn helper) ──
test('MEMGRAPH_ON is parsed with envOn(process.env.URFAEL_MEMGRAPH) beside the other opt-in flags', () => {
  assert.match(daemon, /const MEMGRAPH_ON = envOn\(process\.env\.URFAEL_MEMGRAPH\);/);
  assert.match(daemon, /const memgraph = require\('\.\/memgraph'\);/);
});

// ── the route is guarded so OFF falls through to the existing 404 ──
test('the /graph route is guarded by MEMGRAPH_ON (OFF -> unmatched -> existing 404)', () => {
  assert.match(daemon, /else if \(MEMGRAPH_ON && req\.url && req\.url\.startsWith\('\/graph'\)\)/);
});

// ── dedicated 5-file GRAPH_FILES set (the exact `why` set, includes USER.json) ──
test('GRAPH_FILES is the 5-file `why` set (includes USER.json), not the 4-file MEMORY_FILES', () => {
  const m = daemon.match(/const GRAPH_FILES = \[([^\]]*)\]/);
  assert.ok(m, 'GRAPH_FILES const must exist');
  for (const f of ['MEMORY.md', 'USER.md', 'USER.json', 'WORKFLOW.md', 'LESSONS.md']) {
    assert.ok(m[1].indexOf("'" + f + "'") >= 0, 'GRAPH_FILES must include ' + f);
  }
});

// ── shell-free git with bounded buffer + timeout, and the chain result is PASSED IN (never recomputed here) ──
test('the projection runs one shell-free execFileSync git log -p with maxBuffer + timeout, passing auditChain.verify in', () => {
  const fn = daemon.slice(daemon.indexOf('function buildGraphResponse('), daemon.indexOf('function buildGraphResponse(') + 1400);
  assert.match(fn, /execFileSync\('git',\s*args/);          // ARRAY args, no shell string
  assert.match(fn, /maxBuffer: 1 << 24/);
  assert.match(fn, /timeout: \d+/);
  assert.match(fn, /auditChain\.verify\(lines\)/);           // verify the chain here
  assert.match(fn, /memgraph\.buildGraph\(\{ gitLogText, learnItems, ledger \}\)/); // hand the RESULT to the pure projector
});

// ── fail-closed: any error yields an empty graph, never a throw / 500 ──
test('buildGraphResponse is fail-closed to an empty graph on any error', () => {
  const fn = daemon.slice(daemon.indexOf('function buildGraphResponse('), daemon.indexOf('function buildGraphResponse(') + 1400);
  assert.match(fn, /const EMPTY = \{ nodes: \[\], edges: \[\], ledger: \{ ok: false \}, truncated: false/);
  assert.match(fn, /catch \{ return EMPTY; \}/);
});

// ── asOf is validated to a strict date charset and passed only as a git ARG (no shell) ──
test('the optional ?asOf is validated to a date charset and passed only as a git arg (injection-safe)', () => {
  const fn = daemon.slice(daemon.indexOf('function buildGraphResponse('), daemon.indexOf('function buildGraphResponse(') + 1400);
  assert.match(fn, /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}/);        // strict yyyy-mm-dd[...] charset
  assert.match(fn, /args\.push\('--before=' \+ asOf\)/);      // passed ONLY as an execFile arg, never a shell
});

// ── no new inbound port opened by the feature (the daemon keeps its single existing http.createServer) ──
test('the feature opens no new inbound port (still exactly one http.createServer, no new .listen)', () => {
  assert.equal((daemon.match(/http\.createServer/g) || []).length, 1);
  // the graph route is another branch on the existing socket dispatch, not a new server
  assert.ok(daemon.indexOf('buildGraphResponse(req.url)') >= 0);
});
