'use strict';
// app/engine/loop.js — the native-engine conversation loop.
//
// This is Urfael's OWN agent loop, the thing that exists only because we own the window now (the CLI engine in
// app/session.js delegates the loop to the `claude` binary). It ties the three native pieces together:
//   adapter (openai|anthropic) → toolset (fail-closed) → compactor (Hermes-pattern), and runs the standard
//   call → tool_use → tool_result → call cycle until the model stops or a step/token bound trips.
//
// Design rules (match the rest of the daemon):
//   • BOUNDED — maxSteps caps the tool cycle so a model that loops on tools can't run forever; every result is a
//     visible stop, never a hang.
//   • FAIL-CLOSED / NEVER THROW — an adapter error ends the run with {ok:false, error}; a tool that "fails" returns
//     its refusal string as a normal tool_result the model can react to. The run() promise never rejects.
//   • COMPACT BEFORE EACH MODEL CALL — so a long tool cycle can't blow the window mid-run.
//   • STREAM-THROUGH — onDelta/onThinking fire as tokens arrive, so the daemon can pipe them to the HUD exactly
//     like the CLI engine's stream-json deltas.
//   • the message history is OWNED by the caller: run() returns the full updated history so the daemon can persist
//     it to the session archive, exactly as it archives CLI turns.
//
// createEngine(cfg) -> { run }.  cfg = { adapter, toolset, compactor?, model, apiKey?, baseUrl?, maxTokens?,
//   maxSteps?, temperature?, onDelta?(text), onThinking?(text), now? }

const { createHash } = require('node:crypto');
const { runReview } = require('./review');

const DEFAULT_MAX_STEPS = 8;          // model→tools→model cycles per user turn
const DEFAULT_MAX_TOKENS = 4096;      // per-call output budget
const LOOP_REPEAT_LIMIT = 3;          // same tool call this many times in one turn ⇒ break the tool loop (deer-flow)

// deterministic order-independent JSON so {a:1,b:2} and {b:2,a:1} hash identically.
function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
// hash(toolName + sortedArgs) — the identity of a tool call for loop detection. Borrowed from bytedance/deer-flow
// (MIT): its graph guards against an agent that re-issues the same call forever. Args that don't parse hash by raw.
function toolCallHash(name, argsStr) {
  let obj;
  try { obj = argsStr ? JSON.parse(argsStr) : {}; } catch { obj = { __raw: String(argsStr == null ? '' : argsStr) }; }
  return createHash('sha1').update(String(name || '') + '\u0000' + stableStringify(obj)).digest('hex');
}

