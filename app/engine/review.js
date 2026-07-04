'use strict';
// app/engine/review.js — the native loop's OPT-IN self-review pass.
//
// After run() reaches a genuine, model-authored final answer, and ONLY if cfg.selfReview is truthy, the loop makes
// exactly ONE more model call asking the model to critique its OWN answer against the user's request + the tool
// evidence and reply either with the CONFIRM sentinel (answer is correct) or with a corrected answer. A genuine
// revision is adopted; a confirm / empty / identical / errored reviewer keeps the original. It is:
//   • BOUNDED to one pass — runReview makes a single adapter.chat and NEVER dispatches a tool or recurses.
//   • NARROW-ONLY — the reviewer is offered ZERO tools (the empty-set floor of council.intersectTools). It cannot
//     write/exec/read/escalate, and runReview reads only res.text, so a hostile endpoint returning spurious
//     tool_calls in the critique is inert.
//   • FAIL-SOFT — any reviewer error/timeout/abort or an empty reply returns the ORIGINAL answer unchanged.
//   • OFF BY DEFAULT — the whole thing is skipped unless the loop is built with cfg.selfReview (so the default and
//     subscription paths are byte-identical to before this file existed).
//
// Pure-ish + injectable like compactor.js: buildReviewMessages/parseReview are pure string work (unit-testable with
// no adapter); runReview makes the one call and is fully try-wrapped.

const REVIEW_INSTRUCTION =
  'Review your OWN answer above for correctness and completeness against the request and the tool evidence. ' +
  'If it is fully correct, reply with exactly: CONFIRM. Otherwise reply with the corrected answer ONLY — no ' +
  'preamble, no explanation, just the improved answer.';

const EVIDENCE_CAP = 8000;                 // bound the tool digest; a hostile tool result could otherwise blow the prompt
// CONFIRM sentinel: the reply LEADS with the word CONFIRM (so "CONFIRM", "CONFIRM.", "CONFIRM: looks right" all read
// as "no change"). \b keeps "CONFIRMED"/"CONFIRMATION" from matching — a whole word, not the sentinel.
const CONFIRM_RE = /^CONFIRM\b/i;

// buildReviewMessages(messages, finalText) -> a CLEAN, self-contained review request:
//   [ leading system message(s) verbatim, ONE user message ]
// The user message fences three sections as TEXT — the request, the tool evidence, the answer — and carries NO
// tool_use/tool_result blocks and NO assistant toolCalls. That flattening is deliberate: it is a valid history for
// BOTH adapters with tools:[] (it sidesteps Anthropic's strict user/assistant alternation AND the "tool_use present
// but no tools defined" 400 a naive full-history replay would open). Pure; never throws on odd input.
function buildReviewMessages(messages, finalText) {
  const msgs = Array.isArray(messages) ? messages : [];
  const out = [];
  // preserve the leading system message(s) (persona/constitution) verbatim; stop at the first non-system row
  for (const m of msgs) {
    if (m && m.role === 'system') out.push({ role: 'system', content: String(m.content == null ? '' : m.content) });
    else break;
  }
  // the user's request = the LAST user message content
  let request = '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === 'user' && typeof m.content === 'string') { request = m.content; break; }
  }
  // the tool evidence = every tool result, joined and bounded (a runaway tool result can't dominate the prompt)
  let evidence = '';
  for (const m of msgs) {
    if (m && m.role === 'tool') {
      const c = String(m.content == null ? '' : m.content);
      if (c) evidence += (evidence ? '\n---\n' : '') + c;
      if (evidence.length > EVIDENCE_CAP) { evidence = evidence.slice(0, EVIDENCE_CAP); break; }
    }
  }
  const answer = String(finalText == null ? '' : finalText);
  const body =
    'The user asked:\n```\n' + request + '\n```\n\n' +
    (evidence ? 'Tool evidence gathered while answering:\n```\n' + evidence + '\n```\n\n'
              : 'No tools were used while answering.\n\n') +
    'Your answer was:\n```\n' + answer + '\n```\n\n' +
    REVIEW_INSTRUCTION;
  out.push({ role: 'user', content: body });
  return out;
}

// parseReview(reviewText, originalText) -> { revised, text? }. The "adopt ONLY if actually revised" gate:
//   • empty/whitespace/non-string  -> not revised
//   • CONFIRM sentinel             -> not revised
//   • identical to the original (after trim) -> not revised (no actual change)
//   • otherwise                    -> revised, text = trimmed reply
function parseReview(reviewText, originalText) {
  const t = typeof reviewText === 'string' ? reviewText.trim() : '';
  if (!t) return { revised: false };
  if (CONFIRM_RE.test(t)) return { revised: false };
  const orig = typeof originalText === 'string' ? originalText.trim() : '';
  if (t === orig) return { revised: false };
  return { revised: true, text: t };
}

// runReview(cfg, messages, finalText, opts) -> Promise<{ revised, text, usage? }>. ONE adapter.chat, tools:[],
// temperature 0, NO onDelta (the critique is not streamed to the HUD), on cfg's baseUrl/apiKey/model and
// opts.signal. Fully try-wrapped: a throw / !ok / empty reply keeps the original answer. NEVER dispatches a tool,
// NEVER recurses — structurally exactly one call.
async function runReview(cfg, messages, finalText, opts) {
  cfg = cfg || {};
  opts = opts || {};
  const original = String(finalText == null ? '' : finalText);
  const adapter = cfg.adapter;
  if (!adapter || typeof adapter.chat !== 'function') return { revised: false, text: original };
  const reviewMsgs = buildReviewMessages(messages, original);
  let res;
  try {
    res = await adapter.chat({
      baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.reviewModel || cfg.model,
      messages: reviewMsgs,
      tools: [],                         // NARROW-ONLY: the reviewer is offered ZERO tools (empty-set intersectTools floor)
      maxTokens: cfg.maxTokens || 4096,
      temperature: 0,                    // deterministic critique
      signal: opts.signal,
      // NO onDelta — the critique must not stream over the answer the user already saw
    });
  } catch { return { revised: false, text: original }; }
  const usage = res && res.usage;        // aggregate the review call's tokens even on a confirm/empty (they were spent)
  if (!res || !res.ok || typeof res.text !== 'string' || !res.text.trim()) return { revised: false, text: original, usage };
  const parsed = parseReview(res.text, original);   // res.text ONLY — res.toolCalls is deliberately ignored (inert)
  if (parsed.revised && parsed.text) return { revised: true, text: parsed.text, usage };
  return { revised: false, text: original, usage };
}

module.exports = { buildReviewMessages, parseReview, runReview };
