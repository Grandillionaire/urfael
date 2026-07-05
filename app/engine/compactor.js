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
//   • PHASE-1 PRUNE (borrowed) — a deterministic tool-output prune pass runs BEFORE the aux call: bulky tool_results
//     become honest 1-line stubs, exact repeats collapse, oversized tool_call args are capped, image blobs elided.
//     If pruning alone brings the window under budget we SKIP the summary — space reclaimed with NO model call.
//     PROVENANCE (honest): this mechanism is borrowed from NousResearch/hermes-agent's context_compressor (MIT) —
//     re-implemented from scratch over Urfael's message shape. Borrowed idea, not code. Every stub is DERIVED from
//     the message's own bytes/lines/first line; it never invents an outcome.
//   • SECRET REDACTION — a tool can surface a live credential; zero-dep regexes scrub the obvious shapes to
//     [redacted] before the middle is serialized for the aux model AND before the summary is persisted.
//
// Pure orchestration + injected summarize(): no network, no I/O here, unit-testable with a fake summarizer.
//   createCompactor({ summarize, estimateTokens?, now?, referenceHeader? })
//     summarize(middleMessages, priorSummary) -> Promise<{ ok, summary, kind? } | throws>
//   compactor.maybeCompact(messages, opts) -> Promise<{ messages, compacted, reason, savedPct, tokensBefore, tokensAfter }>

const crypto = require('node:crypto');

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

// ── PHASE-1 tool-output prune pass (borrowed from NousResearch/hermes-agent, MIT) ───────────────────────────────
// Deterministic, no model call. Honest: every stub is derived from the message's own bytes/lines/first line.
const ARG_CAP = 512;                                       // max chars kept per tool_call arg string
const TOOL_STUB_MIN = 220;                                 // only stub tool_results bigger than this (bytes)
const IMG_DATA_URI = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{16,}/gi;   // contiguous base64 image blob

function md5(s) { return crypto.createHash('md5').update(String(s)).digest('hex'); }

// cap every string field of a parsed args object to ARG_CAP, so the re-stringified result stays valid JSON.
function capJsonStrings(v) {
  if (typeof v === 'string') return v.length > ARG_CAP ? v.slice(0, ARG_CAP) + '...(+' + (v.length - ARG_CAP) + ' chars elided)' : v;
  if (Array.isArray(v)) return v.map(capJsonStrings);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = capJsonStrings(v[k]); return o; }
  return v;
}
// truncate an oversized tool_call args STRING while KEEPING it valid JSON (parse → cap fields → re-stringify). If it
// doesn't parse, hard-cap the raw string with a visible marker (still a plain string, never thrown).
function capArgsString(argsStr) {
  const raw = String(argsStr == null ? '' : argsStr);
  if (raw.length <= ARG_CAP) return raw;
  try { return JSON.stringify(capJsonStrings(JSON.parse(raw))); }
  catch { return raw.slice(0, ARG_CAP) + '...(truncated, unparseable args)'; }
}
// a 1-line factual stub for a bulky tool_result. Outcome/lines/bytes come ONLY from the content — never invented.
function toolResultStub(tool, raw) {
  const bytes = Buffer.byteLength(raw, 'utf8');
  const lines = raw === '' ? 0 : raw.split('\n').length;
  const first = (raw.split('\n').find((l) => l.trim()) || '').trim().slice(0, 64);
  const exit = raw.slice(0, 400).match(/\bexit(?:\s*code)?[ :=]+(-?\d+)/i);
  let outcome = first || '(no output)';
  if (exit) outcome = 'exit ' + exit[1] + (first ? ' · ' + first : '');
  return '[' + tool + '] ' + outcome + ' · ' + lines + ' lines, ' + bytes + ' bytes (elided)';
}

// pruneMiddle(middle) — the deterministic pre-pass over the MIDDLE window only (head + live tail are never touched).
// Returns a NEW array; input is never mutated. Bulky tool_results → 1-line stubs; exact repeats (same tool + content)
// → an identical-elided marker; oversized tool_call args → capped valid JSON; base64 image blobs → [image elided].
// Plain user/assistant text passes through unchanged, so a tool-free window is a no-op.
function pruneMiddle(middle) {
  const list = Array.isArray(middle) ? middle : [];
  const nameById = new Map();      // resolve a tool_result's tool name from the assistant tool_use that produced it
  for (const m of list) if (m && Array.isArray(m.toolCalls)) for (const c of m.toolCalls) if (c && c.id != null) nameById.set(String(c.id), String(c.name || 'tool'));
  const seen = new Set();          // md5(tool + normalized content) already emitted ⇒ later dupes collapse
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') { out.push(m); continue; }
    // A3: cap oversized tool_call arguments on assistant messages (keep them valid JSON)
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.some((c) => c && String(c.args == null ? '' : c.args).length > ARG_CAP)) {
      out.push({ ...m, toolCalls: m.toolCalls.map((c) => (c && String(c.args == null ? '' : c.args).length > ARG_CAP ? { ...c, args: capArgsString(c.args) } : c)) });
      continue;
    }
    // A1/A2/A4: tool_results — image-strip, then dedupe-or-stub bulky ones
    if (m.role === 'tool') {
      const tool = nameById.get(String(m.toolCallId)) || 'tool';
      const original = String(m.content == null ? '' : m.content);
      const raw = original.replace(IMG_DATA_URI, '[image elided]');   // A4
      if (Buffer.byteLength(raw, 'utf8') > TOOL_STUB_MIN) {
        const key = md5(tool + '\u0000' + raw.trim());
        if (seen.has(key)) { out.push({ ...m, content: '[' + tool + '] (identical to earlier result, elided)' }); continue; }   // A2
        seen.add(key);
        out.push({ ...m, content: toolResultStub(tool, raw) });        // A1
        continue;
      }
      out.push(raw === original ? m : { ...m, content: raw });         // small result: keep (image-stripped if any)
      continue;
    }
    out.push(m);
  }
  return out;
}

