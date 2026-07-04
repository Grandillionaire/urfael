'use strict';
// Adversarial unit tests for native subagent DELEGATION (engine/delegate.js + the `delegate` tool in tools.js).
//
// The crown-jewel property mirrors council.intersectTools: a spawned sub-agent runs the SAME fail-closed toolset but
// NARROWED to a read-only floor (read_file/list_dir/grep/find_files/recall), can NEVER gain write/edit/remember/
// exec_shell/delegate, and has NO `delegate` of its own (no recursion). These tests attack that: they assert the
// mutating tools are ABSENT from the sub defs AND denied at dispatch AND never touch disk, that recursion is
// impossible, and that every failure is a fail-soft string (never a throw). Driven with a scripted fake adapter and
// the REAL toolset over a temp vault — no network, no `claude`.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createToolset } = require('../engine/tools');
const { makeDelegate, readOnlyToolset, READ_ONLY_TOOLS } = require('../engine/delegate');

// a scripted adapter that also records the FULL messages it saw each call (so we can prove the tool_result flowed).
function scriptedAdapter(script) {
  const seenFull = [];
  return {
    seenFull,
    chat: async (opts) => {
      seenFull.push(opts.messages.map((m) => ({ role: m.role, content: m.content })));
      if (typeof opts.onDelta === 'function' && script[0] && script[0].text) opts.onDelta(script[0].text);
      const r = script.shift();
      return r || { ok: true, text: '', toolCalls: [], usage: { inTok: 1, outTok: 1 }, stopReason: 'stop' };
    },
  };
}
function vault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urf-deleg-'));
  fs.writeFileSync(path.join(dir, 'note.md'), 'the answer is 42');
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

// (a) delegate returns the sub-agent's synthesized result, and the REAL file body flows through the sub tool_result.
test('(a) runSub drives a read → answer cycle and returns the sub-agent\'s synthesized result', async () => {
  const v = vault();
  const adapter = scriptedAdapter([
    { ok: true, text: '', toolCalls: [{ id: 'c1', name: 'read_file', args: '{"path":"note.md"}' }], usage: {}, stopReason: 'tool_calls' },
    { ok: true, text: 'SUBRESULT', toolCalls: [], usage: {}, stopReason: 'stop' },
  ]);
  const runSub = makeDelegate({ toolsetCfg: { vaultDir: v.dir }, adapter, modelCfg: { model: 'm' }, maxSteps: 4 });
  const out = await runSub('summarize note.md');
  assert.strictEqual(out, 'SUBRESULT');
  // the second model call must have SEEN the real tool_result content (the file body flowed through the sub)
  const secondCall = adapter.seenFull[1];
  assert.ok(secondCall.some((m) => m.role === 'tool' && m.content === 'the answer is 42'), 'the real file body must reach the sub tool_result');
  v.cleanup();
});

// (a') the delegate TOOL end to end: it appears in defs when runSub is injected, and routes to it.
test('(a\') the delegate tool is advertised when runSub is injected and returns runSub\'s result', async () => {
  const v = vault();
  const ts = createToolset({ vaultDir: v.dir, runSub: async (task) => 'SUB:' + task });
  assert.ok(ts.defs.some((d) => d.name === 'delegate'), 'delegate must be advertised when runSub is injected');
  assert.strictEqual(await ts.dispatch('delegate', { task: 'find X' }), 'SUB:find X');
  assert.match(await ts.dispatch('delegate', { task: '   ' }), /refused: empty task/);
  v.cleanup();
});

// (b) the sub tool defs contain NONE of write/edit/remember/shell/delegate — a subset of the read-only floor.
test('(b) a sub-agent\'s tool defs are a subset of the read-only floor (no write/edit/remember/shell/delegate)', () => {
  const v = vault();
  const sub = readOnlyToolset({ vaultDir: v.dir, recall: async () => 'x' });
  const names = sub.defs.map((d) => d.name);
  assert.ok(names.every((n) => READ_ONLY_TOOLS.includes(n)), 'every sub def must be in the read-only allowlist');
  for (const forbidden of ['write_file', 'edit_file', 'remember', 'exec_shell', 'delegate']) {
    assert.ok(!names.includes(forbidden), forbidden + ' must be ABSENT from a sub-agent');
  }
  for (const req of ['read_file', 'list_dir', 'grep', 'find_files']) {
    assert.ok(names.includes(req), 'the read floor must always include ' + req);
  }
  assert.ok(names.includes('recall'), 'recall carries through when the parent had it');
  v.cleanup();
});

