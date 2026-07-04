'use strict';
// app/engine/delegate.js — the native engine's bounded, READ-ONLY subagent delegation.
//
// WHAT THIS IS (honest): an IN-PROCESS sub-loop. The `delegate` tool lets the native agent spawn ONE bounded
// sub-task that runs its own createEngine loop against the SAME adapter/model, on the SAME fail-closed toolset —
// but NARROWED to a read-only floor — and returns the sub-agent's text as a normal tool_result the parent receives.
// It shares the daemon's event loop (not a separate process or sandbox) and is bounded by SUB_MAX_STEPS/maxBytes and
// the same walk budgets as any other tool call. It is NOT an independent security review of the sub-agent's work.
//
// CROWN-JEWEL SECURITY PROPERTY (mirror of council.intersectTools):
//   • NARROW-ONLY / SUBSET. READ_ONLY_TOOLS is an ALLOWLIST intersected against the parent-produced defs, so the
//     sub-toolset can only ever be a SUBSET of the parent's READ tools. It can NEVER gain write_file/edit_file.
//   • STRUCTURALLY read-only. readOnlyToolset builds createToolset from a REDUCED cfg that OMITS appendMemory,
//     allowShell, runShell, and runSub — so remember, exec_shell, and delegate are ABSENT (not merely unadvertised).
//   • DOUBLE-GATE. dispatch also refuses any name outside the allowlist, so even a hand-forged tool_use for
//     write_file (or delegate) is denied at the door.
//   • NO RECURSION / MAX 1 LEVEL, enforced STRUCTURALLY: the sub has no runSub, therefore no `delegate` tool, so it
//     cannot spawn another sub-agent. This is stronger than a depth counter.
//   • FAIL-CLOSED but USABLE. The read floor (read_file/list_dir/grep/find_files) is always present, so the
//     intersection is never empty. recall carries through IFF the parent had it (subset-correct).
//   • FUTURE-PROOF INVARIANT: READ_ONLY_TOOLS MUST stay an ALLOWLIST. Any new tool another feature adds to tools.js
//     is EXCLUDED from sub-agents by default; only add a name here if it is genuinely read-only.
//   • SINGLE PROVIDER. The sub binds the ONE adapter/modelCfg that spawned it — never a fallback chain (a sub gaining
//     alternate providers/keys would violate narrow-only). fallback is not a tool and must not reach a sub.
//
// FAIL-SOFT: runSub wraps its whole body in try/catch and returns a string; createEngine.run never rejects; the
// `delegate` tool in tools.js wraps runSub again. A delegate failure is ALWAYS a tool_result string, never a throw.

const { createToolset } = require('./tools');
const { createEngine } = require('./loop');

// The read-only floor a sub-agent may EVER be shown — an ALLOWLIST (the intersectTools mirror), never a denylist.
const READ_ONLY_TOOLS = ['read_file', 'list_dir', 'grep', 'find_files', 'recall'];

const SUB_MAX_STEPS = 4;         // small: a sub-task is a focused lookup, not a full session
const SUB_MAX_TOKENS = 1024;     // per-call output cap for the sub-loop

const SUB_SYSTEM =
  'You are a bounded, READ-ONLY sub-agent spawned to handle ONE focused sub-task. You can only read and search files ' +
  'and recall prior memory — you cannot write, edit, remember, run shells, or delegate further. Complete the sub-task ' +
  'and reply with a concise, self-contained result the caller can use directly.';

// readOnlyToolset(cfg) -> a toolset object { defs, dispatch, guardPath } narrowed to READ_ONLY_TOOLS.
// It reuses the SAME createToolset code over the SAME roots/denyGlobs/maxBytes as the parent, so guardPath / the
// allowlist-root boundary / deny-first credential globs / the symlink re-check / the write-deny control surface all
// hold identically. It just OMITS every mutating injection and intersects the defs down to the read floor.
function readOnlyToolset(cfg) {
  cfg = cfg || {};
  // REDUCED cfg: forward the file roots + recall + the containment knobs ONLY. Deliberately OMIT appendMemory,
  // allowShell, runShell, and runSub → remember / exec_shell / delegate are STRUCTURALLY ABSENT from the sub.
  const full = createToolset({
    vaultDir: cfg.vaultDir, memoryDir: cfg.memoryDir, workspaceDir: cfg.workspaceDir,
    recall: cfg.recall, denyGlobs: cfg.denyGlobs, maxBytes: cfg.maxBytes, now: cfg.now,
  });
  // ALLOWLIST intersection over the parent's produced defs (council.intersectTools, empty-set-safe): the sub is a
  // provable SUBSET of the parent read tools. recall survives IFF the parent produced it; the read floor always does.
  const defs = full.defs.filter((d) => READ_ONLY_TOOLS.includes(d.name));
  // DOUBLE-GATE: refuse any non-read tool name at dispatch, so a hand-forged tool_use can't reach a mutating impl.
  async function dispatch(name, args) {
    if (!READ_ONLY_TOOLS.includes(name)) return 'denied: subagent is read-only';
    return full.dispatch(name, args);
  }
  return { defs, dispatch, guardPath: full.guardPath, _shellOn: false };
}

// makeDelegate({ toolsetCfg, adapter, modelCfg, maxSteps, now }) -> async runSub(task).
// Bound the sub to the ONE adapter/modelCfg passed in (the provider that spawned it). runSub NEVER throws.
function makeDelegate(deps) {
  deps = deps || {};
  const toolsetCfg = deps.toolsetCfg || {};
  const adapter = deps.adapter;
  const modelCfg = deps.modelCfg || {};
  const subSteps = deps.maxSteps || SUB_MAX_STEPS;
  const now = deps.now;

  return async function runSub(task) {
    try {
      const t = String(task == null ? '' : task).trim();
      if (!t) return 'subagent could not complete: empty task';
      const subToolset = readOnlyToolset(toolsetCfg);
      // Fresh sub-loop: NO compactor, NO onDelta (the sub does not stream to the HUD), NO selfReview, NO runSub
      // (⇒ no recursion). Same adapter/model/credential as the parent — a sub can never route to another provider.
      const sub = createEngine({
        adapter, toolset: subToolset,
        model: modelCfg.model, apiKey: modelCfg.apiKey, baseUrl: modelCfg.baseUrl,
        maxSteps: subSteps, maxTokens: SUB_MAX_TOKENS, now,
      });
      const messages = [
        { role: 'system', content: SUB_SYSTEM },
        { role: 'user', content: t },
      ];
      const r = await sub.run(messages);
      if (r && r.ok && typeof r.text === 'string' && r.text.trim()) return r.text.trim();
      return 'subagent could not complete: ' + ((r && r.error) || 'no result');
    } catch (e) {
      return 'subagent could not complete: ' + String((e && e.message) || e);
    }
  };
}

module.exports = { makeDelegate, readOnlyToolset, READ_ONLY_TOOLS, SUB_MAX_STEPS, SUB_MAX_TOKENS };
