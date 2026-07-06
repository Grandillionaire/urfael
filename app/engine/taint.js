'use strict';
// app/engine/taint.js — CaMeL-LITE: value-level taint tags + a capability policy gate for the native engine.
//
// WHAT THIS IS (honest scope, read before touching): Urfael already spotlights untrusted content (nonce-framed as
// DATA, never instructions) and runs an untrusted turn wholly read-only. That is defense against the model being
// *persuaded*. CaMeL adds a second, structural layer: even if the model IS persuaded, a value that DERIVED FROM
// untrusted content must not be able to silently drive a PRIVILEGED action. Google DeepMind's CaMeL does this with a
// custom Python interpreter that propagates per-value capabilities through full dataflow. We do NOT reimplement that
// interpreter. We implement the well-scoped, honest subset that fits a tool-calling agent:
//
//   1. VALUE-LEVEL TAINT — a value can be tagged as derived from an untrusted source, two ways:
//        (a) a Tainted BOX (taint(value, source)) — exact, identity-carried provenance for values a trusted path
//            constructs from untrusted data (e.g. the typed structure a quarantined reader returns); and
//        (b) a per-turn TaintRegistry of untrusted TEXT — so when the model launders a span of untrusted content
//            verbatim into a tool argument, the gate still catches it by provenance-substring match.
//   2. CAPABILITY POLICY GATE — before a PRIVILEGED/mutating tool runs, every argument is checked for taint. A
//      tainted argument is REFUSED unless the policy TABLE explicitly permits a tainted value on that argument.
//      Fail-closed default: no privileged tool accepts any tainted argument. (CaMeL's canonical example — "send only
//      to a recipient that came from a trusted source" — is exactly this: the recipient/path arg must be untainted.)
//
// This is NOT interpreter-grade dataflow. It cannot see a value the model paraphrases or computes from untrusted
// bytes; it catches identity-carried taint (the box) and verbatim/normalized-substring laundering (the registry).
// That boundary is stated plainly so the guarantee is not overclaimed.
//
// CREDIT: Google DeepMind, "Defeating Prompt Injections by Design" (CaMeL), Apache-2.0, arXiv:2503.18813; and
// Beurer-Kellner, Willison et al., "Design Patterns for Securing LLM Agents against Prompt Injections" (dual-LLM /
// quarantined-reader), arXiv:2506.08837. The Tainted box + capability table are our zero-dependency adaptation.
//
// Zero-dependency. NEVER THROWS: every export is defensive; a bad input yields a safe default (untainted / refuse),
// never an exception — the gate is a fail-closed refusal string, exactly like every other tool guard.

// A registered untrusted span must be at least this long to count as provenance. Below it, a match is more likely a
// coincidental common word than laundered content, so the registry ignores it (the Tainted BOX path is exact and has
// no length floor — use it for short, precisely-extracted untrusted fields like a single recipient address).
const MIN_SPAN = 8;
const MAX_REGISTRY = 256;                 // cap distinct registered spans per turn (a tool result is bounded already)
const MAX_SPAN_LEN = 64 * 1024;           // cap a single registered span's length
const TAINT = Symbol.for('urfael.taint'); // the box brand (Symbol.for so it survives across module instances)

