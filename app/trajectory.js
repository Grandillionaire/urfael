'use strict';
// app/trajectory.js — TRAJECTORY / TRAINING-DATA EXPORT. Turns your own archived runs into clean training datasets,
// locally, owner-only. PURE + unit-tested: the CLI loads the session archive (JSONL) and the learning ledger and
// passes them in; this module filters, redacts, shapes, and manifests. Never throws; empty in, empty out.
//
// Why this beats Hermes (which exports raw agent runs for RL with Atropos):
//   1. Three formats from one corpus: `sft` (OpenAI fine-tune messages), `atropos` (trajectory + reward + metadata
//      for RL), and `lessons` — a dataset of VERIFIED knowledge drawn from the verify-before-trust learning ledger,
//      each example carrying its correct/safe verdict and confidence. Hermes has no verification signal, so it cannot
//      emit a confidence-weighted, quality-gated dataset. That is the edge.
//   2. PROVENANCE-stamped: every record carries its source (date, channel, model) and the manifest points at the
//      tamper-evident Ledger of Record (`urfael audit --verify`) that proves the corpus was not silently altered.
//   3. SECRET-REDACTED by default: credential-shaped strings are stripped before anything leaves the machine, with a
//      redaction count in the manifest. Honest about what is included.

const { stripSpoken } = require('./recall');

const MAXLEN = 100000;   // bound each field before regex work (sessions are short; this just caps a pathological turn)

// ── secret redaction (bounded, anchored patterns → ReDoS-safe). Returns { text, n } with n replacements made. ──
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,4000}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g,
  /sk-ant-[A-Za-z0-9_-]{16,128}/g,
  /sk-[A-Za-z0-9_-]{20,128}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ghp_[A-Za-z0-9]{20,80}/g,
  /glpat-[A-Za-z0-9_-]{16,80}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,120}/g,
  /AIza[A-Za-z0-9_-]{16,60}/g,
  /Bearer\s+[A-Za-z0-9._-]{16,256}/g,
  /\b[A-Z][A-Z0-9_]{1,40}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS)\s*[=:]\s*[^\s'"]{6,200}/g,
];
function redact(text) {
  let s = String(text == null ? '' : text).slice(0, MAXLEN);
  let n = 0;
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, (m) => {
      n++;
      // keep the key name in KEY=value form, redact only the value, so the example stays useful
      const kv = m.match(/^([A-Z][A-Z0-9_]{1,40}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS)\s*[=:]\s*)/);
      return kv ? kv[1] + '[REDACTED]' : '[REDACTED]';
    });
  }
  return { text: s, n };
}

const clean = (t) => stripSpoken(String(t == null ? '' : t)).replace(/\s+/g, ' ').trim();
function asDate(v) { const s = String(v || ''); return s ? s.slice(0, 10) : ''; }

// filter(entries, opts) → entries within { since, until (inclusive, YYYY-MM-DD), channel, model }. Never throws.
function filter(entries, opts) {
  const o = opts || {};
  const since = o.since ? asDate(o.since) : '';
  const until = o.until ? asDate(o.until) : '';
  return (Array.isArray(entries) ? entries : []).filter((e) => {
    if (!e || typeof e !== 'object') return false;
    const d = asDate(e.t);
    if (since && d && d < since) return false;
    if (until && d && d > until) return false;
    if (o.channel && String(e.channel || '') !== o.channel) return false;
    if (o.model && String(e.model || '') !== o.model) return false;
    return true;
  });
}

// one redaction pass over a user/assistant turn → { user, assistant, redactions } or null if empty after cleaning
function turnText(e, doRedact) {
  let user = clean(e && e.user), asst = clean(e && e.urfael);
  if (!user || !asst) return null;
  let r = 0;
  if (doRedact) { const a = redact(user), b = redact(asst); user = a.text; asst = b.text; r = a.n + b.n; }
  return { user, assistant: asst, redactions: r };
}

