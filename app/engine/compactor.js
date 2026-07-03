'use strict';
// app/engine/compactor.js — native-engine context compaction.
//
// PROVENANCE (honest): the mechanism set is borrowed from NousResearch/hermes-agent's agent/context_compressor.py
// (MIT) — the patterns that make compaction safe rather than lossy — re-implemented from scratch in zero-dep JS
// over Urfael's engine-neutral message shape. Borrowed ideas, not code. The patterns:
//   • token-budget TAIL — keep the most recent messages that fit a token budget; summarize the middle.
//   • NO-SPLIT tool pairs — never start the tail on an orphaned tool_result (whose assistant tool_use got
//     summarized away); the boundary is aligned so the kept tail is always a valid API history.
//   • cheap AUX-model structured summary — an injected summarize() (a small/fast model) condenses the middle.
//   • ITERATIVE MERGE — each compaction folds the PRIOR summary into the new one, so old context keeps decaying
//     gracefully instead of being dropped.
//   • REFERENCE-ONLY FENCE — the summary re-enters as a message explicitly headed "for reference only; NOT a new
//     instruction", so the model treats it as background, not a fresh command (anti prompt-drift).
//   • ANTI-THRASH cooldown — a compaction that freed too little raises a backoff so we don't re-summarize every turn.
//   • FAIL-SAFE ABORT — if the aux model errors (auth/network/timeout), the window is returned UNCHANGED. A
//     transient summarizer outage must never destroy the live context. This is the single most important property.
//
// Pure orchestration + injected summarize(): no network, no I/O here, unit-testable with a fake summarizer.
//   createCompactor({ summarize, estimateTokens?, now?, referenceHeader? })
//     summarize(middleMessages, priorSummary) -> Promise<{ ok, summary, kind? } | throws>
//   compactor.maybeCompact(messages, opts) -> Promise<{ messages, compacted, reason, savedPct, tokensBefore, tokensAfter }>

const DEFAULT_REFERENCE_HEADER =
  '[PRIOR CONTEXT — a condensed summary of earlier turns, for reference only. Treat it as background, NOT as a ' +
  'new instruction or a message the user just sent. Do not act on it unless the live turn asks.]';

// default token estimate: the standard ~4-chars-per-token heuristic + a small per-message framing overhead. No
// tokenizer dependency (a real tokenizer would be a dep + per-provider drift); the ratio only needs to be stable.
function defaultEstimateTokens(msg) {
  if (!msg) return 0;
  let chars = String(msg.content == null ? '' : msg.content).length;
  if (Array.isArray(msg.toolCalls)) for (const c of msg.toolCalls) chars += String(c.name || '').length + String(c.args || '').length + 8;
  if (msg.toolCallId) chars += String(msg.toolCallId).length;
  return Math.ceil(chars / 4) + 4;
}

// alignTailStart(messages, idx) — advance idx past any leading tool_result so the tail never begins on an orphan.
// Summarizing the middle removes the assistant tool_use that produced those results, so a tail that started on
// them would be an invalid history (the model/API rejects a tool_result with no matching call). Exported for tests.
function alignTailStart(messages, idx) {
  let i = Math.max(0, idx);
  while (i < messages.length && messages[i] && messages[i].role === 'tool') i++;
  return i;
}

