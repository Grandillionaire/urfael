'use strict';
// app/engine/fallback.js — pure decision logic for LIVE PROVIDER FALLBACK on the native engine.
//
// When a native (non-subscription) turn fails, the daemon may retry the SAME request on the NEXT provider in the
// user's fallback chain (providers.chain). This module holds the two pure, I/O-free, secret-free decisions that
// govern that retry, so the daemon glue stays thin and the crown-jewel rules are unit-tested in isolation:
//
//   • classifyNativeError(result) -> { retryable, category }
//       Is a failed run worth trying on ANOTHER provider? Only a TRANSIENT, endpoint-level failure is — a network
//       drop, a timeout, an overload/5xx, or a 429/408. A 4xx (bad request / auth / bad key / not-found), a refused
//       redirect, a disallowed base URL, an over-cap response, or an OWNER abort is TERMINAL: a different provider
//       would fail the same way (or the user cancelled), so retrying only wastes a call. DEFAULTS TO TERMINAL — an
//       ok:true run, an unrecognized error, or a malformed input is never retried.
//
//   • nativeFallbackChain({ chain, canEngine, hasSecret }) -> entries[]
//       Given providers.chain(list, id) = [primary, ...fallbacks], return the ordered fallback candidates to try,
//       having DROPPED: the primary itself (index 0, already attempted); any provider the native engine cannot run
//       (canEngine false — the subscription/CLI-only provider, so a retryable native failure can never silently
//       degrade onto the flat-rate credential path); and — FAIL-CLOSED, the load-bearing rule — any provider whose
//       OWN stored secret is absent (hasSecret false), so a fallback is NEVER attempted on the daemon's own creds.
//
// DOCTRINE: both functions are TOTAL — they string-coerce every input, never touch a property that can throw on {}
// or null, wrap the injected predicates in try/catch (a throwing predicate fails CLOSED = skip), and NEVER throw.
// No network, no filesystem, no secret access. The daemon injects canEngine=engine.pickAdapter and a hasSecret that
// reads its own secretStore; this module never sees a key.

// Retryable statuses read from the ANCHORED `HTTP <code>` prefix the adapters emit (openai-/anthropic-adapter emit
// exactly 'HTTP ' + statusCode + [': ' + body]). 429 is treated retryable ON PURPOSE: for CROSS-PROVIDER fallback a
// rate limit on provider A says nothing about provider B, so moving to the next key is the right move (unlike a
// same-provider retry, which would just re-hit the limit). 408 = request timeout, likewise transient.
function classifyNativeError(r) {
  const res = r && typeof r === 'object' ? r : {};
  // A success (or any non-false ok, incl. a missing/odd ok) is NEVER retried — the caller only classifies failures,
  // but defaulting here to terminal keeps the success path untouched even if mis-called.
  if (res.ok !== false) return { retryable: false, category: 'ok' };
  const err = String(res.error == null ? '' : res.error);
  const stop = String(res.stopReason == null ? '' : res.stopReason);
  // OWNER abort — the user cancelled the turn; retrying on another provider would fight the abort. Terminal.
  if (stop === 'aborted' || /^aborted\b/i.test(err)) return { retryable: false, category: 'aborted' };
  // HTTP status: read ONLY from the anchored prefix, never the body — otherwise a hostile endpoint could return
  // `HTTP 400: {"message":"503 overloaded"}` and spoof a terminal 4xx into a retry. Anchor defeats that.
  const m = /^HTTP (\d{3})\b/.exec(err);
  if (m) {
    const status = +m[1];
    if (status === 408 || status === 429 || status >= 500) return { retryable: true, category: 'http_' + status };
    return { retryable: false, category: 'http_' + status };   // 4xx: bad request / auth / forbidden / not-found — terminal
  }
  // raw socket/DNS errors: the adapters forward res.on('error') / connect-error messages verbatim. These are
  // transient endpoint faults; a different provider may well be reachable. Retry the chain.
  if (/\b(ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ENETDOWN)\b/i.test(err))
    return { retryable: true, category: 'network' };
  if (/socket hang up/i.test(err)) return { retryable: true, category: 'network' };
  if (/tim(?:ed? ?out|eout)/i.test(err)) return { retryable: true, category: 'timeout' };   // 'turn timed out', 'timeout'
  if (/\boverloaded?\b/i.test(err)) return { retryable: true, category: 'overload' };        // 'api error: Overloaded'
  // Everything else is TERMINAL by default: redirect refused, invalid/disallowed base URL, no model, response text
  // exceeded cap, tool-call arguments exceeded cap, a generic api error, or an unrecognized string. Retrying such a
  // failure on another provider would not help (it is a request/config/protocol fault, not a transient outage).
  return { retryable: false, category: 'terminal' };
}

// nativeFallbackChain({ chain, canEngine, hasSecret }) -> the ordered fallback ENTRIES to attempt after the primary.
//   chain      — providers.chain(list, id) result: [primary, ...fallbacks] (or anything; coerced to []).
//   canEngine  — (entry) => bool: can the NATIVE engine run this provider? (daemon injects engine.pickAdapter.)
//                Dropping !canEngine keeps a native failure from silently degrading onto the CLI/subscription path.
//   hasSecret  — (entry) => bool: is this provider's OWN secret present in the store? (daemon injects a secretStore
//                read.) Dropping !hasSecret is the FAIL-CLOSED guarantee: a keyless fallback is never even attempted,
//                so a retry can NEVER run on the daemon's base-env credentials.
// The primary (index 0) is ALWAYS excluded — it was just tried. A throwing predicate fails CLOSED (skip that entry).
function nativeFallbackChain(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const list = Array.isArray(o.chain) ? o.chain : [];
  const canEng = typeof o.canEngine === 'function' ? o.canEngine : () => true;
  const hasSec = typeof o.hasSecret === 'function' ? o.hasSecret : () => true;
  const out = [];
  for (let i = 1; i < list.length; i++) {   // i=0 is the PRIMARY (already attempted) — never a fallback candidate
    const e = list[i];
    if (!e) continue;                        // skip falsy / holey entries
    let engineable = false;
    try { engineable = !!canEng(e); } catch { engineable = false; }
    if (!engineable) continue;               // subscription/CLI-only provider — never degrade a native turn onto it
    let keyed = false;
    try { keyed = !!hasSec(e); } catch { keyed = false; }
    if (!keyed) continue;                     // FAIL-CLOSED: no stored secret -> drop it entirely (never the daemon's creds)
    out.push(e);
  }
  return out;
}

module.exports = { classifyNativeError, nativeFallbackChain };