// buildSFT(entries, opts) → [{ messages:[{role:'user'},{role:'assistant'}], meta }] in the OpenAI fine-tune shape.
function buildSFT(entries, opts) {
  const o = opts || {}, doRedact = o.redact !== false;
  const out = []; let redactions = 0;
  for (const e of filter(entries, o)) {
    const t = turnText(e, doRedact); if (!t) continue;
    redactions += t.redactions;
    out.push({
      messages: [{ role: 'user', content: t.user }, { role: 'assistant', content: t.assistant }],
      meta: { source: 'urfael', date: asDate(e.t), channel: e.channel || '', model: e.model || '' },
    });
  }
  return { records: out, redactions };
}

// buildAtropos(entries, opts) → [{ trajectory:[{role,content}], reward, metadata }]. Reward is honest: archived turns
// are already success-filtered (the daemon never persists an aborted turn), so a completed turn is reward 1.0.
function buildAtropos(entries, opts) {
  const o = opts || {}, doRedact = o.redact !== false;
  const out = []; let redactions = 0;
  for (const e of filter(entries, o)) {
    const t = turnText(e, doRedact); if (!t) continue;
    redactions += t.redactions;
    out.push({
      trajectory: [{ role: 'user', content: t.user }, { role: 'assistant', content: t.assistant }],
      reward: 1.0,
      metadata: { source: 'urfael', date: asDate(e.t), channel: e.channel || '', model: e.model || '', verified: false },
    });
  }
  return { records: out, redactions };
}

// buildLessons(ledgerItems, opts) → a VERIFIED-knowledge dataset from trusted ledger lessons. THE differentiator:
// each record carries the verifier's verdict + confidence, so a trainer can quality-gate or confidence-weight. Only
// trusted items are emitted; the ref is redacted like any other text. minConfidence filters weak lessons.
function buildLessons(ledgerItems, opts) {
  const o = opts || {}, doRedact = o.redact !== false;
  const minConf = Number.isFinite(o.minConfidence) ? o.minConfidence : 0;
  const out = []; let redactions = 0;
  for (const it of (Array.isArray(ledgerItems) ? ledgerItems : [])) {
    if (!it || it.status !== 'trusted') continue;
    const conf = Number(it.confidence) || 0;
    if (conf < minConf) continue;
    let ref = clean(it.ref); if (!ref) continue;
    if (doRedact) { const r = redact(ref); ref = r.text; redactions += r.n; }
    const verdict = (it.verify && typeof it.verify === 'object') ? { correct: !!it.verify.correct, general: !!it.verify.general, safe: !!it.verify.safe } : null;
    out.push({
      messages: [
        { role: 'user', content: 'What have you learned that applies here?' },
        { role: 'assistant', content: ref },
      ],
      reward: Math.round(conf * 1000) / 1000,
      metadata: { source: 'urfael-ledger', type: it.type || 'lesson', verified: true, confidence: conf, verdict, learnedAt: it.learnedAt || null },
    });
  }
  // strongest first, so a top-k slice is the highest-confidence knowledge
  out.sort((a, b) => (b.metadata.confidence || 0) - (a.metadata.confidence || 0));
  return { records: out, redactions };
}

// toJSONL(records) → newline-delimited JSON, one object per line.
function toJSONL(records) { return (Array.isArray(records) ? records : []).map((r) => JSON.stringify(r)).join('\n') + (records && records.length ? '\n' : ''); }

// manifest(parts, opts) → a summary object describing the export (counts, range, integrity note). parts is a map of
// format → { records, redactions }.
function manifest(parts, opts) {
  const o = opts || {};
  const formats = {};
  let totalRedactions = 0;
  for (const [k, v] of Object.entries(parts || {})) { formats[k] = { records: (v.records || []).length, redactions: v.redactions || 0 }; totalRedactions += v.redactions || 0; }
  return {
    generator: 'urfael dataset export',
    redacted: o.redact !== false,
    totalRedactions,
    filter: { since: o.since || null, until: o.until || null, channel: o.channel || null, model: o.model || null, minConfidence: o.minConfidence || null },
    formats,
    integrity: 'Provenance is the Urfael Ledger of Record: run `urfael audit --verify` to prove this archive was not altered. Each record carries its source date, channel, and model.',
    privacy: 'Exported locally, owner-only. Credential-shaped strings are redacted by default (pass --no-redact to keep them). Review before sharing.',
  };
}

module.exports = { redact, filter, buildSFT, buildAtropos, buildLessons, toJSONL, manifest, SECRET_PATTERNS };