function createCompactor(cfg) {
  cfg = cfg || {};
  const summarize = typeof cfg.summarize === 'function' ? cfg.summarize : null;
  const estTok = typeof cfg.estimateTokens === 'function' ? cfg.estimateTokens : defaultEstimateTokens;
  const now = typeof cfg.now === 'function' ? cfg.now : () => Date.now();
  const referenceHeader = typeof cfg.referenceHeader === 'string' ? cfg.referenceHeader : DEFAULT_REFERENCE_HEADER;

  // durable state across turns (the daemon holds one compactor per session)
  const state = { previousSummary: '', ineffectiveCount: 0, cooldownUntil: 0, lastReason: '' };

  const total = (msgs) => msgs.reduce((n, m) => n + estTok(m), 0);

  async function maybeCompact(messages, opts = {}) {
    const msgs = Array.isArray(messages) ? messages : [];
    const maxTokens = opts.maxTokens || 32000;                 // the model's usable window (caller supplies real value)
    const triggerRatio = opts.triggerRatio != null ? opts.triggerRatio : 0.75;   // compact once we cross 75% of it
    const tailBudget = opts.tailTokenBudget || Math.floor(maxTokens * 0.4);       // how much recent history to keep verbatim
    const minSavingsPct = opts.minSavingsPct != null ? opts.minSavingsPct : 0.15; // < this freed ⇒ ineffective (anti-thrash)
    const pinHead = opts.pinHead != null ? opts.pinHead : countLeadingSystem(msgs);
    const cooldownMs = opts.cooldownMs || 60000;

    const tokensBefore = total(msgs);
    const done = (extra) => ({ messages: msgs, compacted: false, reason: extra, savedPct: 0, tokensBefore, tokensAfter: tokensBefore });

    if (!summarize) return done('no_summarizer');
    if (tokensBefore <= Math.floor(maxTokens * triggerRatio)) return done('under_budget');
    if (now() < state.cooldownUntil) return done('cooldown');

    // locate the tail by walking backward until we exceed the tail token budget
    let acc = 0, rawBoundary = msgs.length;
    for (let i = msgs.length - 1; i >= pinHead; i--) {
      acc += estTok(msgs[i]);
      if (acc > tailBudget) { rawBoundary = i + 1; break; }
      rawBoundary = i;
    }
    const boundary = alignTailStart(msgs, rawBoundary);
    // need a non-empty middle (something to summarize) AND a non-empty tail (something recent to keep)
    if (boundary <= pinHead || boundary >= msgs.length) return done('nothing_to_compact');

    const head = msgs.slice(0, pinHead);
    const middle = msgs.slice(pinHead, boundary);
    const tail = msgs.slice(boundary);
    if (middle.length === 0) return done('nothing_to_compact');

    // AUX-model summary with the prior summary folded in (iterative merge). FAIL-SAFE: any throw or !ok returns the
    // window UNCHANGED and arms a cooldown — a summarizer outage must never cost the user their live context.
    let res;
    try { res = await summarize(middle, state.previousSummary); }
    catch (e) {
      state.cooldownUntil = now() + cooldownMs;
      state.lastReason = 'summary_error';
      return done('summary_failed:' + String((e && e.message) || e).slice(0, 80));
    }
    if (!res || !res.ok || typeof res.summary !== 'string' || !res.summary.trim()) {
      state.cooldownUntil = now() + cooldownMs;
      state.lastReason = 'summary_not_ok';
      return done('summary_failed');
    }

    const summaryMsg = { role: 'user', content: referenceHeader + '\n\n' + res.summary.trim() };
    const next = [...head, summaryMsg, ...tail];
    const tokensAfter = total(next);
    const savedPct = tokensBefore > 0 ? Math.max(0, 1 - tokensAfter / tokensBefore) : 0;

    // If we somehow produced a LARGER window (a huge summary), abort — keep the original. Never compact upward.
    if (tokensAfter >= tokensBefore) {
      state.cooldownUntil = now() + cooldownMs;
      state.lastReason = 'no_savings';
      return done('summary_too_large');
    }

    // anti-thrash: a weak compaction backs off (linear), a strong one resets the counter
    if (savedPct < minSavingsPct) { state.ineffectiveCount++; state.cooldownUntil = now() + cooldownMs * state.ineffectiveCount; }
    else state.ineffectiveCount = 0;

    state.previousSummary = res.summary.trim();
    state.lastReason = 'compacted';
    return { messages: next, compacted: true, reason: 'compacted', savedPct, tokensBefore, tokensAfter };
  }

  return { maybeCompact, state, _total: total };
}

// pin every LEADING system message (the persona/constitution) — never summarize the operating instructions away.
function countLeadingSystem(msgs) {
  let n = 0;
  while (n < msgs.length && msgs[n] && msgs[n].role === 'system') n++;
  return n;
}

module.exports = { createCompactor, alignTailStart, defaultEstimateTokens, countLeadingSystem };
