'use strict';
// Memory Journey — a READ-ONLY projection of Urfael's OWN git-versioned memory into a belief/lesson graph.
// A projection built from scratch over Urfael's OWN
// git history + Ledger of Record. This module is PURE: no fs, no exec, no net, no listener, and it NEVER throws.
// The daemon runs the one injection-safe `git log -p` over the `why` file set and hands the raw text here; this
// file only PARSES + PROJECTS it. Nothing is persisted — the graph is derived on demand and thrown away.
//
// What it produces from the drift stream (single-sources cli.js's `%x01%h%x1f%ci%x1f%s` + unified-diff format):
//   NODES  = distinct beliefs (added memory lines) and lessons (lines whose text matches a learn-ledger ref),
//            keyed by normalized text, each carrying its git SHA(s) as an immutable provenance handle.
//   EDGES  = revisions: within ONE commit a removed bullet paired to a similar added bullet -> old->new, labelled
//            with the real SHA + date + memory-pass name. Pairing is conservative + purely COSMETIC; the SHA is
//            always real, so no false provenance is ever asserted.
//   LEDGER = the audit-chain.verify RESULT passed IN (we never recompute) — a whole-chain tamper-evidence signal.
//
// Honesty: the hash-chained ledger stores only payload DIGESTS and learn verdicts are BATCH-count events, so there
// is NO per-lesson ledger seq. We therefore prove a node ONLY by its git SHA (real, `git show <sha>`-reproducible)
// and prove the ledger ONLY as a whole chain. This module deliberately emits NO per-lesson seq / inclusion field.
const provenance = require('./provenance');   // pure passName()/fullDate() label helpers (no git, no daemon)

const VERSION = 1;
const MAX_NODES = 400;         // hard cap so a long history can never bloat the payload or the browser
const MAX_EDGES = 800;         // revision edges cap (kept proportional to the node cap)
const LABEL_MAX = 200;         // every attacker-influenceable label is truncated server-side
const PAIR_THRESHOLD = 0.45;   // conservative revision-pairing floor (prefix OR token-overlap similarity)

// Normalize a memory line to a stable dedup/match key: strip a leading markdown bullet or number marker, lowercase,
// collapse whitespace, trim, bound length. Matches learn.norm's shape so lesson refs line up with belief lines.
function norm(s) {
  return String(s == null ? '' : s)
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
    .toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
}
function cap(s) { const t = String(s == null ? '' : s); return t.length > LABEL_MAX ? t.slice(0, LABEL_MAX) : t; }
function commonPrefixLen(a, b) { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a[i] === b[i]) i++; return i; }

// Similarity of two normalized bullet texts: max of (shared-prefix fraction, token Jaccard). Identical texts score
// 0 (a no-op move is not a revision). Purely cosmetic — it only decides EDGE PAIRING, never provenance.
function similarity(na, nb) {
  if (!na || !nb || na === nb) return 0;
  const prefScore = commonPrefixLen(na, nb) / Math.max(na.length, nb.length);
  const ta = na.split(' ').filter(Boolean), tb = nb.split(' ').filter(Boolean);
  const sa = new Set(ta), sb = new Set(tb);
  let inter = 0; for (const t of sa) if (sb.has(t)) inter++;
  const uni = sa.size + sb.size - inter;
  const jac = uni ? inter / uni : 0;
  return Math.max(prefScore, jac);
}

// parseDrift(gitLogPText) -> [{ sha, date, subject, added:[{text,file}], removed:[{text,file}] }] newest-first.
// Single-sources the `drift` format: blocks split on \x01; header (up to first \n) split on \x1f -> [sha, ci, subj];
// a diff line starting '+' (not '+++') is an added belief, '-' (not '---') a removed one; '+++ b/<file>' sets the
// current file for attribution. Empty / non-string / garbage -> []. NEVER throws.
function parseDrift(text) {
  const out = [];
  try {
    if (typeof text !== 'string' || !text) return out;
    for (const block of text.split('\x01')) {
      if (!block.trim()) continue;
      const nl = block.indexOf('\n');
      const head = nl < 0 ? block : block.slice(0, nl);
      if (head.indexOf('\x1f') < 0) continue;   // the drift header ALWAYS carries \x1f field separators; anything else is not a record (guards garbage input)
      const parts = head.split('\x1f');
      const sha = String(parts[0] || '').trim();
      if (!sha) continue;
      const date = String(parts[1] || '').trim();
      const subject = String(parts[2] || '').trim();
      const added = [], removed = [];
      let file = '';
      if (nl >= 0) {
        for (const ln of block.slice(nl + 1).split('\n')) {
          if (ln.startsWith('+++')) { const m = /^\+\+\+ (?:b\/)?(.+)$/.exec(ln); if (m) file = m[1].trim(); continue; }
          if (ln.startsWith('---')) continue;
          if (ln.startsWith('diff --git')) { const m = /b\/(\S+)\s*$/.exec(ln); if (m) file = m[1]; continue; }
          if (ln.startsWith('+')) { const c = ln.slice(1).trim(); if (c) added.push({ text: c, file }); }
          else if (ln.startsWith('-')) { const c = ln.slice(1).trim(); if (c) removed.push({ text: c, file }); }
        }
      }
      out.push({ sha, date, subject, added, removed });
    }
  } catch { return []; }
  return out;
}

