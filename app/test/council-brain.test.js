'use strict';
// Tests for the OPT-IN Mixture-of-Agents (council) BRAIN mode — the read-only Council exposed as a selectable
// synthetic 'council' brain. The moat is that this ADDS the MoA capability WITHOUT adding to the trust surface:
//   (1) the crown-jewel read-only floor holds on the SHARED councilDeps the brain path uses (a malicious planner
//       is NARROWED to Read/Grep/Glob, never widened to Write/Edit/Bash/bypass),
//   (2) it FAILS CLOSED (garbage planner → one raw-task subtask; an engine failure surfaces an honest council
//       error and NEVER answers on the solo subscription),
//   (3) it is LOCAL-ONLY twice over + gated OFF by default (byte-identity proof via moaGate + source guards),
//   (4) every turn is jobstore-persisted (source:'brain') + ledger-logged, so it is replayable / listable.
// The council engine is driven with a FAKE spawn (zero real turns), reusing the council-protocol harness shape.
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const council = require('../council');
const lib = require('../lib');
const jobstore = require('../jobstore');

const DAEMON_SRC = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');

// ── a fake worker child that emits one result line then exits ──
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => {
    child.stdout.emit('data', Buffer.from('{"type":"result","result":"ok","usage":{"input_tokens":1,"output_tokens":1}}\n'));
    child.emit('exit', 0);
  });
  return child;
}

// deps SHAPED like daemon.councilDeps(jobId): a spawn that RECORDS every worker argv, the read-only floor wiring,
// and an injected planner/synthesis so the whole protocol runs with no real claude.
function capDeps(over) {
  const spawns = [];
  const d = {
    spawn: (bin, args) => { spawns.push({ bin, args }); return fakeChild(); },
    CLAUDE_BIN: 'claude', VAULT: '/tmp', scopedEnv: () => ({}),
    classifyModel: () => 'sonnet', OPUS: 'opus',
    budgetWindow: () => ({ state: { level: 'ok' }, limits: { hard: false } }),
    inflightScoped: new Set(), store: null, jobId: null, _children: new Set(),
    // a MALICIOUS planner: it demands write/shell/edit/web tools for its worker.
    oneShot: async () => '{"plan":"p","subtasks":[{"title":"a","prompt":"do a","tools":["Read","Write","Bash","Edit","WebFetch"]}]}',
    streamOne: async ({ onDelta }) => { onDelta('synth answer'); },
    __spawns: spawns,
  };
  return Object.assign(d, over);
}

// ── (3) moaGate truth table — the byte-identity proof: the default path NEVER enters the branch ──
test('moaGate is true ONLY when the flag is on AND brain mode is council', () => {
  assert.equal(lib.moaGate({ URFAEL_MOA_BRAIN: '1' }, 'council'), true);
  assert.equal(lib.moaGate({ URFAEL_MOA_BRAIN: 'on' }, 'council'), true);
  assert.equal(lib.moaGate({ URFAEL_MOA_BRAIN: 'true' }, 'council'), true);
  // off unless BOTH hold
  assert.equal(lib.moaGate({ URFAEL_MOA_BRAIN: '1' }, 'default'), false);
  assert.equal(lib.moaGate({ URFAEL_MOA_BRAIN: '1' }, null), false);
  assert.equal(lib.moaGate({}, 'council'), false);
  assert.equal(lib.moaGate({ URFAEL_MOA_BRAIN: '0' }, 'council'), false);
  assert.equal(lib.moaGate({ URFAEL_MOA_BRAIN: 'yes' }, 'council'), false);   // only 1|on|true count
  assert.equal(lib.moaGate(undefined, 'council'), false);
});

// ── (1) CROWN-JEWEL floor on the SHARED councilDeps shape: a malicious plan is NARROWED, never widened ──
test('a malicious planner cannot widen a worker past the read-only floor (default mode)', async () => {
  const d = capDeps();
  const dispatches = [];
  await council.runCouncil('audit the repo', { agents: 3 }, (e) => { if (e.ev === 'orchestrator.dispatch') dispatches.push(e); }, d);
  assert.ok(d.__spawns.length >= 1, 'at least one worker was dispatched');
  const FLOOR = ['Read', 'Grep', 'Glob'];
  for (const s of d.__spawns) {
    const argv = s.args;
    const ti = argv.indexOf('--allowedTools');
    const tools = ti >= 0 ? String(argv[ti + 1]).split(',') : [];
    for (const t of tools) assert.ok(FLOOR.includes(t), 'worker tool "' + t + '" is within the read-only floor');
    for (const forbidden of ['Write', 'Edit', 'Bash']) assert.ok(!tools.includes(forbidden), forbidden + ' was narrowed out');
    const joined = argv.join(' ');
    assert.ok(!/bypassPermissions|dangerously-skip-permissions/.test(joined), 'no bypass/skip-permissions in worker argv');
    assert.ok(!/--allowedTools[ =,]?[^-]*(Write|Edit|Bash)/.test('--allowedTools ' + tools.join(',')), 'no write/shell tool granted');
    assert.ok(argv.includes('acceptEdits'), 'worker runs under acceptEdits, never bypassPermissions');
  }
  // the watchable dispatch event also reports the narrowed toolset
  for (const dp of dispatches) assert.ok(dp.tools.every((t) => FLOOR.includes(t)), 'dispatch event tools narrowed to the floor');
});

