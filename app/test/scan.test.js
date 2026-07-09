'use strict';
// Unit tests for `urfael scan` (app/scan.js) — the read-only, verified security audit. Fully offline: a fake
// spawn returns scripted claude `--output-format json` envelopes, so the whole finder -> verifier -> report flow
// runs with zero real turns. The load-bearing invariants: findings parse fail-closed, the verifier gates what
// ships (refuted candidates are dropped from Findings), every spawned agent is READ-ONLY, and the report never
// overclaims.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const scan = require('../scan');

// A fake `spawn` that speaks the one-shot JSON protocol: it picks a scripted reply by inspecting the prompt
// (finder vs verifier), wraps it in a {type:'result', result} envelope on stdout, then exits. Records every call.
function fakeSpawn(script) {
  const calls = [];
  const spawn = (bin, args, o) => {
    calls.push({ bin, args, cwd: o && o.cwd, env: o && o.env });
    const joined = args.join(' ');
    const isVerifier = /REFUTE it/.test(joined);
    const reply = isVerifier ? script.verify(joined) : script.find();
    // reply is a plain string (result text, exit 0) OR { result, is_error, exitCode } to simulate a failed turn.
    const spec = (reply && typeof reply === 'object') ? reply : { result: String(reply) };
    const envelope = { type: 'result', result: String(spec.result == null ? '' : spec.result) };
    if (spec.is_error) envelope.is_error = true;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify(envelope)));
      child.emit('exit', spec.exitCode == null ? 0 : spec.exitCode);
    });
    return child;
  };
  return { spawn, calls };
}
const deps = (spawn) => ({ spawn, CLAUDE_BIN: 'claude', scopedEnv: () => ({ HOME: '/h', PATH: '/p' }) });

// ── parsers fail closed ──
test('extractFindings: parses a trailing array, ignores prose, fail-closes to [] on garbage', () => {
  assert.equal(scan.extractFindings('blah blah\n[{"title":"x"}]').length, 1);
  assert.deepEqual(scan.extractFindings('no json at all'), []);
  assert.deepEqual(scan.extractFindings('[not, valid json'), []);
  assert.deepEqual(scan.extractFindings('[]'), []);
});

test('extractVerdict: reads the last balanced verdict object, null on garbage', () => {
  assert.equal(scan.extractVerdict('sure {"verdict":"refuted","reason":"guarded"}').verdict, 'refuted');
  assert.equal(scan.extractVerdict('the model rambled'), null);
});

// ── the verifier gates what ships ──
test('runScan: confirms the real finding, refutes the false one, ships only the survivor', async () => {
  const finderOut = 'Here is what I found:\n' + JSON.stringify([
    { title: 'SQL injection in search', file: 'src/db.js', line: 10, severity: 'high', class: 'sqli', summary: 'concatenated query' },
    { title: 'XSS in header', file: 'src/head.js', line: 4, severity: 'medium', class: 'xss', summary: 'innerHTML' },
  ]);
  const f = fakeSpawn({
    find: () => finderOut,
    verify: (joined) => /SQL injection in search/.test(joined)
      ? '{"verdict":"confirmed","confidence":"high","reason":"the query is string-concatenated with req.query.q"}'
      : '{"verdict":"refuted","confidence":"high","reason":"the value is escaped by the templating layer"}',
  });
  const r = await scan.runScan('/repo', {}, null, deps(f.spawn));
  assert.equal(r.confirmed.length, 1);
  assert.equal(r.confirmed[0].title, 'SQL injection in search');
  assert.equal(r.refuted.length, 1);
  assert.equal(r.unverified.length, 0);
  assert.equal(r.meta.found, 2);
});

// ── the read-only floor is load-bearing: no write/shell/bypass can ever reach a spawned agent ──
test('runScan: every agent is spawned READ-ONLY (Read/Grep/Glob, strict-mcp) scoped to the target repo', async () => {
  const f = fakeSpawn({
    find: () => JSON.stringify([{ title: 't', file: 'a.js', line: 1, severity: 'low' }]),
    verify: () => '{"verdict":"confirmed","reason":"reachable"}',
  });
  await scan.runScan('/target/repo', {}, null, deps(f.spawn));
  assert.ok(f.calls.length >= 2, 'a finder and at least one verifier were spawned');
  for (const c of f.calls) {
    const ti = c.args.indexOf('--allowedTools');
    assert.equal(c.args[ti + 1], 'Read,Grep,Glob', 'the read-only floor is the ONLY toolset granted (no Write/Edit/Bash)');
    assert.ok(c.args.includes('--strict-mcp-config'), 'no ambient MCP reaches the agent');
    assert.ok(!c.args.includes('--dangerously-skip-permissions'), 'never bypasses permissions');
    assert.equal(c.args[c.args.indexOf('--permission-mode') + 1], 'acceptEdits', 'permission mode is acceptEdits, not a bypass');
    assert.equal(c.cwd, '/target/repo', 'the agent is scoped to the target repo');
  }
});

// ── a clean repo is a first-class, respected result ──
test('runScan: a clean finder result ([]) ships zero findings and spawns NO verifier', async () => {
  const f = fakeSpawn({ find: () => '[]', verify: () => { throw new Error('the verifier must not run when the finder is clean'); } });
  const r = await scan.runScan('/repo', {}, null, deps(f.spawn));
  assert.equal(r.confirmed.length, 0);
  assert.equal(r.findings.length, 0);
  assert.equal(f.calls.length, 1, 'only the finder ran');
});

