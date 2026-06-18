'use strict';
// Drives the WHOLE Council protocol with a FAKE spawn + fake planner/synthesis — zero real turns — and asserts
// the event sequence + invariants (the orchestrator↔worker round-trip the feature is built to make watchable).
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { runCouncil } = require('../council');
const view = require('../council-view');

// a fake worker process that emits canned stream-json then exits
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => {
    child.stdout.emit('data', Buffer.from('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello "}}}\n'));
    child.stdout.emit('data', Buffer.from('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}}\n'));
    child.stdout.emit('data', Buffer.from('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Grep"}]}}\n'));
    child.stdout.emit('data', Buffer.from('{"type":"result","result":"hello world","usage":{"input_tokens":10,"output_tokens":5}}\n'));
    child.emit('exit', 0);
  });
  return child;
}

function deps() {
  return {
    spawn: () => fakeChild(), CLAUDE_BIN: 'claude', VAULT: '/tmp', scopedEnv: () => ({}),
    classifyModel: () => 'sonnet', OPUS: 'opus',
    budgetWindow: () => ({ state: { level: 'ok' }, limits: { hard: false } }),
    inflightScoped: new Set(), store: null, jobId: null, _children: new Set(),
    oneShot: async () => '{"plan":"split it","subtasks":[{"title":"a","prompt":"do a","tools":["Read","Write","Bash"]},{"title":"b","prompt":"do b"}]}',
    streamOne: async ({ onDelta }) => { onDelta('final '); onDelta('answer'); },
  };
}

test('runCouncil emits a complete, ordered, round-trip-correct protocol', async () => {
  const ev = [];
  const r = await runCouncil('do the thing', { agents: 2 }, (e) => ev.push(e), deps());
  const kinds = ev.map((e) => e.ev);
  // exactly one start and one terminal done
  assert.equal(kinds.filter((k) => k === 'council.start').length, 1);
  assert.equal(kinds.filter((k) => k === 'council.done').length, 1);
  // ordering: start → plan → dispatch → agent.* → synthesis.start → synthesis.delta → done
  assert.ok(kinds.indexOf('council.start') < kinds.indexOf('orchestrator.plan'));
  assert.ok(kinds.indexOf('orchestrator.plan') < kinds.indexOf('orchestrator.dispatch'));
  assert.ok(kinds.lastIndexOf('agent.done') < kinds.indexOf('synthesis.start'));
  assert.ok(kinds.indexOf('synthesis.start') < kinds.indexOf('council.done'));
  // the plan declared the worker ids
  const plan = ev.find((e) => e.ev === 'orchestrator.plan');
  const ids = new Set(plan.subtasks.map((s) => s.id));
  assert.deepEqual([...ids].sort(), ['w0', 'w1']);
  // every dispatch.to and agent.* id is a declared worker; every dispatch has a matching agent.done
  const dispatches = ev.filter((e) => e.ev === 'orchestrator.dispatch');
  const dones = ev.filter((e) => e.ev === 'agent.done');
  for (const d of dispatches) { assert.ok(ids.has(d.to)); assert.ok(dones.some((x) => x.id === d.to), 'round-trip: ' + d.to + ' completed'); }
  for (const e of ev.filter((x) => /^agent\./.test(x.ev))) assert.ok(ids.has(e.id));
  // THE WEDGE + THE SANDBOX in one: each dispatch carries the prompt AND a tools subset of the read-only floor
  for (const d of dispatches) {
    assert.ok(typeof d.prompt === 'string' && d.prompt.length, 'dispatch carries the subtask prompt');
    assert.ok(d.tools.every((t) => ['Read', 'Grep', 'Glob'].includes(t)), 'tools narrowed to the read-only floor (Write/Bash dropped)');
  }
  // the final synthesized answer is returned + emitted
  assert.equal(r.answer, 'final answer');
  assert.equal(ev.find((e) => e.ev === 'council.done').answer, 'final answer');
});

test('budget hard-gate: refuses before any spend', async () => {
  const ev = [];
  const d = deps(); d.budgetWindow = () => ({ state: { level: 'over' }, limits: { hard: true, windowH: 24 } });
  const r = await runCouncil('x', { agents: 2 }, (e) => ev.push(e), d);
  assert.equal(r.ok, false);
  assert.ok(ev.some((e) => e.ev === 'council.error' && e.reason === 'budget'));
  assert.ok(!ev.some((e) => e.ev === 'orchestrator.dispatch'), 'no worker was ever dispatched');
});

test('council-view reduce(): builds the round-table state from the event stream', () => {
  let s = view.newState();
  const feed = [
    { ev: 'council.start', task: 'T' },
    { ev: 'orchestrator.plan', plan: 'split it', subtasks: [{ id: 'w0', title: 'a' }, { id: 'w1', title: 'b' }] },
    { ev: 'orchestrator.dispatch', to: 'w0', prompt: 'do a', tools: ['Read'] },
    { ev: 'agent.delta', id: 'w0', delta: 'partial ' }, { ev: 'agent.tool', id: 'w0', tool: 'Grep' },
    { ev: 'agent.done', id: 'w0', result: 'line one\nfinal w0', tokens: 12, ok: true },
    { ev: 'synthesis.start' }, { ev: 'synthesis.delta', delta: 'the ' }, { ev: 'synthesis.delta', delta: 'answer' },
    { ev: 'council.done', ms: 1234, tokens: 50, answer: 'the answer' },
  ];
  for (const e of feed) view.reduce(s, e);
  assert.equal(s.workers.length, 2);
  assert.equal(s.workers[0].status, 'done');
  assert.equal(s.workers[0].tokens, 12);
  assert.equal(s.workers[0].tail, 'final w0');         // last line of the result
  assert.equal(s.head.phase, 'done');
  assert.equal(s.answer, 'the answer');
  // the composer yields exactly rows×cols, never overflowing a small terminal
  const themer = require('../tui-theme');
  const TH = themer.resolveTheme({ TERM: 'xterm-256color' }, true);
  const rend = require('../tui-render');
  for (const [cols, rows] of [[80, 24], [40, 10], [120, 30]]) {
    const frame = view.composeCouncil(s, { cols, rows }, TH);
    assert.equal(frame.length, rows);
    for (const r of frame) assert.equal(rend.visLen(r), cols);
  }
});
