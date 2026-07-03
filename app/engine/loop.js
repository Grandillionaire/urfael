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

const DEFAULT_MAX_STEPS = 8;          // model→tools→model cycles per user turn
const DEFAULT_MAX_TOKENS = 4096;      // per-call output budget

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

    for (steps = 0; steps < maxSteps; steps++) {
      if (signal && signal.aborted) return result(false, 'aborted', 'aborted');

      // compact before every model call so a long tool cycle can't overflow the window mid-run. contextWindow is the
      // model's TOTAL usable window (what the compactor triggers against) — distinct from maxTokens, the per-call
      // OUTPUT budget below. Conflating them made the compactor treat a 4k output cap as a 4k window and thrash.
      if (compactor) {
        try {
          const c = await compactor.maybeCompact(messages, { maxTokens: cfg.contextWindow || 32000, ...(opts.compact || {}) });
          if (c.compacted) { messages.length = 0; messages.push(...c.messages); }
        } catch { /* compaction is best-effort; a bug there must never fail the turn */ }
      }

      // adapter.chat never rejects (its executor is try-wrapped), but guard the await anyway — a rejected turn must
      // never escape run() into the daemon's shared chain.
      let res;
      try {
        res = await adapter.chat({
          baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
          messages, tools: toolset.defs,
          maxTokens: cfg.maxTokens || DEFAULT_MAX_TOKENS,   // per-call OUTPUT budget only
          temperature: cfg.temperature,
          onDelta: (t) => { finalText += t; if (typeof cfg.onDelta === 'function') { try { cfg.onDelta(t); } catch {} } },
          signal,
        });
      } catch (e) { return result(false, String((e && e.message) || e), 'error'); }

      usage.inTok += res.usage ? res.usage.inTok | 0 : 0;
      usage.outTok += res.usage ? res.usage.outTok | 0 : 0;

      if (!res.ok) return result(false, res.error || 'engine error', res.stopReason || 'error');

      if (res.stopReason === 'tool_calls' && res.toolCalls && res.toolCalls.length) {
        // record the assistant turn (its text, if any, + the tool calls) then run each tool and append results
        messages.push({ role: 'assistant', content: res.text || '', toolCalls: res.toolCalls });
        for (const call of res.toolCalls) {
          if (signal && signal.aborted) return result(false, 'aborted', 'aborted');
          let args = {};
          try { args = call.args ? JSON.parse(call.args) : {}; } catch { /* malformed tool args → empty; the tool guards */ }
          if (typeof cfg.onThinking === 'function') { try { cfg.onThinking('· ' + call.name); } catch {} }
          const content = await toolset.dispatch(call.name, args);
          messages.push({ role: 'tool', toolCallId: call.id, content: String(content == null ? '' : content) });
        }
        finalText = '';                 // the pre-tool preamble isn't the final answer; the next model call produces it
        continue;                        // loop for the model's follow-up
      }

      // a normal stop (or length): the assistant's text IS the answer
      messages.push({ role: 'assistant', content: res.text || '' });
      finalText = res.text || '';
      return result(true, null, res.stopReason || 'stop');
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
