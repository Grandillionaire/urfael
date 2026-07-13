'use strict';
// Tests for the OPT-IN (URFAEL_COUNCIL_ASYNC=1), summary-only, DETACHED-from-the-terminal async Council
// (`urfael council --async`). The moat is that this ADDS a background-council capability WITHOUT widening the trust
// surface or diverging the crown-jewel read-only floor:
//   (1) DOUBLE OPT-IN / byte-identical default — asyncCouncilGate is OFF by default; a POST /council with NO async
//       field takes the EXACT existing sync `chain` path; a {async:true} without the flag is a 403 with the hint.
//   (2) READ-ONLY FLOOR ON EVERY DETACHED WORKER — the detached run reuses the SAME single-sourced councilDeps →
//       intersectTools, so a planner requesting Write/Edit/Bash/bypass is NARROWED to {Read,Grep,Glob} (+web only in
//       full mode); no worker argv carries a mutating tool or a bypass flag, no --resume/parent transcript.
//   (3) SUMMARY-ONLY — the detached emit adapter appends ONLY to the jobstore NDJSON log; it has no handle on the
//       response stream or the shared `active`/sendSay voice writer (structural, not discipline).
//   (4) IMMEDIATE DETACH + CANCELLABILITY + LEDGER — the run is a fire-and-forget promise (off `chain`), id-scoped
//       cancel SIGKILLs its tracked children and marks it 'interrupted' (a wrong id is a 404), and completion phones a
//       caveated, speak:false summary through the daemon's OWN notifyOwner sanitizer + logs council_push/council_done.
// The council engine + the detached driver are driven with FAKES (zero real turns, no daemon socket).
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const council = require('../council');
const lib = require('../lib');
const jobstore = require('../jobstore');
const ac = require('../engine/async-council');

const DAEMON_SRC = fs.readFileSync(path.join(__dirname, '..', 'daemon.js'), 'utf8');
const AC_SRC = fs.readFileSync(path.join(__dirname, '..', 'engine', 'async-council.js'), 'utf8');
const LIB_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib.js'), 'utf8');

// ── a fake worker child that emits one result line then exits (reuses the council-protocol harness shape) ──
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

// deps SHAPED like daemon.councilDeps(jobId): a spawn that RECORDS every worker argv + spawn opts, the read-only floor
// wiring, and an injected planner/synthesis so the whole protocol runs with no real claude.
function capDeps(over) {
  const spawns = [];
  const d = {
    spawn: (bin, args, opts) => { spawns.push({ bin, args, opts }); return fakeChild(); },
    CLAUDE_BIN: 'claude', VAULT: '/tmp', scopedEnv: () => ({}),
    classifyModel: () => 'sonnet', OPUS: 'opus',
    budgetWindow: () => ({ state: { level: 'ok' }, limits: { hard: false } }),
    inflightScoped: new Set(), store: null, jobId: null, _children: new Set(),
    // a MALICIOUS planner: it demands write/shell/edit/bypass tools for its worker.
    oneShot: async () => '{"plan":"p","subtasks":[{"title":"a","prompt":"do a","tools":["Write","Edit","Bash","--dangerously-skip-permissions"]},{"title":"b","prompt":"do b","tools":["Read","Write","Bash"]}]}',
    streamOne: async ({ onDelta }) => { onDelta('synth answer'); },
    __spawns: spawns,
  };
  return Object.assign(d, over);
}