test('full mode grants web tools but STILL never write/shell (floor + web only)', async () => {
  const d = capDeps({ oneShot: async () => '{"subtasks":[{"prompt":"x","tools":["Read","WebFetch","WebSearch","Bash","Write"]}]}' });
  await council.runCouncil('task', { agents: 2, webOk: true }, () => {}, d);
  const OKSET = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];
  for (const s of d.__spawns) {
    const argv = s.args; const ti = argv.indexOf('--allowedTools');
    const tools = ti >= 0 ? String(argv[ti + 1]).split(',') : [];
    for (const t of tools) assert.ok(OKSET.includes(t), 'full-mode tool "' + t + '" within {read-only ∪ web}');
    for (const forbidden of ['Write', 'Edit', 'Bash']) assert.ok(!tools.includes(forbidden), forbidden + ' still narrowed out in full mode');
  }
});

// ── (2) FAIL-CLOSED: a garbage planner degrades to exactly ONE read-only subtask = the raw task, still synthesizes ──
test('a non-JSON planner reply fans out exactly ONE subtask whose prompt is the raw task', async () => {
  const RAW = 'the exact raw task text';
  const d = capDeps({ oneShot: async () => 'this is not json at all {{{ ][ ' });
  const dispatches = [];
  const r = await council.runCouncil(RAW, { agents: 4 }, (e) => { if (e.ev === 'orchestrator.dispatch') dispatches.push(e); }, d);
  assert.equal(dispatches.length, 1, 'a garbage plan degrades to a single subtask, never an error or unbounded run');
  assert.equal(dispatches[0].prompt, RAW, 'the single subtask prompt equals the raw task');
  assert.equal(r.answer, 'synth answer', 'the council still returns a synthesis');
});

test('_parsePlan is fail-closed to one raw-task subtask on bad JSON', () => {
  const p = council._parsePlan('garbage', 'raw task', 3);
  assert.equal(p.subtasks.length, 1);
  assert.equal(p.subtasks[0].prompt, 'raw task');
});

// ── (6) LEDGER + REPLAY: a source:'brain' council job carries kind:'council' and is listed by `urfael council --list` ──
test('a source:brain council job persists with kind:council and shows up in the council listing', () => {
  const job = jobstore.create({ kind: 'council', source: 'brain', task: 'brain turn task', agents: 3 });
  try {
    const mine = jobstore.list().filter((j) => j.kind === 'council').find((j) => j.id === job.id);
    assert.ok(mine, 'the brain council job is in the council listing (the /councils filter is j.kind===council)');
    assert.equal(mine.spec.source, 'brain', 'the record marks it an ensemble turn, not a solo one');
    assert.equal(mine.spec.task, 'brain turn task');
  } finally {
    try { fs.rmSync(path.join(jobstore.JOBS_DIR, job.id + '.json'), { force: true }); } catch {}
    try { fs.rmSync(path.join(jobstore.JOBS_DIR, job.id + '.log'), { force: true }); } catch {}
  }
});

// ── helpers to slice a function body out of the daemon source for structural (source-guard) assertions ──
function slice(from, to) {
  const a = DAEMON_SRC.indexOf(from);
  assert.ok(a >= 0, 'anchor not found: ' + from);
  const b = to ? DAEMON_SRC.indexOf(to, a + from.length) : DAEMON_SRC.length;
  assert.ok(b > a, 'end anchor not found after: ' + from);
  return DAEMON_SRC.slice(a, b);
}
// strip line comments so a structural guard asserts on the CODE, not the docstrings (which deliberately mention the
// very tokens we forbid in code — e.g. "askScoped does NOT consult parseCouncilDirective").
const code = (s) => s.replace(/\/\/[^\n]*/g, '');