// ── Secret redaction (defense-in-depth) ─────────────────────────────────────────────────────────────────────────
// A tool can surface a live credential; without this it lands verbatim in the aux-model prompt AND the persisted
// summary. Zero-dep regexes scrub the obvious shapes to [redacted]. Conservative on real secrets, tolerant of a rare
// false positive (a long hex/base64 blob) — the summary loses nothing a human actually needs.
// a long token only looks like a credential if it carries real entropy; a degenerate low-diversity run (e.g. a wall
// of one repeated char) is not a secret, so the blanket hex/base64 patterns skip it to avoid false positives.
function looksSecret(m) { return new Set(m).size >= 8; }
function redactSecrets(str) {
  if (str == null) return str;
  let s = String(str);
  s = s.replace(/\b(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?token|auth(?:orization)?)\b(\s*["']?\s*[:=]\s*["']?\s*)([^\s"',;)]{4,})/gi, '$1$2[redacted]');
  s = s.replace(/\bbearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, 'Bearer [redacted]');
  s = s.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]');
  s = s.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[redacted]');
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]');
  s = s.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted]');
  s = s.replace(/\b[0-9a-fA-F]{32,}\b/g, (m) => (looksSecret(m) ? '[redacted]' : m));
  s = s.replace(/\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g, (m) => (looksSecret(m) ? '[redacted]' : m));
  return s;
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
    const budget = Math.floor(maxTokens * triggerRatio);

    // TRIGGER on the REAL measured input-token count when the caller supplies it (loop.js plumbs res.usage.inTok),
    // falling back to the chars/4 estimate when absent — so behavior is unchanged when usage is unavailable. Only the
    // trigger decision uses the measurement; the shrink accounting below stays estimate-based (tokensAfter can't be
    // measured without a model call).
    const measured = opts.measuredInputTokens;
    const triggerTokens = (typeof measured === 'number' && measured > 0) ? measured : tokensBefore;

    if (!summarize) return done('no_summarizer');
    if (triggerTokens <= budget) return done('under_budget');
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

    // PHASE 1 — deterministic tool-output prune pass (NousResearch/hermes-agent, MIT). Collapses stale tool output to
    // honest 1-line stubs, dedupes exact repeats, caps oversized tool_call args, elides image blobs — all with NO
    // model call. If pruning ALONE brings the window under budget, SKIP the aux summary entirely (the doctrine-positive
    // property: space reclaimed for free). We only take the skip when pruning actually freed space AND the pruned
    // window fits — a tool-free window (nothing to prune) falls through to the summarizer unchanged.
    const prunedMiddle = pruneMiddle(middle);
    const prunedWindow = [...head, ...prunedMiddle, ...tail];
    const tokensAfterPrune = total(prunedWindow);
    if (tokensAfterPrune < tokensBefore && tokensAfterPrune <= budget) {
      state.ineffectiveCount = 0;
      state.lastReason = 'pruned';
      const savedPct = tokensBefore > 0 ? Math.max(0, 1 - tokensAfterPrune / tokensBefore) : 0;
      return { messages: prunedWindow, compacted: true, reason: 'pruned', savedPct, tokensBefore, tokensAfter: tokensAfterPrune };
    }

    // AUX-model summary of the PRUNED middle (cheaper prompt) with the prior summary folded in (iterative merge).
    // FAIL-SAFE: any throw or !ok returns the window UNCHANGED and arms a cooldown — a summarizer outage must never
    // cost the user their live context.
    let res;
    try { res = await summarize(prunedMiddle, state.previousSummary); }
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

    // SECRET REDACTION before the summary is folded in OR persisted: a key the aux model echoed back must not land
    // verbatim in the stored context. If redaction empties the summary (it was ALL secret), take the fail-safe abort.
    const cleanSummary = redactSecrets(res.summary.trim());
    if (!cleanSummary.trim()) {
      state.cooldownUntil = now() + cooldownMs;
      state.lastReason = 'summary_all_redacted';
      return done('summary_failed');
    }

    // The summary re-enters as a USER message. If the kept tail ALSO starts with a user message, two consecutive
    // user messages would violate the Anthropic Messages API's strict alternation (400). alignTailStart only
    // guarantees the tail doesn't start on an orphan tool_result, not that it starts on an assistant — so fold the
    // fenced summary into the tail's first user message instead of inserting a separate one. (OpenAI tolerates
    // adjacency, but fixing it here keeps BOTH adapters' histories valid.)
    const fenced = referenceHeader + '\n\n' + cleanSummary;
    let next;
    if (tail.length && tail[0] && tail[0].role === 'user') {
      const merged = { ...tail[0], content: fenced + '\n\n' + String(tail[0].content == null ? '' : tail[0].content) };
      next = [...head, merged, ...tail.slice(1)];
    } else {
      next = [...head, { role: 'user', content: fenced }, ...tail];
    }
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

    state.previousSummary = cleanSummary;
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

module.exports = { createCompactor, alignTailStart, defaultEstimateTokens, countLeadingSystem, pruneMiddle, redactSecrets, toolResultStub, capArgsString };