// (c) a sub-agent WRITE attempt is denied at dispatch AND nothing hits disk (double-gate). Same for edit/remember/shell.
test('(c) a sub-agent cannot write/edit/remember/exec_shell — denied, and no file is created', async () => {
  const v = vault();
  const sub = readOnlyToolset({ vaultDir: v.dir });
  const w = await sub.dispatch('write_file', { path: 'pwn.md', content: 'y' });
  assert.match(w, /denied: subagent is read-only/);
  assert.ok(!fs.existsSync(path.join(v.dir, 'pwn.md')), 'the sub write must never reach disk');
  assert.match(await sub.dispatch('edit_file', { path: 'note.md', find: 'the', replace: 'X' }), /denied: subagent is read-only/);
  assert.match(await sub.dispatch('remember', { note: 'x' }), /denied: subagent is read-only/);
  assert.match(await sub.dispatch('exec_shell', { command: 'id' }), /denied: subagent is read-only/);
  // and a legitimate read still works — the floor is fail-closed but usable
  assert.strictEqual(await sub.dispatch('read_file', { path: 'note.md' }), 'the answer is 42');
  v.cleanup();
});

// (d) NO recursion: a sub-agent has no delegate tool, and dispatching delegate on it is denied.
test('(d) no recursion — delegate is absent from a sub-agent and denied at dispatch', async () => {
  const v = vault();
  const sub = readOnlyToolset({ vaultDir: v.dir });
  assert.ok(!sub.defs.some((d) => d.name === 'delegate'), 'a sub-agent must not have a delegate tool');
  assert.match(await sub.dispatch('delegate', { task: 'recurse' }), /denied: subagent is read-only/);
  v.cleanup();
});

// (e) a delegate error is a NORMAL tool_result, never a throw.
test('(e) a throwing runSub becomes a normal delegate tool_result (no throw)', async () => {
  const v = vault();
  const ts = createToolset({ vaultDir: v.dir, runSub: async () => { throw new Error('boom'); } });
  const r = await ts.dispatch('delegate', { task: 'x' });   // must RESOLVE, not reject
  assert.match(r, /delegate error/);
  v.cleanup();
});

// (e') runSub over a failing adapter is a fail-soft string.
test('(e\') runSub over an adapter that returns {ok:false} yields a fail-soft string', async () => {
  const v = vault();
  const adapter = { chat: async () => ({ ok: false, error: 'endpoint 503', usage: {}, stopReason: 'error' }) };
  const runSub = makeDelegate({ toolsetCfg: { vaultDir: v.dir }, adapter, modelCfg: { model: 'm' } });
  const out = await runSub('do a thing');
  assert.match(out, /subagent could not complete/);
  v.cleanup();
});

// (e'') runSub with an empty task fails soft without building an engine.
test('(e\'\') runSub refuses an empty task fail-soft', async () => {
  const runSub = makeDelegate({ toolsetCfg: {}, adapter: { chat: async () => ({ ok: true, text: 'x' }) }, modelCfg: {} });
  assert.match(await runSub('   '), /subagent could not complete: empty task/);
});

// (f) GATING / byte-identical: a toolset built WITHOUT runSub has NO delegate def, and dispatching it is unavailable.
test('(f) no runSub injected ⇒ no delegate def (byte-identical default)', async () => {
  const v = vault();
  const ts = createToolset({ vaultDir: v.dir });
  assert.ok(!ts.defs.some((d) => d.name === 'delegate'), 'delegate must be absent unless runSub is injected');
  assert.strictEqual(await ts.dispatch('delegate', { task: 'x' }), 'delegate unavailable');
  v.cleanup();
});

// (g) NARROW-ONLY: a sub built from a parent with NO recall has no recall def (subset of the parent).
test('(g) narrow-only — a sub without a parent recall has no recall def', () => {
  const v = vault();
  const sub = readOnlyToolset({ vaultDir: v.dir });   // no recall injected
  assert.ok(!sub.defs.some((d) => d.name === 'recall'), 'recall must NOT appear when the parent had none (subset-correct)');
  // but the read floor is still present and non-empty (fail-closed but usable)
  assert.ok(sub.defs.length >= 4 && sub.defs.every((d) => READ_ONLY_TOOLS.includes(d.name)));
  v.cleanup();
});

// (h) the sub inherits the SAME containment: a ../ traversal or an out-of-vault read is denied inside the sub too.
test('(h) a sub-agent inherits the same fail-closed containment (traversal denied)', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'urf-deleg2-'));
  const vlt = path.join(base, 'vault'); fs.mkdirSync(vlt);
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOPSECRET');
  const sub = readOnlyToolset({ vaultDir: vlt });
  const r = await sub.dispatch('read_file', { path: '../outside/secret.txt' });
  assert.match(r, /denied: outside/);
  assert.ok(!r.includes('TOPSECRET'));
  fs.rmSync(base, { recursive: true, force: true });
});
