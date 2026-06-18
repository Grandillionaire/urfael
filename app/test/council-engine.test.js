'use strict';
// Tests for the Council engine's PURE, safety-critical functions — no spawn, no LLM.
const { test } = require('node:test');
const assert = require('node:assert');
const c = require('../council');

test('clampAgents: bounds to 1..6, defaults bad input to 3', () => {
  assert.equal(c.clampAgents('9'), 6);
  assert.equal(c.clampAgents('0'), 1);
  assert.equal(c.clampAgents(-5), 1);
  assert.equal(c.clampAgents('foo'), 3);
  assert.equal(c.clampAgents(undefined), 3);
  assert.equal(c.clampAgents('4'), 4);
});

test('intersectTools (the safety crown jewel): NARROW-ONLY, can never add Write/Edit/Bash, never returns []', () => {
  // a planner asking for write/shell/edit gets only what the read-only floor allows
  assert.deepEqual(c.intersectTools(['Read', 'Write', 'Bash', 'Edit'], ['Read', 'Grep', 'Glob']).sort(), ['Read']);
  // empty/garbage request → fail-closed to the floor, never []
  assert.deepEqual(c.intersectTools([], ['Read', 'Grep', 'Glob']), ['Read', 'Grep', 'Glob']);
  assert.deepEqual(c.intersectTools(null, ['Read', 'Grep', 'Glob']), ['Read', 'Grep', 'Glob']);
  // can NEVER exceed the floor
  assert.ok(c.intersectTools(['WebFetch', 'Write'], ['Read', 'Grep', 'Glob']).every((t) => ['Read', 'Grep', 'Glob'].includes(t)));
  // in full mode the floor includes web — then a web request is honoured (still a subset)
  assert.deepEqual(c.intersectTools(['WebFetch', 'Read', 'Bash'], ['Read', 'Grep', 'Glob', 'WebFetch']).sort(), ['Read', 'WebFetch']);
});

test('_parsePlan: parses good JSON, clamps to the cap, FAIL-CLOSES to one raw-task subtask on garbage', () => {
  const good = c._parsePlan('noise {"plan":"approach","subtasks":[{"title":"a","prompt":"do a"},{"title":"b","prompt":"do b"}]} trailing', 'TASK', 6);
  assert.equal(good.plan, 'approach');
  assert.equal(good.subtasks.length, 2);
  // bad JSON → exactly one subtask whose prompt is the raw task
  const bad = c._parsePlan('totally not json', 'TASK', 3);
  assert.equal(bad.subtasks.length, 1);
  assert.equal(bad.subtasks[0].prompt, 'TASK');
  // 9 subtasks clamped to the cap
  const many = c._parsePlan(JSON.stringify({ plan: 'p', subtasks: Array.from({ length: 9 }, (_, i) => ({ title: 't' + i, prompt: 'p' + i })) }), 'TASK', 4);
  assert.equal(many.subtasks.length, 4);
  // a subtask missing a prompt is dropped
  const drop = c._parsePlan(JSON.stringify({ plan: 'p', subtasks: [{ title: 'x' }, { title: 'y', prompt: 'has' }] }), 'TASK', 6);
  assert.equal(drop.subtasks.length, 1);
  assert.equal(drop.subtasks[0].prompt, 'has');
});

test('_mkWorkerArgs: streams, never bypasses, nonce-frames, and never grants Write/Edit/Bash', () => {
  const args = c._mkWorkerArgs('summarise the repo', 'sonnet', ['Read', 'Grep', 'Glob'], 'NONCE123');
  assert.ok(args.includes('stream-json') && args.includes('--include-partial-messages'), 'streams');
  assert.ok(args.includes('--strict-mcp-config'), 'strict mcp');
  const pm = args[args.indexOf('--permission-mode') + 1];
  assert.equal(pm, 'acceptEdits');
  assert.ok(!args.includes('bypassPermissions') && !args.includes('--dangerously-skip-permissions'), 'never bypass');
  const allowed = args[args.indexOf('--allowedTools') + 1];
  assert.ok(!/Write|Edit|Bash/.test(allowed), 'no write/edit/shell in the allowlist');
  const prompt = args[args.indexOf('-p') + 1];
  assert.ok(prompt.includes('<<<NONCE123>>>') && (prompt.match(/<<<NONCE123>>>/g) || []).length === 2, 'nonce-framed on both sides');
});