// ── (3) FLAG-OFF byte-identity: the MoA branch, the directive call, and the pin load are ALL gated on MOA_BRAIN_ON ──
test('the MoA routing branch + directive + pin load are ALL wrapped in the MOA_BRAIN_ON gate', () => {
  // the pin is loaded ONLY when the flag is on
  assert.match(DAEMON_SRC, /let brainMode = MOA_BRAIN_ON \? loadBrainPin\(\) : null/, 'brainMode is loaded only under the flag');
  // in brain.ask, the gate opens BEFORE parseCouncilDirective + runCouncilAsBrain, and both sit BEFORE the nativeDefault block
  const idxGate = DAEMON_SRC.indexOf('if (MOA_BRAIN_ON) {');
  const idxParse = DAEMON_SRC.indexOf('parseCouncilDirective(text)');
  const idxRoute = DAEMON_SRC.indexOf('return await runCouncilAsBrain(text, opts)');
  const idxNative = DAEMON_SRC.indexOf('if (nativeDefault) { const nr = await tryNativeDefault');
  assert.ok(idxGate >= 0 && idxParse >= 0 && idxRoute >= 0 && idxNative >= 0, 'all anchors present');
  assert.ok(idxGate < idxParse && idxParse < idxNative, 'parseCouncilDirective is inside the gate, before nativeDefault');
  assert.ok(idxGate < idxRoute && idxRoute < idxNative, 'the runCouncilAsBrain route is inside the gate, before nativeDefault');
  // the boot flag comes from the env via the shared envOn (default OFF)
  assert.match(DAEMON_SRC, /const MOA_BRAIN_ON = envOn\(process\.env\.URFAEL_MOA_BRAIN\)/);
});

// ── (2)+honesty: runCouncilAsBrain returns an honest model:'council' error and NEVER calls the solo warm session ──
test('runCouncilAsBrain never falls back to the solo warm session (no session.ask / getSession on its path)', () => {
  const body = code(slice('async function runCouncilAsBrain(text, opts)', '\nconst brain = {'));
  assert.ok(!/session\.ask/.test(body), 'the brain-council path never calls a warm session.ask (no silent solo answer)');
  assert.ok(!/getSession\(/.test(body), 'the brain-council path never opens a warm solo session');
  assert.match(body, /model: 'council'/, 'the honest error/result is labelled model:council');
  assert.match(body, /did not answer solo/, 'an engine failure explicitly states it did NOT answer solo');
  assert.match(body, /kind: 'council', source: 'brain'/, "the job is persisted kind:'council' source:'brain'");
  assert.match(body, /ev: 'council_start'/, 'the turn logs council_start to the ledger');
  assert.match(body, /ev: 'council_done'/, 'the turn logs council_done to the ledger');
  assert.match(body, /councilInFlight = false; councilAbort = null;/, 'single-flight + abort hook are released in a finally');
});

// ── (7) LOCAL-ONLY twice over ──
test('askScoped (the remote one-shot path) never reads brainMode or the council directive', () => {
  const body = code(slice('askScoped(text, profile, ctx = {})', '// delegateBackground'));
  assert.ok(!/parseCouncilDirective/.test(body), 'a remote turn never consults the council directive');
  assert.ok(!/brainMode/.test(body), 'a remote turn never reads brainMode — no remote principal can convene an ensemble');
  assert.ok(!/runCouncilAsBrain/.test(body), 'a remote turn can never route into the ensemble');
});

test('POST /brain is LOCAL-ONLY (403 on a channel) and FAIL-CLOSED (400 + enable hint when off)', () => {
  const body = slice("} else if (req.url === '/brain') {", "} else if (req.method === 'POST' && req.url === '/chat')");
  assert.match(body, /'channel' in parsed && parsed\.channel/, 'a present channel is checked');
  assert.match(body, /writeHead\(403/, 'a present channel is refused with 403 (matching /council + /engine/default)');
  assert.match(body, /!MOA_BRAIN_ON/, 'when the flag is off the POST is refused');
  assert.match(body, /writeHead\(400/, 'the off-refusal is a fail-closed 400');
  assert.match(body, /URFAEL_MOA_BRAIN=1/, 'the 400 carries the enable hint');
});

// ── zero-dep invariant: app/package.json dependencies stays exactly {} ──
test('app/package.json dependencies is exactly {} (no new package, Node built-ins only)', () => {
  const pkg = require('../package.json');
  assert.deepEqual(pkg.dependencies, {}, 'the runtime dependency set must stay empty');
});

// ── brain.abort() also reaps a live council (abort/single-flight coupling) ──
test('brain.abort() also fires councilAbort so a stuck ensemble cannot wedge future turns', () => {
  const body = slice('abort() { let any = false;', 'askScoped(text, profile');
  assert.match(body, /councilAbort/, 'abort() reaps a live MoA-brain council');
});
