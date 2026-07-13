'use strict';
// app/engine/handoff-compact.js — OPT-IN pre-hand-off compaction of the end-of-conversation memory-distill
// transcript. Pure, zero-dependency, and NEVER-throws: every entry point falls back to the untouched input on ANY
// error, so a summarizer outage can never truncate or corrupt the hand-off. No network, no I/O, nothing listens here.
//
// This module adds NOTHING new to the compaction mechanism itself; it REUSES
// app/engine/compactor.js (createCompactor / pruneMiddle / redactSecrets / alignTailStart / countLeadingSystem /
// toolResultStub) and only maps between Urfael's {user, urfael} distill transcript and the compactor's
// engine-neutral message array. The one honest caveat is documented at every seam: the live memory-distill
// transcript is text-only, so the >200-char tool-output prune is a NO-OP there and the shrink comes from the middle
// summary; the prune is fully implemented + unit-tested and only bites if a tool-bearing window is ever the source.

const { createCompactor, countLeadingSystem, redactSecrets } = require('./compactor');

// messagesFromTranscript(transcript) — map Urfael's [{user, urfael}] distill transcript into the compactor's
// engine-neutral [{role:'user'}, {role:'assistant'}, ...] alternation. Never throws: a malformed row is skipped.
function messagesFromTranscript(transcript) {
  const out = [];
  const list = Array.isArray(transcript) ? transcript : [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    out.push({ role: 'user', content: String(t.user == null ? '' : t.user) });
    out.push({ role: 'assistant', content: String(t.urfael == null ? '' : t.urfael) });
  }
  return out;
}

// renderMiddleText(middle) — render a middle window to the exact plain-text serialization the aux summarizer sees,
// with secrets scrubbed to [redacted] BEFORE it leaves the box (edge 1). This is the ONE place that produces the
// summarizer input, so daemon.js:makeHandoffSummarizer() reuses it verbatim and the redaction is unit-testable here.
function renderMiddleText(middle) {
  const list = Array.isArray(middle) ? middle : [];
  const text = list.map((m) => {
    const who = !m ? 'Note' : m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Urfael'
      : m.role === 'tool' ? 'ToolResult' : String((m && m.role) || 'Note');
    let line = who + ': ' + String(m && m.content == null ? '' : m.content);
    if (m && Array.isArray(m.toolCalls) && m.toolCalls.length) line += ' [called: ' + m.toolCalls.map((c) => c && c.name).join(', ') + ']';
    return line;
  }).join('\n').slice(0, 60000);   // bound the prompt; the middle is already token-bounded, but a hostile row could be huge
  return redactSecrets(text);
}

// convoFromMessages(messages) — re-serialize a compacted message array back to the `User:/Urfael:` transcript string
// the distill pass expects. The pinned first-N/last-N messages survive as verbatim `User:/Urfael:` substrings; the
// carried summary re-enters headed by the compactor's reference-only fence.
function convoFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return list.map((m) => {
    const c = String(m && m.content == null ? '' : m.content);
    if (!m) return c;
    if (m.role === 'assistant') return 'Urfael: ' + c;
    if (m.role === 'system') return c;   // unused on the distill path (transcript carries no system row)
    return 'User: ' + c;                 // user turns + the fenced reference summary
  }).join('\n\n');
}