// Coerce the audit-chain.verify RESULT (passed IN, never recomputed) to a safe, minimal ledger badge. Missing /
// garbage -> {ok:false}. When ok===false we surface brokenSeq so the view can render the "LEDGER BROKEN" banner.
function ledgerBadge(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false };
  if (v.ok === true) {
    const b = { ok: true };
    if (Number.isFinite(Number(v.through))) b.through = Number(v.through);
    if (typeof v.head === 'string') b.head = v.head.slice(0, 64);
    return b;
  }
  const b = { ok: false };
  if (Number.isFinite(Number(v.brokenSeq))) b.brokenSeq = Number(v.brokenSeq);
  if (typeof v.reason === 'string') b.reason = v.reason.slice(0, 40);
  return b;
}

// buildGraph({ gitLogText, learnItems, ledger, limits }) -> { nodes, edges, ledger, truncated }.
// Pure + deterministic + never-throws. `ledger` is the audit-chain.verify RESULT (input, not recomputed).
function buildGraph(input) {
  const EMPTY = { nodes: [], edges: [], ledger: { ok: false }, truncated: false };
  try {
    const o = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const limits = o.limits && typeof o.limits === 'object' ? o.limits : {};
    const maxNodes = Number.isFinite(Number(limits.maxNodes)) && Number(limits.maxNodes) > 0 ? Math.min(Number(limits.maxNodes), MAX_NODES) : MAX_NODES;
    const commits = parseDrift(o.gitLogText);
    const learnItems = Array.isArray(o.learnItems) ? o.learnItems : [];
    const ledger = ledgerBadge(o.ledger);

    // lesson index: norm(ref) -> the learn item (last write wins; ledger is small). Only real lesson-shaped items.
    const lessonByKey = new Map();
    for (const it of learnItems) {
      if (!it || typeof it !== 'object') continue;
      const k = norm(it.ref);
      if (k) lessonByKey.set(k, it);
    }

    // Nodes keyed by normalized text. git log is newest-first, so the FIRST sighting of a key is its NEWEST event
    // and fixes the current status: an add => alive, a remove (paired revision OR unpaired retire) => retired at that
    // SHA. Later (older) sightings only push firstSha/firstDate back to the belief's birth; they NEVER flip the
    // current status (an older add under a newer removal must stay retired).
    const nodeByKey = new Map();
    function ensureNode(key, ev) {
      let n = nodeByKey.get(key);
      if (!n) {
        n = { key, label: cap(ev.text), file: String(ev.file || ''), lastSha: ev.sha, lastDate: ev.date,
          firstSha: ev.sha, firstDate: ev.date, subject: ev.subject,
          retired: ev.event === 'retire', retiredSha: ev.event === 'retire' ? ev.sha : null };
        nodeByKey.set(key, n);
      } else {
        n.firstSha = ev.sha; n.firstDate = ev.date;   // older sighting (walking newest -> oldest)
        if (!n.file && ev.file) n.file = ev.file;
      }
      return n;
    }

    const rawEdges = [];   // { fromKey, toKey, sha, date, subject } — resolved to node ids after the cap
    for (const c of commits) {
      const added = Array.isArray(c.added) ? c.added : [];
      const removed = Array.isArray(c.removed) ? c.removed : [];
      // conservative revision pairing: greedily match each removed bullet to its single best similar added bullet.
      const addKeys = added.map((a) => ({ a, k: norm(a.text) })).filter((x) => x.k);
      const remKeys = removed.map((r) => ({ r, k: norm(r.text) })).filter((x) => x.k);
      const usedAdd = new Set();
      const revisedTo = new Map();   // remKey -> addKey for the paired removes (so they record a 'retire' event too)
      for (const rem of remKeys) {
        let best = -1, bestScore = 0;
        for (let i = 0; i < addKeys.length; i++) {
          if (usedAdd.has(i) || addKeys[i].k === rem.k) continue;
          const s = similarity(rem.k, addKeys[i].k);
          if (s > bestScore) { bestScore = s; best = i; }
        }
        if (best >= 0 && bestScore >= PAIR_THRESHOLD) {
          usedAdd.add(best);
          revisedTo.set(rem.k, addKeys[best].k);
          rawEdges.push({ fromKey: rem.k, toKey: addKeys[best].k, sha: c.sha, date: c.date, subject: c.subject });
        }
      }
      // Record every added belief (event 'add') and every removed belief (event 'retire' — whether paired or not;
      // a revised-away belief IS retired, the edge shows what it became).
      for (const a of addKeys) ensureNode(a.k, { text: a.a.text, file: a.a.file, sha: c.sha, date: c.date, subject: c.subject, event: 'add' });
      for (const r of remKeys) ensureNode(r.k, { text: r.r.text, file: r.r.file, sha: c.sha, date: c.date, subject: c.subject, event: 'retire' });
    }

    // classify lessons + attach ledger-derived {status, confidence, verifyNote}. NO per-lesson seq is ever added.
    for (const n of nodeByKey.values()) {
      const it = lessonByKey.get(n.key);
      if (it) {
        n.kind = 'lesson';
        n.status = typeof it.status === 'string' ? it.status : 'proposed';
        n.confidence = Number.isFinite(Number(it.confidence)) ? Number(it.confidence) : 0;
        n.verifyNote = it && it.verify && typeof it.verify.note === 'string' ? cap(it.verify.note) : '';
      } else {
        n.kind = 'belief';
      }
    }

    // deterministic order: kind (lesson first), newest lastDate first, then key. Cap to maxNodes (truncate oldest).
    let nodes = [...nodeByKey.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'lesson' ? -1 : 1;
      if (a.lastDate !== b.lastDate) return a.lastDate < b.lastDate ? 1 : -1;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    let truncated = false;
    if (nodes.length > maxNodes) { nodes = nodes.slice(0, maxNodes); truncated = true; }

    // assign stable ids + build a key->id map; drop nodes' internal key from the public shape.
    const idByKey = new Map();
    const outNodes = nodes.map((n, i) => {
      const id = 'n' + i;
      idByKey.set(n.key, id);
      const node = { id, kind: n.kind, label: n.label, file: n.file, sha: n.lastSha, firstSha: n.firstSha,
        date: provenance.fullDate(n.lastDate), pass: provenance.passName(n.subject), retired: !!n.retired };
      if (n.retiredSha) node.retiredSha = n.retiredSha;
      if (n.kind === 'lesson') { node.status = n.status; node.confidence = n.confidence; if (n.verifyNote) node.verifyNote = n.verifyNote; }
      return node;
    });

    // resolve edges to ids (both endpoints must survive the cap), dedupe, sort, cap, label.
    const seen = new Set();
    let outEdges = [];
    for (const e of rawEdges) {
      const from = idByKey.get(e.fromKey), to = idByKey.get(e.toKey);
      if (!from || !to || from === to) continue;
      const sig = e.sha + '|' + from + '|' + to;
      if (seen.has(sig)) continue; seen.add(sig);
      outEdges.push({ from, to, type: 'revision', sha: e.sha,
        date: provenance.fullDate(e.date), pass: provenance.passName(e.subject),
        label: 'revised on ' + provenance.fullDate(e.date) });
    }
    outEdges.sort((a, b) => (a.sha < b.sha ? 1 : a.sha > b.sha ? -1 : 0) || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    if (outEdges.length > MAX_EDGES) { outEdges = outEdges.slice(0, MAX_EDGES); truncated = true; }
    outEdges = outEdges.map((e, i) => ({ id: 'e' + i, ...e }));

    return { nodes: outNodes, edges: outEdges, ledger, truncated };
  } catch { return EMPTY; }
}

module.exports = { parseDrift, buildGraph, MAX_NODES, VERSION };