// ── slice a region out of the daemon source for structural (source-guard) assertions ──
function slice(from, to) {
  const a = DAEMON_SRC.indexOf(from);
  assert.ok(a >= 0, 'anchor not found: ' + from);
  const b = to ? DAEMON_SRC.indexOf(to, a + from.length) : DAEMON_SRC.length;
  assert.ok(b > a, 'end anchor not found after: ' + from);
  return DAEMON_SRC.slice(a, b);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// (1) PURE-GATE TRUTH TABLE — the double-opt-in byte-identity proof
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
test('asyncCouncilGate matches envOn: OFF for unset/""/0/off/false/junk, ON only for 1|on|true (any case, trimmed)', () => {
  for (const v of [undefined, '', '0', 'off', 'false', 'nope', ' ', '2', 'yes', 'onoff']) {
    assert.equal(lib.asyncCouncilGate({ URFAEL_COUNCIL_ASYNC: v }), false, JSON.stringify(v) + ' must be OFF');
  }
  assert.equal(lib.asyncCouncilGate({}), false, 'unset env → OFF');
  assert.equal(lib.asyncCouncilGate(undefined), false, 'no env object → OFF (total, never throws)');
  for (const v of ['1', 'on', 'true', 'ON', 'True', 'TRUE', ' 1 ', ' on ']) {
    assert.equal(lib.asyncCouncilGate({ URFAEL_COUNCIL_ASYNC: v }), true, JSON.stringify(v) + ' must be ON');
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// (2) READ-ONLY FLOOR ON EVERY DETACHED WORKER — THE BEAT: a malicious planner is NARROWED, never widened
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
test('detached path: a planner requesting Write/Edit/Bash/bypass → EVERY worker --allowedTools ⊆ {Read,Grep,Glob}, no mutating/bypass token', async () => {
  const d = capDeps();
  await council.runCouncil('audit the repo', { agents: 3, webOk: false }, () => {}, d);
  assert.ok(d.__spawns.length >= 2, 'both malicious subtasks were dispatched');
  const FLOOR = new Set(['Read', 'Grep', 'Glob']);
  for (const s of d.__spawns) {
    const argv = s.args;
    const tools = String(argv[argv.indexOf('--allowedTools') + 1]).split(',');
    for (const t of tools) assert.ok(FLOOR.has(t), 'worker tool "' + t + '" ⊆ the read-only floor');
    for (const bad of ['Write', 'Edit', 'Bash']) {
      assert.ok(!tools.includes(bad), bad + ' was narrowed out of --allowedTools');
      assert.ok(!argv.includes(bad), bad + ' never appears as a worker argv element');
    }
    assert.ok(!argv.includes('--dangerously-skip-permissions'), 'no --dangerously-skip-permissions');
    assert.ok(!argv.includes('bypassPermissions'), 'no bypassPermissions token');
    assert.ok(!argv.join(' ').includes('--permission-mode bypassPermissions'), 'never --permission-mode bypassPermissions');
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits', 'the worker runs under acceptEdits');
  }
});

test('detached path in full (web) mode: floor widens ONLY to {WebFetch,WebSearch}, STILL never Write/Edit/Bash', async () => {
  const d = capDeps({ oneShot: async () => '{"subtasks":[{"prompt":"x","tools":["WebFetch","WebSearch","Write","Bash","Edit"]}]}' });
  await council.runCouncil('task', { agents: 2, webOk: true }, () => {}, d);
  const OK = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
  assert.ok(d.__spawns.length >= 1);
  for (const s of d.__spawns) {
    const tools = String(s.args[s.args.indexOf('--allowedTools') + 1]).split(',');
    for (const t of tools) assert.ok(OK.has(t), 'full-mode tool "' + t + '" within {read-only ∪ web}');
    for (const bad of ['Write', 'Edit', 'Bash']) assert.ok(!tools.includes(bad), bad + ' still narrowed out in full mode');
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// (3) FRESH CONVERSATION / NO PARENT CONTEXT — the detached worker is a self-contained, nonce-framed subtask
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
test('the detached worker argv is a fresh nonce-framed subtask: no --resume/--continue, cwd=VAULT, acceptEdits, --strict-mcp-config', async () => {
  const d = capDeps({ VAULT: '/vault-xyz' });
  await council.runCouncil('the original task', { agents: 1 }, () => {}, d);
  assert.ok(d.__spawns.length >= 1);
  for (const s of d.__spawns) {
    const argv = s.args;
    assert.ok(!argv.includes('--resume') && !argv.includes('--continue'), 'no parent transcript is resumed/continued');
    assert.ok(!argv.join(' ').includes('--resume'), 'no resume anywhere in argv');
    assert.equal(s.opts && s.opts.cwd, '/vault-xyz', 'the worker runs in the VAULT cwd');
    assert.ok(argv.includes('--strict-mcp-config'), 'strict mcp config');
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits');
    const framed = argv[argv.indexOf('-p') + 1];
    assert.match(framed, /A subtask was dispatched by an orchestrator/, 'the prompt is the orchestrator-framed subtask');
  }
});

test('_mkWorkerArgs: nonce-framed subtask only — acceptEdits + strict-mcp + intersected tools, no parent context', () => {
  const argv = council._mkWorkerArgs('do the thing', 'sonnet', ['Read', 'Grep', 'Glob'], 'abc123');
  assert.ok(!argv.includes('--resume') && !argv.includes('--continue'), 'no --resume/--continue');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(argv.includes('--strict-mcp-config'));
  assert.equal(argv[argv.indexOf('--allowedTools') + 1], 'Read,Grep,Glob');
  assert.match(argv[argv.indexOf('-p') + 1], /<<<abc123>>>[\s\S]*do the thing[\s\S]*<<<abc123>>>/);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// (4) SUMMARY-ONLY — the detached emit adapter appends to the jobstore log ONLY (never a voice/response writer)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
test('makeAsyncEmit is summary-only: appends EVERY event to the jobstore log, captures the synthesis, reaches NO voice writer', () => {
  const logs = [];
  const fakeStore = { appendLog: (id, line) => logs.push({ id, line }) };
  const sink = { answer: '', aborted: false, err: '' };
  const emit = ac.makeAsyncEmit(fakeStore, 'job-1', sink);
  emit({ ev: 'orchestrator.plan', subtasks: [] });
  emit({ ev: 'synthesis.delta', delta: 'partial' });
  emit({ ev: 'council.done', answer: 'the final synthesis', tokens: 42 });
  assert.equal(logs.length, 3, 'every event is appended to the NDJSON log');
  for (const l of logs) { assert.equal(l.id, 'job-1'); assert.match(l.line, /"id":"job-1"/); }
  assert.equal(sink.answer, 'the final synthesis', 'the synthesis is captured off council.done (what --result returns)');
  // STRUCTURAL: the adapter body can only reach jobstore.appendLog — it holds no response/voice writer.
  const body = ac.makeAsyncEmit.toString();
  assert.ok(/appendLog/.test(body), 'writes via jobstore.appendLog');
  assert.ok(!/sendSay|\bactive\b|res\.write|res\.end/.test(body), 'the emit adapter never touches a response/voice writer');
});

test('makeAsyncEmit captures abort + error signals (still no voice writer)', () => {
  const sink = { answer: '', aborted: false, err: '' };
  const emit = ac.makeAsyncEmit({ appendLog() {} }, 'x', sink);
  emit({ ev: 'council.aborted' });
  assert.equal(sink.aborted, true);
  emit({ ev: 'council.error', msg: 'boom' });
  assert.equal(sink.err, 'boom');
});

test('the council engine persists result:synth.slice(0,4000) via the injected store hook (what GET /council/:id/result reads)', async () => {
  const updates = [];
  const d = capDeps({ store: { update: (id, patch) => updates.push({ id, patch }) }, jobId: 'job-z', streamOne: async ({ onDelta }) => onDelta('the persisted synthesis') });
  await council.runCouncil('t', { agents: 1 }, () => {}, d);
  const u = updates.find((x) => x.id === 'job-z');
  assert.ok(u, 'the engine calls store.update(jobId, ...) — the crown-jewel hook reused unmodified');
  assert.equal(u.patch.state, 'done');
  assert.equal(u.patch.result, 'the persisted synthesis', 'the synthesis is persisted as result (summary-only, what --result serves)');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// (5) IMMEDIATE DETACH + PHONE-PUSH + LEDGER + FAIL-SOFT RELEASE
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
test('runDetached detaches immediately (stays pending until the council settles) then pushes a caveated speak:false summary + ledgers it', async () => {
  const logs = [], pushes = [], updates = [];
  let released = false, finish;
  const fakeStore = { appendLog: () => {}, update: (id, patch) => updates.push({ id, patch }) };
  const runCouncil = (task, opts, emit) => new Promise((res) => { finish = () => { emit({ ev: 'council.done', answer: 'the background answer' }); res({ answer: 'the background answer' }); }; });
  let settled = false;
  const p = ac.runDetached({
    runCouncil, task: 'audit', opts: { agents: 2 }, deps: {}, jobstore: fakeStore, id: 'job-9',
    notifyOwner: (text, o) => pushes.push({ text, o }), logEvent: (e) => logs.push(e),
    release: () => { released = true; },
  });
  p.then(() => { settled = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false, 'the detached run is still pending — the caller already replied 200 (immediate detach)');
  assert.equal(pushes.length, 0, 'no push before the council adjourns');
  finish();
  const sink = await p;
  assert.equal(sink.answer, 'the background answer');
  assert.equal(pushes.length, 1, 'exactly one phone push on completion');
  assert.equal(pushes[0].o.speak, false, 'the push is SILENT (speak:false)');
  assert.match(pushes[0].text, /background/i, 'the push says it ran in the background');
  assert.match(pushes[0].text, /unreviewed by you/i, 'the push carries the unreviewed-by-you caveat');
  assert.match(pushes[0].text, /the background answer/, 'the push carries the summary');
  assert.ok(pushes[0].text[0] !== '-', 'the caveat prefix means the push never starts with a "-" (arg-injection safe before notifyOwner even sanitizes)');
  assert.ok(logs.some((e) => e.ev === 'council_push' && e.id === 'job-9'), 'council_push is ledger-logged');
  assert.ok(logs.some((e) => e.ev === 'council_done' && e.source === 'async'), "council_done(source:'async') is ledger-logged");
  assert.ok(released, 'the single-flight is released in finally');
});

test('runDetached is fail-soft: a runCouncil throw still marks the record interrupted, pushes, ledgers ok:false, and releases (never wedges)', async () => {
  const logs = [], pushes = [], updates = [];
  let released = false;
  const fakeStore = { appendLog() {}, update: (id, patch) => updates.push({ id, patch }) };
  const runCouncil = async () => { throw new Error('engine exploded'); };
  const sink = await ac.runDetached({
    runCouncil, task: 't', opts: {}, deps: {}, jobstore: fakeStore, id: 'job-e',
    notifyOwner: (text, o) => pushes.push({ text, o }), logEvent: (e) => logs.push(e), release: () => { released = true; },
  });
  assert.ok(sink.err, 'the fault is captured');
  assert.ok(updates.some((u) => u.id === 'job-e' && u.patch.state === 'interrupted'), 'a throw marks the record interrupted');
  assert.ok(released, 'released even on a throw');
  assert.equal(pushes.length, 1, 'still phones the owner');
  assert.equal(pushes[0].o.speak, false);
  assert.ok(logs.some((e) => e.ev === 'council_done' && e.ok === false), "council_done logged ok:false on failure");
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// (6) ID-SCOPED CANCELLABILITY — SIGKILL the tracked children, mark interrupted, and never cancel the wrong council
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
test('makeAbort SIGKILLs every tracked worker, drops it from the shutdown-reaper set, and clears the tracking set', () => {
  const killed = [];
  const c1 = { kill: (sig) => killed.push('c1:' + sig) };
  const c2 = { kill: (sig) => killed.push('c2:' + sig) };
  const children = new Set([c1, c2]);
  const inflight = new Set([c1, c2]);
  ac.makeAbort(children, inflight)();
  assert.deepEqual(killed.sort(), ['c1:SIGKILL', 'c2:SIGKILL']);
  assert.equal(children.size, 0, 'the tracking set is cleared');
  assert.equal(inflight.size, 0, 'the workers are dropped from the shutdown reaper set');
});

test('makeAbort is fail-soft: a throwing kill does not stop the sweep', () => {
  const killed = [];
  const bad = { kill: () => { throw new Error('gone'); } };
  const good = { kill: () => killed.push('good') };
  const children = new Set([bad, good]);
  assert.doesNotThrow(ac.makeAbort(children, new Set()));
  assert.ok(killed.includes('good'), 'the second worker is still killed after the first throws');
  assert.equal(children.size, 0);
});

test('cancelDetached: a matching id fires the abort + marks interrupted + logs + 200; a wrong id is a 404 that touches nothing', () => {
  let aborted = 0;
  const updates = [], logs = [];
  const store = { update: (id, patch) => updates.push({ id, patch }) };
  const abort = () => { aborted++; };
  const wrong = ac.cancelDetached({ id: 'other', councilJobId: 'job-a', councilAbort: abort, jobstore: store, logEvent: (e) => logs.push(e) });
  assert.equal(wrong.code, 404); assert.equal(wrong.ok, false);
  assert.equal(aborted, 0, 'a non-matching id NEVER aborts the running council');
  assert.equal(updates.length, 0, 'a wrong id mutates no record');
  const hit = ac.cancelDetached({ id: 'job-a', councilJobId: 'job-a', councilAbort: abort, jobstore: store, logEvent: (e) => logs.push(e) });
  assert.equal(hit.code, 200); assert.equal(hit.ok, true);
  assert.equal(aborted, 1, 'the matching council is aborted (SIGKILLs its tracked children)');
  assert.ok(updates.some((u) => u.id === 'job-a' && u.patch.state === 'interrupted'), 'the record is marked interrupted');
  assert.ok(logs.some((e) => e.ev === 'council_cancel' && e.id === 'job-a' && e.ok === true), 'council_cancel is ledger-logged');
});

test('cancelDetached is a 404 when nothing is in flight (councilAbort null)', () => {
  const r = ac.cancelDetached({ id: 'job-a', councilJobId: 'job-a', councilAbort: null, jobstore: { update() {} }, logEvent() {} });
  assert.equal(r.code, 404);
  assert.equal(r.ok, false);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// (7) DURABILITY / HONESTY — reconcile flips a stale 'running' async council to 'interrupted' (NOT crash-immortal)
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
test('jobstore.reconcile flips a stale running async council to interrupted when its pid is gone (detach-honesty)', () => {
  const job = jobstore.create({ kind: 'council', source: 'async', task: 'bg', agents: 2 });
  try {
    jobstore.update(job.id, { state: 'running', pid: 999999999 });   // a pid that is not alive → process.kill(pid,0) throws ESRCH
    assert.equal(jobstore.isAlive(999999999), false, 'the stale pid is not alive');
    jobstore.reconcile();
    const j = jobstore.get(job.id);
    assert.equal(j.state, 'interrupted', 'a stale running council with a dead pid is reconciled to interrupted');
    assert.ok(j.endedAt, 'the reconciled record is stamped endedAt');
  } finally {
    try { fs.rmSync(path.join(jobstore.JOBS_DIR, job.id + '.json'), { force: true }); } catch {}
    try { fs.rmSync(path.join(jobstore.JOBS_DIR, job.id + '.log'), { force: true }); } catch {}
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
// (8) DAEMON WIRING: byte-identical default, off-`chain`, single-sourced deps, new endpoints, origin-clean
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════
test('POST /council: no async field → the EXACT existing sync `chain` path; {async:true} without the flag → 403 + enable hint', () => {
  const body = slice("} else if (req.method === 'POST' && req.url === '/council') {", "} else if (req.method === 'POST' && req.url === '/council/abort')");
  assert.match(body, /if \(parsed\.async && !ASYNC_COUNCIL_ON\)/, 'the 403 gate fires ONLY for an explicit async request with the flag off');
  assert.match(body, /writeHead\(403[\s\S]{0,220}URFAEL_COUNCIL_ASYNC=1/, 'the 403 carries the URFAEL_COUNCIL_ASYNC=1 enable hint');
  assert.match(body, /chain = chain\.then\(async \(\) => \{/, 'the sync path still serializes on `chain` (byte-identical default)');
  assert.match(body, /res\.end\(JSON\.stringify\(\{ id: job\.id, state: 'running', async: true \}\)\);\s*asyncCouncil\.runDetached\(/, 'replies 200 {id,state,async} THEN runs detached (immediate detach)');
  assert.match(body, /deps: councilDeps\(job\.id\)/, 'the detached run reuses the single-sourced councilDeps read-only floor');
  assert.match(body, /kind: 'council', source: 'async'/, "the record is marked source:'async'");
});

test('the detached run is OFF `chain` (fire-and-forget), and the councilInFlight 409 single-flight guards it too', () => {
  const body = slice("} else if (req.method === 'POST' && req.url === '/council') {", "} else if (req.method === 'POST' && req.url === '/council/abort')");
  const idxRun = body.indexOf('asyncCouncil.runDetached(');
  const idxChain = body.indexOf('chain = chain.then');
  const idx409 = body.indexOf('a council is already in session');
  assert.ok(idxRun >= 0 && idxChain >= 0 && idx409 >= 0);
  assert.ok(idxRun < idxChain, 'the detached run is emitted BEFORE (and outside) the sync chain.then — it never joins `chain`');
  assert.ok(idx409 < idxRun, 'the councilInFlight 409 guards the async branch as well (one council at a time)');
  assert.match(body, /councilJobId = job\.id/, 'the async branch id-scopes the council for /council/:id/cancel');
});

test('GET /council/:id/result + POST /council/:id/cancel reuse the replay-style url regex, kind-validate, and id-scope', () => {
  const region = slice("} else if (req.url && /^\\/council\\/[A-Za-z0-9-]{4,64}\\/replay$/", "} else if (req.method === 'POST' && req.url === '/abort')");
  // GET /result → {id,state,answer} from the persisted synthesis
  assert.match(region, /\/result\$\/\.test\(req\.url\)/, 'the /result route reuses the replay-style url regex');
  assert.match(region, /j\.kind !== 'council'/, 'result validates kind:council');
  assert.match(region, /answer: j\.result \|\| ''/, 'result returns the persisted synthesis (summary-only)');
  // POST /cancel → id-scoped cancelDetached
  assert.match(region, /\/cancel\$\/\.test\(req\.url\)/, 'the /cancel route reuses the replay-style url regex');
  assert.match(region, /asyncCouncil\.cancelDetached\(\{ id: cid, councilJobId, councilAbort/, 'cancel is id-scoped through cancelDetached');
});

test('the daemon wires notifyOwner (the sanitizer) into the detached push — never a hand-rolled notifier', () => {
  const body = slice("} else if (req.method === 'POST' && req.url === '/council') {", "} else if (req.method === 'POST' && req.url === '/council/abort')");
  assert.match(body, /notifyOwner,/, 'runDetached receives the daemon notifyOwner');
  assert.match(AC_SRC, /notifyOwner\(/, 'the detached driver pushes via notifyOwner');
  assert.ok(!/spawn\(|osascript|\/usr\/bin\/say|notify-send/.test(AC_SRC), 'the detached driver never hand-rolls the notifier (reuses the daemon sanitizer)');
});

test('no origin-reveal comment leaks into the gate or the detached driver', () => {
  const SLUG = 'NousResearch' + '/hermes-agent';
  assert.ok(!AC_SRC.includes(SLUG), 'engine/async-council.js carries no origin-reveal comment');
  const idx = LIB_SRC.indexOf('function asyncCouncilGate');
  assert.ok(idx > 0);
  assert.ok(!LIB_SRC.slice(idx - 400, idx).includes(SLUG), 'asyncCouncilGate carries no origin-reveal comment');
});

test('the async boot flag reads the env via the shared gate (default OFF), next to MOA_BRAIN_ON', () => {
  assert.match(DAEMON_SRC, /const ASYNC_COUNCIL_ON = asyncCouncilGate\(process\.env\)/, 'the daemon derives ASYNC_COUNCIL_ON from the pure gate');
  assert.match(DAEMON_SRC, /let councilJobId = null;/, 'councilJobId id-scopes the in-flight council');
});

// ── zero-dep invariant: app/package.json dependencies stays exactly {} ──
test('app/package.json dependencies is exactly {} (no new package, Node built-ins only)', () => {
  assert.deepEqual(require('../package.json').dependencies, {}, 'the runtime dependency set must stay empty');
});