// compactForHandoff(messages, opts) — drive the compactor over an engine-neutral message array for a hand-off.
//   opts = { summarize, maxTokens, triggerRatio, pinFirst, pinLast, now, compactor? }
// Protects the leading system run + the first pinFirst messages (pinHead) and the last pinLast messages (pinTail),
// prunes >200-byte tool outputs, and summarizes the middle behind a reference-only fence. FAIL-SAFE: on ANY error,
// !ok, empty/all-redacted summary, or a would-grow result the compactor returns the input UNCHANGED (deepEqual, never
// truncates, never grows) — so this wrapper's own try/catch is only defense-in-depth over the same crown property.
async function compactForHandoff(messages, opts = {}) {
  const msgs = Array.isArray(messages) ? messages : [];
  const untouched = () => ({ messages: msgs, compacted: false, reason: 'noop', tokensBefore: 0, tokensAfter: 0, savedPct: 0 });
  try {
    const summarize = typeof opts.summarize === 'function' ? opts.summarize : null;
    const pinFirst = Number.isFinite(opts.pinFirst) ? Math.max(0, opts.pinFirst) : 0;
    const pinLast = Number.isFinite(opts.pinLast) ? Math.max(0, opts.pinLast) : 0;
    // Reserve ONE extra verbatim tail slot when protecting a tail: the compactor folds the reference fence onto the
    // tail's first message, so keeping pinLast+1 verbatim guarantees the requested last pinLast messages are the
    // untouched ones (the fence lands on the buffer slot, never on a pinned message).
    const pinTail = pinLast > 0 ? pinLast + 1 : 0;
    const compactor = opts.compactor || createCompactor({
      summarize,
      pruneStubMin: 200,   // hand-off floor: stub tool outputs over 200 bytes (native default stays 220)
      now: typeof opts.now === 'function' ? opts.now : undefined,
    });
    const res = await compactor.maybeCompact(msgs, {
      maxTokens: opts.maxTokens || 32000,
      triggerRatio: opts.triggerRatio != null ? opts.triggerRatio : 0.75,
      pinHead: countLeadingSystem(msgs) + pinFirst,
      pinTail,
    });
    return {
      messages: res.messages, compacted: res.compacted, reason: res.reason,
      tokensBefore: res.tokensBefore, tokensAfter: res.tokensAfter, savedPct: res.savedPct,
    };
  } catch { return untouched(); }
}

// precompactConvo(transcript, { summarize }, opts) — the daemon entry point. Snapshots the {user, urfael} transcript,
// runs compactForHandoff, and re-serializes the result to a `User:/Urfael:` string. On ANY abort (no summarizer, under
// budget, cooldown, summarizer failure, or an unexpected throw) it returns the RAW joined convo BYTE-FOR-BYTE, so the
// downstream one-shot hand-off is identical to the pre-feature spawn.
//   opts = { maxTokens, triggerRatio, firstN, lastN, now }  (firstN/lastN are EXCHANGES → *2 messages)
async function precompactConvo(transcript, deps = {}, opts = {}) {
  const list = Array.isArray(transcript) ? transcript : [];
  const rawConvo = list.map((t) => `User: ${t.user}\nUrfael: ${t.urfael}`).join('\n\n');
  const abort = (reason, r) => ({
    convo: rawConvo, compacted: false, reason: reason || (r && r.reason) || 'noop',
    tokensBefore: (r && r.tokensBefore) || 0, tokensAfter: (r && r.tokensAfter) || 0, savedPct: (r && r.savedPct) || 0,
  });
  try {
    const summarize = deps && typeof deps.summarize === 'function' ? deps.summarize : null;
    if (!summarize) return abort('no_summarizer');
    const firstN = Number.isFinite(opts.firstN) ? Math.max(0, opts.firstN) : 2;
    const lastN = Number.isFinite(opts.lastN) ? Math.max(0, opts.lastN) : 6;
    const res = await compactForHandoff(messagesFromTranscript(list), {
      summarize,
      maxTokens: opts.maxTokens,
      triggerRatio: opts.triggerRatio,
      pinFirst: firstN * 2,
      pinLast: lastN * 2,
      now: opts.now,
    });
    if (!res || !res.compacted) return abort(null, res);
    return {
      convo: convoFromMessages(res.messages), compacted: true, reason: res.reason,
      tokensBefore: res.tokensBefore, tokensAfter: res.tokensAfter, savedPct: res.savedPct,
    };
  } catch { return abort('precompact_error'); }
}

module.exports = { messagesFromTranscript, renderMiddleText, compactForHandoff, precompactConvo };
