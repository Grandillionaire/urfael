'use strict';
// app/run-scope.js — OPT-IN (URFAEL_RUN_SCOPE=1, default OFF) reliability hardening for concurrent remote runs.
// It layers TWO guarantees ON TOP of the daemon's EXISTING global caps (MAX_SCOPED remote turns, MAX_RUNNING_JOBS
// background jobs, the inflightScoped set) and its EXISTING principal/origin scoping (the team kernel + the
// allowlist gate). It invents NO new identity, opens NO port, and adds NO dependency:
//
//   (a) FAIR PER-ORIGIN SHARE — a single remote origin/principal may hold at most its fair slice of the global run
//       slots, so one flooding origin can never starve the others. It NEVER raises the global cap; it only refuses
//       an origin that already holds its share, returning the SAME busy/backpressure the global cap already returns.
//
//   (b) ORIGIN-SCOPED RESUME — an existing run/session/job may be resumed or reused only by the SAME origin that
//       created it; a cross-origin resume is refused fail-closed.
//
// DEFAULT OFF: when URFAEL_RUN_SCOPE is unset the daemon never enters any run-scope branch, so the shipped default
// path and the assembled turn stay BYTE-IDENTICAL (proven by the flag-off parity test). Fail-closed everywhere: an
// unknown / unattributable origin gets the MOST restrictive treatment and can neither monopolize nor resume.
// Pure, in-memory, zero-dependency, unit-testable without spawning the daemon.

// The exact string '1' — and only that — arms the feature, so an unset / '0' / 'true' / anything-else env leaves
// every gated branch dormant (mirrors the daemon's other opt-ins, e.g. URFAEL_SELF_REVIEW / URFAEL_PRECOMPACT).
function enabled(env) { return (env || process.env).URFAEL_RUN_SCOPE === '1'; }

// Two well-known origin keys. The LOCAL owner over the 0600 socket is a distinct, trusted origin (single-user
// product): their own concurrency is never fair-capped (keeps single-owner use byte-identical) and they may resume
// their own runs. UNKNOWN is the fail-closed bucket every unattributable request shares.
const OWNER = 'owner';
const UNKNOWN = '?';

// Derive a stable origin key from a RESOLVED trust context — the SAME { principal, role, channel } the daemon
// already derives before any turn (askScoped ctx / a job spec). A pre-derived key string is passed through as-is so
// a stored creator-origin round-trips. Order: the local owner is its own origin; then principal (strongest remote
// identity); then channel; anything else is UNATTRIBUTABLE (fail-closed). It never invents identity.
function originKey(ctx) {
  if (typeof ctx === 'string') return ctx.trim() || UNKNOWN;      // already-derived key (empty → fail-closed)
  const c = ctx || {};
  if (c.local === true || c.role === 'owner' || c.role === 'local') return OWNER;
  const principal = typeof c.principal === 'string' ? c.principal.trim() : '';
  if (principal) return 'p:' + principal;
  const channel = typeof c.channel === 'string' ? c.channel.trim() : '';
  if (channel) return 'c:' + channel;
  return UNKNOWN;                                                 // fail-closed: unattributable
}

// The fair per-origin share of a global cap: half, rounded up, never below 1. At the daemon's MAX_SCOPED=4 this is
// 2, so one origin holds at most half the remote slots and at least one other origin can always be served. We NEVER
// raise the global cap here — this only bounds a single origin BELOW it.
function fairShare(globalCap) { const g = Math.max(1, globalCap | 0); return Math.max(1, Math.ceil(g / 2)); }

// The per-origin ceiling for an origin key. The owner is exempt (Infinity → single-owner stays byte-identical); an
// unattributable origin is clamped to 1 (most restrictive); every attributable remote origin gets the fair share.
function originCap(key, globalCap) {
  if (key === OWNER) return Infinity;
  if (key === UNKNOWN) return 1;
  return fairShare(globalCap);
}

// A tiny in-memory per-origin slot counter. One instance lives in the daemon; tests make their own. Acquire on
// admit, release on the child's exit/error. Never negative; a released-to-zero key is dropped so the map cannot grow.
function makeCounter() {
  const m = new Map();
  return {
    held: (key) => m.get(originKey(key)) || 0,
    // May THIS origin take ANOTHER global slot under its fair cap? Owner/exempt → always. Non-owner → strictly below
    // its ceiling. This is the ONLY admission decision run-scope makes; the caller still enforces the global cap first.
    admit: (ctx, globalCap) => {
      const key = originKey(ctx);
      const cap = originCap(key, globalCap);
      if (cap === Infinity) return true;
      return (m.get(key) || 0) < cap;
    },
    acquire: (ctx) => { const key = originKey(ctx); m.set(key, (m.get(key) || 0) + 1); return key; },
    release: (key) => { if (key == null) return; const k = originKey(key); const n = (m.get(k) || 0) - 1; if (n > 0) m.set(k, n); else m.delete(k); },
    size: () => m.size,
  };
}

// ── ORIGIN-SCOPED RESUME (part b) ──────────────────────────────────────────────────────────────────────────────
// Two origins are the SAME iff their derived keys are equal AND that key is attributable. An UNATTRIBUTABLE origin
// never matches anything (fail-closed): it can neither be resumed nor resume another.
function sameOrigin(a, b) {
  const ka = originKey(a), kb = originKey(b);
  if (ka === UNKNOWN || kb === UNKNOWN) return false;
  return ka === kb;
}

// May `by` resume / reuse a run created by `creator`? The local owner (single-user product; this path is already
// gated by the 0600 owner socket) may resume anything they can reach. Otherwise ONLY the exact same origin may — a
// cross-origin resume is refused fail-closed, and a run with no recorded creator origin is unattributable (refused
// for any non-owner). This is the one resume-ownership decision; every resume seam routes through it.
function canResume(creator, by) {
  if (originKey(by) === OWNER) return true;
  return sameOrigin(creator, by);
}

module.exports = { enabled, originKey, fairShare, originCap, makeCounter, sameOrigin, canResume, OWNER, UNKNOWN };
