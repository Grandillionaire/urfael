'use strict';
// Ranked recall — pure, dependency-free BM25 over the session archive. Replaces substring-grep so
// "what did we discuss about X" returns the MOST RELEVANT past turns first, not just any line that
// happens to contain the substring. No deps, no I/O here: callers pass in already-loaded entries.
//
// rank(entries, query, k=20) ranks each entry by BM25 (k1=1.5, b=0.75) over its (user + ' ' + the
// urfael reply with [SPOKEN] tags stripped). Returns the top-k entries, each with a numeric .score
// (descending); ties broken by recency (newer .t first). Empty corpus/query -> []. Robust by design.

const K1 = 1.5, B = 0.75;

// Mirror bridge-core.stripSpoken so an entry's text matches what the user actually sees, without
// importing it (recall.js stays standalone for the daemon and for the inline Console copy).
function stripSpoken(t) { return (t || '').replace(/\[\/?SPOKEN\]/gi, '').trim(); }

// lowercase alnum tokenizer (Unicode-aware): same shape on both sides so query and corpus align.
function tokenize(s) { return String(s == null ? '' : s).toLowerCase().match(/[a-z0-9]+/g) || []; }

// Text of one archived entry as ranked: the user turn plus the spoken-stripped reply.
function entryText(e) { return ((e && e.user) || '') + ' ' + stripSpoken(e && e.urfael); }

// rank(entries, query, k=20) -> top-k entries (each gets a .score), BM25 descending, recency tiebreak.
function rank(entries, query, k = 20) {
  if (!Array.isArray(entries) || !entries.length) return [];
  const qTerms = tokenize(query);
  if (!qTerms.length) return [];
  const N = entries.length;

  // tokenize the corpus once; build per-doc term frequencies + document frequencies.
  const docs = new Array(N);
  let totalLen = 0;
  const df = new Map();
  for (let i = 0; i < N; i++) {
    const toks = tokenize(entryText(entries[i]));
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    docs[i] = { tf, len: toks.length };
    totalLen += toks.length;
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const avgdl = totalLen / N || 1;

  // unique query terms — a repeated query word shouldn't double-count its own idf contribution.
  const qUniq = [...new Set(qTerms)];
  const idf = new Map();
  for (const t of qUniq) {
    const n = df.get(t) || 0;
    // BM25 idf with the +1 inside the log so a term in every doc still scores >= 0 (never negative).
    idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  }

  const scored = [];
  for (let i = 0; i < N; i++) {
    const { tf, len } = docs[i];
    let score = 0;
    for (const t of qUniq) {
      const f = tf.get(t);
      if (!f) continue;
      const denom = f + K1 * (1 - B + B * (len / avgdl));
      score += idf.get(t) * (f * (K1 + 1)) / denom;
    }
    if (score > 0) scored.push({ entry: entries[i], score });
  }

  // BM25 descending; ties broken by recency (newer .t first; lexical compare works on ISO timestamps).
  scored.sort((a, b) => (b.score - a.score) || (String((b.entry && b.entry.t) || '') < String((a.entry && a.entry.t) || '') ? -1 : 1));

  const clamped = Math.min(Math.max(parseInt(k, 10) || 0, 1), scored.length);
  const out = [];
  for (let i = 0; i < clamped; i++) { const e = scored[i].entry; e.score = scored[i].score; out.push(e); }
  return out;
}

module.exports = { rank, tokenize, stripSpoken };
