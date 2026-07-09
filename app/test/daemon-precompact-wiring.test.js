'use strict';
// Source-assert guard for the opt-in pre-hand-off distill compaction wiring in app/daemon.js. Requiring daemon.js
// boots the brain (it binds the unix socket at load), so we read it as TEXT and assert the load-bearing invariants:
// the feature is env-gated OFF (only '1' enables), the default distill path is byte-identical (_runDistill(rawConvo)),
// the summarizer runs on the read-only floor with scopedEnv() and never bypassPermissions, no new inbound port is
// opened by the pure module, 'precompact' is hash-chained into the tamper-evident ledger, and dependencies stays {}.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const daemon = fs.readFileSync(path.join(APP, 'daemon.js'), 'utf8');
const handoff = fs.readFileSync(path.join(APP, 'engine', 'handoff-compact.js'), 'utf8');
const pkg = require('../package.json');

// ── ZERO-DEP + NO NEW PORT ──
test('app/package.json dependencies stays {} (Node built-ins only)', () => {
  assert.deepStrictEqual(pkg.dependencies || {}, {});
});

test('the pure hand-off module opens NO inbound port (no listen/createServer/net.Server)', () => {
  assert.doesNotMatch(handoff, /\blisten\s*\(|createServer|net\.Server/);
});

// ── ENV GATE: only the exact value '1' enables the feature ──
test('PRECOMPACT_ON parses ONLY the exact value "1"', () => {
  assert.match(daemon, /const PRECOMPACT_ON = process\.env\.URFAEL_PRECOMPACT === '1';/);
});

// ── DEFAULT BYTE-IDENTICAL: the OFF path runs _runDistill(rawConvo); precompactConvo is gated behind PRECOMPACT_ON ──
test('the distill compaction call site is inside if (PRECOMPACT_ON) and the OFF path is _runDistill(rawConvo)', () => {
  const body = (daemon.match(/function distill\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  assert.ok(body, 'distill() body not found');
  assert.match(body, /if \(PRECOMPACT_ON\) \{/);
  // the raw convo is the EXACT original join, byte-for-byte
  assert.match(body, /const rawConvo = transcript\.map\(\(t\) => `User: \$\{t\.user\}\\nUrfael: \$\{t\.urfael\}`\)\.join\('\\n\\n'\);/);
  // the OFF branch calls _runDistill(rawConvo)
  assert.match(body, /\} else \{\s*\n\s*_runDistill\(rawConvo\);/);
  // precompactConvo is invoked ONLY within the guarded async branch
  const beforeElse = body.split('} else {')[0];
  assert.match(beforeElse, /handoffCompact\.precompactConvo\(/);
  const afterElse = body.split('} else {')[1] || '';
  assert.doesNotMatch(afterElse, /precompactConvo/);
});

// ── READ-ONLY SANDBOXED SUMMARIZER: the verifyOne() recipe, scopedEnv(), never bypass ──
test('makeHandoffSummarizer spawns on the read-only floor with scopedEnv() and never bypassPermissions', () => {
  const fn = (daemon.match(/function makeHandoffSummarizer\(\)\s*\{[\s\S]*?\n\}\n\nfunction distill/) || [''])[0];
  assert.ok(fn, 'makeHandoffSummarizer() body not found');
  assert.match(fn, /'--strict-mcp-config'/);
  assert.match(fn, /'--output-format', 'json'/);
  for (const t of ['Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch']) {
    assert.match(fn, new RegExp("'--disallowedTools', '" + t + "'"), 'summarizer must disallow ' + t);
  }
  assert.match(fn, /'--permission-mode', 'acceptEdits'/);
  assert.doesNotMatch(fn, /bypassPermissions/);
  assert.match(fn, /env: scopedEnv\(\)/);
  assert.match(fn, /cwd: VAULT/);
  assert.match(fn, /90000/);                                     // 90s SIGKILL, matching verifyOne()
  assert.match(fn, /renderMiddleText/);                          // edge-1 redaction via the pure module
});

// ── LEDGER: 'precompact' is a hash-chained event and is logged with the audited fields ──
test("'precompact' is a member of CHAINED_EVENTS (tamper-evident ledger)", () => {
  const set = (daemon.match(/const CHAINED_EVENTS = new Set\(\[([^\]]*)\]\)/) || [, ''])[1];
  assert.match(set, /'precompact'/);
});

test('a compaction logs exactly one precompact event with tokensBefore/After + savedPct + reason', () => {
  const matches = daemon.match(/logEvent\(\{ ev: 'precompact'[^}]*\}\)/g) || [];
  assert.strictEqual(matches.length, 1);
  const ev = matches[0];
  for (const f of ['tokensBefore', 'tokensAfter', 'savedPct', 'reason']) assert.match(ev, new RegExp(f));
});

// ── the tuning knobs exist with safe defaults and are inert unless the main flag is on ──
test('the tuning knobs exist with safe defaults (ratio 0.75, firstN 2, lastN 6)', () => {
  assert.match(daemon, /URFAEL_PRECOMPACT_RATIO[\s\S]*?0\.75/);
  assert.match(daemon, /URFAEL_PRECOMPACT_FIRSTN[\s\S]*?: 2/);
  assert.match(daemon, /URFAEL_PRECOMPACT_LASTN[\s\S]*?: 6/);
});
