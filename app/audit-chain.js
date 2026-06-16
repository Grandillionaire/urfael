'use strict';
// Ledger of Record — a tamper-evident, hash-chained activity log. Every significant event (a turn, a remote
// turn, a job/cron/hook fire, a learn verdict) appends ONE entry whose hash commits to the prior entry's hash:
//   h = sha256(prevH + canonicalJSON({seq, t, kind, payloadDigest, prevH}))
// so any single-byte edit, deleted line, or reordered pair anywhere in the history becomes mathematically
// detectable — `urfael audit --verify` walks the chain and reports the FIRST broken link by seq + line.
//
// The chain stores only a DIGEST of each event's payload, not the payload itself (the full content already lives
// in urfael.log / the session archive). So the ledger is the cheap, private integrity SPINE over those records:
// it proves WHAT happened and IN WHAT ORDER without copying transcript bodies. Pure + dependency-free + fail-
// closed (verify never throws); this is the honesty/trust DNA made cryptographically provable — provenance that
// OpenClaw (no per-action record) and Hermes (plain rewritable telemetry) structurally cannot produce.
const crypto = require('crypto');

const GENESIS = '0'.repeat(64); // the seed prevH for seq 0

// Deterministic JSON: object keys sorted recursively (arrays keep order, undefined-valued keys dropped like
// JSON.stringify), so a payload's key ORDER can never change its digest. The one non-trivial helper; unit-tested.
function canonicalJSON(o) {
  if (o === undefined) return 'null';
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(o[k])).join(',') + '}';
}
function digest(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
// The ONE link function both append and verify call, so they can never drift apart.
function linkHash(prevH, core) { return digest(String(prevH) + canonicalJSON(core)); }

// Build the next entry. `o` = { seq, t, kind, payload }. The chain commits to a digest of the payload, not the
// raw payload (privacy + size). Returns the full entry to append as one JSONL line.
function makeEntry(o, prevH) {
  const payloadDigest = digest(canonicalJSON(o && o.payload !== undefined ? o.payload : {}));
  const core = { seq: o.seq, t: o.t, kind: o.kind, payloadDigest, prevH: String(prevH) };
  return { ...core, h: linkHash(prevH, core) };
}

// Verify an array of JSONL lines (strings). Recomputes every link from GENESIS. Returns {ok:true, through, count}
// or {ok:false, brokenSeq, brokenLine, reason}. Pure — no fs, no throw — so it's directly unit-testable and the
// daemon/CLI/dashboard all share one verifier.
function verify(lines) {
  if (!Array.isArray(lines)) return { ok: false, reason: 'bad_input', brokenSeq: -1, brokenLine: 0 };
  let prevH = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let e; try { e = JSON.parse(lines[i]); } catch { return { ok: false, reason: 'bad_json', brokenSeq: i, brokenLine: i + 1 }; }
    if (e.seq !== i) return { ok: false, reason: 'seq_gap', brokenSeq: i, brokenLine: i + 1 };           // deleted/reordered
    if (e.prevH !== prevH) return { ok: false, reason: 'broken_prev', brokenSeq: i, brokenLine: i + 1 };  // a link was severed
    const expect = linkHash(prevH, { seq: e.seq, t: e.t, kind: e.kind, payloadDigest: e.payloadDigest, prevH: e.prevH });
    if (expect !== e.h) return { ok: false, reason: 'hash_mismatch', brokenSeq: i, brokenLine: i + 1 };   // content was edited
    prevH = e.h;
  }
  return { ok: true, through: lines.length - 1, count: lines.length, head: prevH };
}

module.exports = { GENESIS, canonicalJSON, digest, linkHash, makeEntry, verify };