// ── a rambling / no-array finder output is INCONCLUSIVE (error), never a false clean ──
test('runScan: a successful turn with no result array is inconclusive (error), never a false clean', async () => {
  const f = fakeSpawn({ find: () => 'I looked around and could not decide on a format.', verify: () => { throw new Error('no verifier when the finder produced no array'); } });
  const r = await scan.runScan('/repo', {}, null, deps(f.spawn));
  assert.equal(r.meta.error, 'brain_unreachable');
  assert.equal(r.findings.length, 0);
  assert.equal(r.confirmed.length, 0);
  assert.equal(f.calls.length, 1);
});

// ── an unparseable verdict keeps the finding as UNVERIFIED (never a silent drop) ──
test('runScan: an unparseable verdict marks the finding unverified, it is not silently dropped', async () => {
  const f = fakeSpawn({
    find: () => JSON.stringify([{ title: 'maybe SSRF', file: 'x.js', line: 2, severity: 'medium' }]),
    verify: () => 'the reviewer gave a prose answer with no json',
  });
  const r = await scan.runScan('/repo', {}, null, deps(f.spawn));
  assert.equal(r.confirmed.length, 0);
  assert.equal(r.unverified.length, 1);
  assert.equal(r.unverified[0].title, 'maybe SSRF');
});

// ── a brain that never ran must NOT be reported as a clean repo (the dangerous false negative) ──
test('runScan: an auth error / empty finder output reports an ERROR, not a false clean', async () => {
  const f = fakeSpawn({ find: () => 'Not logged in · Please run /login', verify: () => { throw new Error('no verifier on a dead brain'); } });
  const r = await scan.runScan('/repo', {}, null, deps(f.spawn));
  assert.equal(r.meta.error, 'brain_unreachable');
  assert.equal(r.findings.length, 0);
  assert.equal(f.calls.length, 1, 'only the finder ran');
});

// ── THE RELEASE-BLOCKER: a NON-auth brain error (usage-limit / overloaded / 5xx) must never read as clean ──
test('runScan: is_error:true (usage-limit / overloaded / 5xx) reports an ERROR, never a false clean', async () => {
  const f = fakeSpawn({
    find: () => ({ result: 'Claude usage limit reached. Please try again later.', is_error: true }),
    verify: () => { throw new Error('no verifier on a dead brain'); },
  });
  const r = await scan.runScan('/repo', {}, null, deps(f.spawn));
  assert.equal(r.meta.error, 'brain_unreachable');
  assert.equal(r.confirmed.length, 0);
  assert.equal(f.calls.length, 1, 'only the finder ran');
  assert.doesNotMatch(scan.formatReport(r), /no exploitable vulnerability found/i);
});

test('runScan: a non-zero exit (crash mid-audit) reports an ERROR, not a clean', async () => {
  const f = fakeSpawn({ find: () => ({ result: 'the audit process crashed', exitCode: 1 }), verify: () => { throw new Error('x'); } });
  const r = await scan.runScan('/repo', {}, null, deps(f.spawn));
  assert.equal(r.meta.error, 'brain_unreachable');
});

// ── hardening: a hostile repo cannot amplify subprocesses by coercing a huge finder array ──
test('runScan: caps how many findings it verifies, and reports the true count + the drop honestly', async () => {
  const many = Array.from({ length: 35 }, (_, i) => ({ title: 'f' + i, file: 'a' + i + '.js', line: 1, severity: 'low' }));
  const f = fakeSpawn({ find: () => JSON.stringify(many), verify: () => '{"verdict":"confirmed","reason":"r"}' });
  const r = await scan.runScan('/repo', {}, null, deps(f.spawn));
  assert.equal(r.meta.found, 35, 'the true finder count is reported');
  assert.equal(r.meta.verified, 30, 'only the first 30 were verified');
  assert.equal(r.meta.dropped, 5, '5 beyond the cap were dropped');
  assert.equal(f.calls.length, 31, '1 finder + exactly 30 verifiers, not 35');
  const md = scan.formatReport(r);
  assert.match(md, /35 candidates/);
  assert.match(md, /5 were not checked/);
});

test('formatReport: an errored scan says the audit could not run, never "clean"', () => {
  const md = scan.formatReport({ confirmed: [], refuted: [], unverified: [], meta: { repo: '/r/x', error: 'brain_unreachable', ts: 0 } }, { name: 'x' });
  assert.match(md, /could not run/i);
  assert.doesNotMatch(md, /no exploitable vulnerability found/i);
});

// ── the report is honest: verified findings, a checked-and-cleared section, scope/limits, and NO overclaims ──
test('formatReport: shows findings + checked-and-cleared + scope/limits, and never overclaims', () => {
  const r = {
    confirmed: [{ title: 'SQLi', file: 'db.js', line: 3, severity: 'high', summary: 'concatenated', verdict: { reason: 'req.query.q flows into the query' } }],
    refuted: [{ title: 'XSS', file: 'h.js', verdict: { reason: 'escaped by the framework' } }],
    unverified: [],
    meta: { repo: '/r/app', found: 2, confirmed: 1, refuted: 1, unverified: 0, ts: 0 },
  };
  const md = scan.formatReport(r, { name: 'app' });
  assert.match(md, /Security audit: app/);
  assert.match(md, /SQLi/);
  assert.match(md, /\[verified\]/);
  assert.match(md, /Checked and cleared/);
  assert.match(md, /escaped by the framework/);
  assert.match(md, /Scope and limits/);
  assert.doesNotMatch(md, /found everything|zero false positives|\bautonomous\b/i);
});

test('formatReport: a clean scan reads as a respected result, not a failure', () => {
  const md = scan.formatReport({ confirmed: [], refuted: [], unverified: [], meta: { repo: '/r/site', found: 3, refuted: 3, ts: 0 } }, { name: 'site' });
  assert.match(md, /no exploitable vulnerability found/i);
  assert.match(md, /3 candidate\(s\) checked/);
});