function createEngine(cfg) {
  cfg = cfg || {};
  const adapter = cfg.adapter;
  const toolset = cfg.toolset;
  const compactor = cfg.compactor || null;
  if (!adapter || typeof adapter.chat !== 'function') throw new Error('engine needs an adapter');
  if (!toolset || typeof toolset.dispatch !== 'function') throw new Error('engine needs a toolset');

  // run(history, opts) — advance ONE user turn to completion. `history` is the full engine-neutral message list
  // (system + prior turns + the new user message already appended). Returns the updated history + the final text.
  async function run(history, opts = {}) {
    const messages = Array.isArray(history) ? history.slice() : [];
    const maxSteps = opts.maxSteps || cfg.maxSteps || DEFAULT_MAX_STEPS;
    const signal = opts.signal;
    const usage = { inTok: 0, outTok: 0 };
    let steps = 0;
    let finalText = '';
    // deer-flow loop guard (per-turn): tally identical tool calls; on the 3rd repeat, deny further tools and force a
    // final text answer. Fail-closed: it only ever RESTRICTS. lastInputTokens carries the model's authoritative input
    // token count into the NEXT compaction trigger (change C); 0 until the first call, where the estimate is used.
    const loopCounts = new Map();
    let denyTools = false, loopBroken = false, lastInputTokens = 0;

    for (steps = 0; steps < maxSteps; steps++) {
      if (signal && signal.aborted) return result(false, 'aborted', 'aborted');

      // compact before every model call so a long tool cycle can't overflow the window mid-run. contextWindow is the
      // model's TOTAL usable window (what the compactor triggers against) — distinct from maxTokens, the per-call
      // OUTPUT budget below. Conflating them made the compactor treat a 4k output cap as a 4k window and thrash.
      if (compactor) {
        try {
          const c = await compactor.maybeCompact(messages, { maxTokens: cfg.contextWindow || 32000, measuredInputTokens: lastInputTokens || undefined, ...(opts.compact || {}) });
          if (c.compacted) { messages.length = 0; messages.push(...c.messages); }
        } catch { /* compaction is best-effort; a bug there must never fail the turn */ }
      }

      // adapter.chat never rejects (its executor is try-wrapped), but guard the await anyway — a rejected turn must
      // never escape run() into the daemon's shared chain.
      let res;
      try {
        res = await adapter.chat({
          baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
          messages, tools: denyTools ? [] : toolset.defs,   // loop broken ⇒ deny tools so the model must answer in text
          maxTokens: cfg.maxTokens || DEFAULT_MAX_TOKENS,   // per-call OUTPUT budget only
          temperature: cfg.temperature,
          onDelta: (t) => { finalText += t; if (typeof cfg.onDelta === 'function') { try { cfg.onDelta(t); } catch {} } },
          signal,
        });
      } catch (e) { return result(false, String((e && e.message) || e), 'error'); }

      const inTokThis = res.usage ? res.usage.inTok | 0 : 0;
      usage.inTok += inTokThis;
      usage.outTok += res.usage ? res.usage.outTok | 0 : 0;
      if (inTokThis > 0) lastInputTokens = inTokThis;   // authoritative size of THIS call ⇒ next compaction trigger (change C)

      if (!res.ok) return result(false, res.error || 'engine error', res.stopReason || 'error');

      // Honor tool calls only while tools are allowed. Once the loop guard has denied tools (denyTools), any residual
      // tool_calls from a misbehaving adapter are ignored and we take the model's text as the final answer — the guard
      // only ever RESTRICTS.
      if (res.stopReason === 'tool_calls' && res.toolCalls && res.toolCalls.length && !denyTools) {
        // record the assistant turn (its text, if any, + the tool calls) then run each tool and append results
        messages.push({ role: 'assistant', content: res.text || '', toolCalls: res.toolCalls });
        let looped = false;
        for (const call of res.toolCalls) {
          if (signal && signal.aborted) return result(false, 'aborted', 'aborted');
          // deer-flow guard: tally this call's identity; the 3rd identical one trips the break (still dispatched so
          // the assistant tool_use keeps a matching tool_result — a valid history — then tools are denied next call).
          const h = toolCallHash(call.name, call.args);
          const n = (loopCounts.get(h) || 0) + 1; loopCounts.set(h, n);
          if (n >= LOOP_REPEAT_LIMIT) looped = true;
          let args = {};
          try { args = call.args ? JSON.parse(call.args) : {}; } catch { /* malformed tool args → empty; the tool guards */ }
          if (typeof cfg.onThinking === 'function') { try { cfg.onThinking('· ' + call.name); } catch {} }
          const content = await toolset.dispatch(call.name, args);
          messages.push({ role: 'tool', toolCallId: call.id, content: String(content == null ? '' : content) });
        }
        if (looped) {
          denyTools = true; loopBroken = true;
          if (typeof cfg.onThinking === 'function') { try { cfg.onThinking('· loop guard: same tool call ×' + LOOP_REPEAT_LIMIT + ', forcing a final answer'); } catch {} }
        }
        finalText = '';                 // the pre-tool preamble isn't the final answer; the next model call produces it
        continue;                        // loop for the model's follow-up
      }

      // a normal stop (or length): the assistant's text IS the answer. If the loop guard forced this call and the
      // model still returned no text, surface an honest note rather than an empty answer.
      finalText = res.text || (loopBroken ? '(stopped: repeated the same tool call; no further progress)' : '');
      messages.push({ role: 'assistant', content: finalText });
      // OPT-IN self-review (cfg.selfReview): exactly ONE extra critique pass over this genuine, model-authored
      // answer. OFF by default (this block is skipped when cfg.selfReview is falsy, so the default + subscription
      // paths are byte-identical to before). Fail-soft (any reviewer error keeps the original), never a loop, and
      // the reviewer is offered ZERO tools. Adopt the corrected answer ONLY if the reviewer actually revised it.
      // This is the LAST mutation of finalText/messages before result(); it runs on no other return path (the
      // error/aborted returns happen earlier; the max_steps fallthrough is a placeholder, not a model answer).
      if (cfg.selfReview && finalText) {
        if (typeof cfg.onThinking === 'function') { try { cfg.onThinking('· self-review'); } catch {} }
        let rv = null;
        try { rv = await runReview(cfg, messages, finalText, { signal }); } catch { rv = null; }
        if (rv && rv.usage) { usage.inTok += rv.usage.inTok | 0; usage.outTok += rv.usage.outTok | 0; }
        if (rv && rv.revised && rv.text && rv.text !== finalText) {
          finalText = rv.text;
          messages[messages.length - 1] = { role: 'assistant', content: finalText };   // reflect the adopted revision in the returned/persisted history
        }
      }
      return result(true, null, loopBroken ? 'loop_broken' : (res.stopReason || 'stop'));
    }

    // ran out of steps with tools still pending — bounded stop, not a hang. Surface a visible note rather than an
    // empty answer (finalText was reset after the last tool batch, so there is no model-authored text to return).
    if (!finalText) finalText = '(stopped after ' + maxSteps + ' tool steps without a final answer)';
    return result(true, null, 'max_steps');

    function result(ok, error, stopReason) {
      return { ok, text: finalText, messages, usage, steps, stopReason, error: error || undefined };
    }
  }

  return { run };
}

module.exports = { createEngine };