// normalize(s) — collapse whitespace runs and trim, so "curl  evil.com" and "curl evil.com" compare equal. Applied
// identically to a registered span and to an argument before the substring test, keeping the comparison meaningful.
function normalize(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

// ── value-level taint tags ────────────────────────────────────────────────────
// taint(value, ...sources) — box `value` as tainted with provenance source label(s). Re-taint merges sources. The
// box is a frozen, branded wrapper: { [TAINT]:true, value, sources }. isTainted/unwrap/sourcesOf read it back.
function taint(value, ...sources) {
  const prior = isTainted(value) ? value.sources : [];
  const inner = isTainted(value) ? value.value : value;
  const merged = [...new Set([...prior, ...sources.map((s) => String(s || 'untrusted'))])];
  return Object.freeze({ [TAINT]: true, value: inner, sources: Object.freeze(merged.length ? merged : ['untrusted']) });
}
function isTainted(v) { return !!(v && typeof v === 'object' && v[TAINT] === true); }
function unwrap(v) { return isTainted(v) ? v.value : v; }
function sourcesOf(v) { return isTainted(v) ? v.sources.slice() : []; }

// unwrapDeep(v) — strip Tainted boxes recursively so a tool IMPL receives plain values (the gate has already run).
// Bounded recursion; cycles/oddities fall through to the value itself. Pure.
function unwrapDeep(v, depth) {
  if ((depth || 0) > 6) return unwrap(v);
  const u = unwrap(v);
  if (Array.isArray(u)) return u.map((x) => unwrapDeep(x, (depth || 0) + 1));
  if (u && typeof u === 'object') { const o = {}; for (const k of Object.keys(u)) o[k] = unwrapDeep(u[k], (depth || 0) + 1); return o; }
  return u;
}

// ── the per-turn untrusted-text registry (provenance-substring taint) ─────────
// A turn that consumes untrusted data registers that text here (directly, or via a tool whose OUTPUT is untrusted).
// taintedSpanIn(arg) then reports whether an argument overlaps any registered span by >= MIN_SPAN normalized chars.
function createRegistry() {
  const spans = [];   // { text (normalized), source }
  return {
    // register(text, source) — record an untrusted span. Bounded + normalized. Short/empty text is ignored.
    register(text, source) {
      const t = normalize(text);
      if (t.length < MIN_SPAN || spans.length >= MAX_REGISTRY) return this;
      spans.push({ text: t.slice(0, MAX_SPAN_LEN), source: String(source || 'untrusted') });
      return this;
    },
    // taintedSpanIn(arg) — { source, span } if `arg` overlaps a registered span by >= MIN_SPAN normalized chars,
    // in EITHER direction (the model copied a fragment of a big untrusted blob into arg, OR arg contains a short
    // registered span verbatim). null otherwise. Substring-only (no fuzzy match) — the honest scope boundary.
    taintedSpanIn(arg) {
      const a = normalize(arg);
      if (a.length < MIN_SPAN) return null;
      for (const s of spans) {
        const r = s.text;
        if ((r.length >= MIN_SPAN && a.includes(r)) || (a.length >= MIN_SPAN && r.includes(a))) return { source: s.source, span: (r.length <= a.length ? r : a).slice(0, 80) };
      }
      return null;
    },
    get size() { return spans.length; },
  };
}

// valueIsTainted(v, registry) — does this argument value carry taint? A Tainted box is tainted regardless of the
// registry; a plain string is tainted iff it overlaps a registered untrusted span; arrays/objects are tainted iff any
// contained value is. Returns { tainted, source } (source is the first provenance found). Bounded recursion; never throws.
function valueIsTainted(v, registry, depth) {
  if ((depth || 0) > 6) return { tainted: false };
  if (isTainted(v)) return { tainted: true, source: (v.sources[0] || 'untrusted') };
  const inner = unwrap(v);
  if (typeof inner === 'string') { const hit = registry && registry.taintedSpanIn(inner); return hit ? { tainted: true, source: hit.source, span: hit.span } : { tainted: false }; }
  if (Array.isArray(inner)) { for (const x of inner) { const r = valueIsTainted(x, registry, (depth || 0) + 1); if (r.tainted) return r; } return { tainted: false }; }
  if (inner && typeof inner === 'object') { for (const k of Object.keys(inner)) { const r = valueIsTainted(inner[k], registry, (depth || 0) + 1); if (r.tainted) return r; } return { tainted: false }; }
  return { tainted: false };
}

// ── the capability policy table + gate ────────────────────────────────────────
// The PRIVILEGED (mutating / world-affecting) tools of the native engine. A tainted argument to any of these is the
// dangerous case CaMeL closes. Read/search tools are NOT privileged: reading is how a turn safely consumes untrusted
// data, so taint on a read argument is fine (the READ result then becomes tainted, propagating the provenance forward).
const PRIVILEGED_TOOLS = new Set(['write_file', 'edit_file', 'remember', 'exec_shell']);
function isPrivileged(name) { return PRIVILEGED_TOOLS.has(String(name || '')); }

// DEFAULT_POLICY — fail-closed. Every privileged tool refuses EVERY tainted argument. A caller widens it explicitly,
// per (tool, argument), mirroring CaMeL's "this specific value may come from untrusted data". The canonical safe
// widening is write_file.content: you may PERSIST untrusted bytes to a file, but the PATH must stay trusted (a
// tainted path is a write-target the attacker chose). So `{ write_file: { allow: { content: true } } }` is the CaMeL
// "recipient must be trusted, body may not be" pattern, expressed as data.
const DEFAULT_POLICY = Object.freeze({
  write_file: Object.freeze({ allow: Object.freeze({}) }),
  edit_file: Object.freeze({ allow: Object.freeze({}) }),
  remember: Object.freeze({ allow: Object.freeze({}) }),
  exec_shell: Object.freeze({ allow: Object.freeze({}) }),
});

// checkCapability({ name, args, registry?, policy? }) → { allow, reason?, tainted? }. The one gate. A non-privileged
// tool always passes (reads are safe). A privileged tool passes ONLY if no argument is tainted OR each tainted
// argument is explicitly allowed by the policy table. Fail-closed + never throws: any internal problem denies.
function checkCapability(input) {
  try {
    const name = input && input.name;
    const args = (input && input.args) || {};
    const registry = input && input.registry;
    const policy = (input && input.policy) || DEFAULT_POLICY;
    if (!isPrivileged(name)) return { allow: true };
    const allowSet = (policy[name] && policy[name].allow) || {};
    const tainted = [];
    for (const k of Object.keys(args)) {
      const r = valueIsTainted(args[k], registry);
      if (r.tainted && allowSet[k] !== true) tainted.push({ arg: k, source: r.source, span: r.span });
    }
    if (tainted.length) {
      const detail = tainted.map((t) => t.arg + (t.source ? ' (from ' + t.source + ')' : '')).join(', ');
      return { allow: false, tainted, reason: 'denied: capability policy refused ' + name + ' — argument ' + detail +
        ' is derived from untrusted content and no policy permits a tainted value there (CaMeL-lite fail-closed). Route the untrusted part through a read-only step, or have the owner supply the trusted value.' };
    }
    return { allow: true };
  } catch { return { allow: false, reason: 'denied: capability gate error (fail-closed)' }; }
}

// ── a2ui-discipline reducer: untrusted text → typed structure whose provenance stays tainted ──────────────────────
// reduceUntrusted(raw, schema, source) — the untrusted-DATA analog of a2ui.sanitizeBlock: take raw content a
// quarantined reader produced, validate it against an ALLOWLISTED, type-checked, length-bounded field schema, and
// return a normalized structure whose every accepted field is a Tainted BOX carrying `source`. A field that fails its
// type/shape is DROPPED (errors++), never trusted. schema = { field: { type:'string'|'number'|'bool', max? } }.
// So a trusted turn gets a safe typed object out of untrusted text, but the provenance rides along and the capability
// gate still refuses any of those fields on a privileged tool unless policy allows. Pure + never throws.
function reduceUntrusted(raw, schema, source) {
  const src = String(source || 'untrusted');
  let obj = raw;
  if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch { obj = null; } }
  const fields = {}; let errors = 0;
  const sch = (schema && typeof schema === 'object') ? schema : {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { for (const k of Object.keys(sch)) errors++; return { fields, errors, source: src }; }
  for (const key of Object.keys(sch)) {
    const spec = sch[key] || {}; const v = obj[key];
    if (spec.type === 'string') { if (typeof v === 'string') fields[key] = taint(v.slice(0, spec.max || 2000), src); else errors++; }
    else if (spec.type === 'number') { const n = Number(v); if (Number.isFinite(n)) fields[key] = taint(n, src); else errors++; }
    else if (spec.type === 'bool') { if (typeof v === 'boolean') fields[key] = taint(v, src); else errors++; }
    else errors++;
  }
  return { fields, errors, source: src };
}

module.exports = {
  taint, isTainted, unwrap, unwrapDeep, sourcesOf,
  createRegistry, valueIsTainted,
  PRIVILEGED_TOOLS, isPrivileged, DEFAULT_POLICY, checkCapability,
  reduceUntrusted, normalize, MIN_SPAN, TAINT,
};
