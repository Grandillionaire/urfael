'use strict';
// The evidence LEDGER - the data layer of Urfael's self-verifying learning loop. Pure logic + atomic
// JSON persistence; no brain, no network. Today distill() writes lessons and TRUSTS them immediately
// (like Hermes). This module is the spine of the better loop: a lesson is PROPOSED, independently
// VERIFIED (correct? general? safe?), only then TRUSTED. The ledger tracks confidence + usage evidence
// (surfaced/helped/corrected) so consolidation can retire what proved weak.
//
// FAIL-CLOSED is the law of this file: any parse failure, missing field, or bad input resolves to the
// SAFEST outcome (not trusted, confidence 0) and NOTHING here ever throws on bad input.
//
// A ledger ITEM:
//   { id, type:'lesson'|'skill'|'user', ref, source, learnedAt(ms), status:'proposed'|'trusted'|'retired',
//     confidence(0..1), verify:{correct,general,safe,confidence,note}|null,
//     surfaced, helped, corrected, lastUsed(ms|null) }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEDGER_FILE = 'ledger.json';
const TYPES = ['lesson', 'skill', 'user'];
const DAY_MS = 86400000;

// --- helpers ---------------------------------------------------------------

function clamp01(n) { const x = Number(n); return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0; }
function isType(t) { return TYPES.includes(t); }

// dedup key: a stable, whitespace-insensitive, length-bounded form of a ref string.
function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200); }

// Short stable unique id. crypto bytes give uniqueness across runs/restarts; the per-process counter
// guarantees no collision WITHIN a run even if two ids are minted in the same crypto-random draw.
let _ctr = 0;
function id() { return crypto.randomBytes(6).toString('hex') + (_ctr++).toString(36); }

// --- persistence (atomic, never-throws) ------------------------------------

// Read the ledger array. Missing / empty / corrupt / non-array all fail-closed to []; never throws.
function load(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, LEDGER_FILE), 'utf8');
    if (!raw.trim()) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// Atomic write: serialize to a unique tmp file in the same dir, then rename over the target (rename is
// atomic on the same filesystem, so a reader never sees a half-written ledger). Swallows all errors.
function save(dir, items) {
  try {
    const target = path.join(dir, LEDGER_FILE);
    const tmp = path.join(dir, '.' + LEDGER_FILE + '.' + process.pid + '.' + id() + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(Array.isArray(items) ? items : [], null, 2));
    try { fs.renameSync(tmp, target); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  } catch {}
}

// --- confidence math -------------------------------------------------------

// Confidence a verdict justifies on its own: weighted vote (correct .4 / general .3 / safe .3) scaled by
// the verifier's own self-reported confidence. A bad/missing verdict is worth 0 (fail-closed).
function initialConfidence(verdict) {
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) return 0;
  // STRICT booleans only: a stringified "false" (or any truthy non-true) from a JSON/LLM layer must NOT count
  // as a yes — that would invert the fail-closed contract and trust a bad lesson.
  const vote = (verdict.correct === true ? 0.4 : 0) + (verdict.general === true ? 0.3 : 0) + (verdict.safe === true ? 0.3 : 0);
  return clamp01(vote * clamp01(verdict.confidence));
}

// Fold usage evidence into the verdict-derived base. base = what verification earned (or a modest 0.3
// for a trusted item with no recorded verdict). evidence in (0,1] tilts up with help, down with
// corrections: (helped+1)/(helped+corrected+1). Sets and returns item.confidence.
function recompute(item) {
  if (!item || typeof item !== 'object') return 0;
  let base = initialConfidence(item.verify);
  if (!base && item.status === 'trusted') base = 0.3;
  const helped = Number(item.helped) || 0;
  const corrected = Number(item.corrected) || 0;
  const evidence = (helped + 1) / (helped + corrected + 1);
  item.confidence = clamp01(base * evidence);
  return item.confidence;
}

// --- ledger operations -----------------------------------------------------

// Dedup by type+norm(ref). Existing match => returned untouched (isNew:false, no duplicate). Otherwise a
// fresh PROPOSED item (confidence 0, verify null, all counters 0, lastUsed null). Invalid type or empty
// ref => {item:null, isNew:false} (fail-closed: a junk proposal never enters the ledger).
function upsert(items, opts) {
  const list = Array.isArray(items) ? items : [];
  const o = opts && typeof opts === 'object' ? opts : {};
  const type = o.type;
  const ref = typeof o.ref === 'string' ? o.ref : '';
  if (!isType(type) || !norm(ref)) return { items: list, item: null, isNew: false };
  const key = norm(ref);
  const existing = list.find((it) => it && it.type === type && norm(it.ref) === key);
  if (existing) return { items: list, item: existing, isNew: false };
  const now = Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now();
  const item = {
    id: id(), type, ref, source: typeof o.source === 'string' ? o.source : '',
    learnedAt: now, status: 'proposed', confidence: 0, verify: null,
    surfaced: 0, helped: 0, corrected: 0, lastUsed: null,
  };
  list.push(item);
  return { items: list, item, isNew: true };
}

// Independent verification result lands here. TRUSTED only if the verdict says correct AND safe (a
// correct-but-unsafe lesson is retired, not trusted); anything else retires. confidence is reset to what
// the verdict alone earned. Unknown id => items unchanged.
function applyVerdict(items, itemId, verdict, now) {
  const list = Array.isArray(items) ? items : [];
  const item = list.find((it) => it && it.id === itemId);
  if (!item) return list;
  const v = verdict && typeof verdict === 'object' && !Array.isArray(verdict) ? verdict : null;
  item.verify = v;
  item.status = (v && v.correct === true && v.safe === true) ? 'trusted' : 'retired'; // strict: only a real `true` trusts
  item.confidence = initialConfidence(v);
  return list;
}

// Surface signal: active recall injected this item into a turn's context (it was shown to the brain, relevant to
// the message). Bumps `surfaced` + lastUsed. This is the evidence consolidate() uses to retire a lesson that keeps
// surfacing but never helps (surfaced>=3, helped=0, corrected>=1 -> useless). Unknown id -> unchanged. Never throws.
function surface(items, itemId, now) {
  const list = Array.isArray(items) ? items : [];
  const item = list.find((it) => it && it.id === itemId);
  if (!item) return list;
  item.surfaced = (Number(item.surfaced) || 0) + 1;
  item.lastUsed = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  return list;
}

// Positive usage signal: the item surfaced and the answer landed. Bumps helped + lastUsed, recomputes.
function reinforce(items, itemId, now) {
  const list = Array.isArray(items) ? items : [];
  const item = list.find((it) => it && it.id === itemId);
  if (!item) return list;
  item.helped = (Number(item.helped) || 0) + 1;
  item.lastUsed = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  recompute(item);
  return list;
}

// Negative usage signal: the item was applied and the owner corrected it. Bumps corrected, recomputes,
// and retires it once its confidence falls below the 0.2 floor (proven-wrong lessons stop surfacing).
function markCorrected(items, itemId, now) {
  const list = Array.isArray(items) ? items : [];
  const item = list.find((it) => it && it.id === itemId);
  if (!item) return list;
  item.corrected = (Number(item.corrected) || 0) + 1;
  recompute(item);
  if (item.confidence < 0.2) item.status = 'retired';
  return list;
}

// Periodic gardening. Retire (unless already retired) an item that is either:
//   - proven useless: surfaced enough to judge (>=3), never helped, and corrected at least once; OR
//   - stale + unloved: low confidence, never surfaced, older than staleDays.
function consolidate(items, now, opts) {
  const list = Array.isArray(items) ? items : [];
  const o = opts && typeof opts === 'object' ? opts : {};
  const retireBelow = Number.isFinite(Number(o.retireBelow)) ? Number(o.retireBelow) : 0.25;
  const staleDays = Number.isFinite(Number(o.staleDays)) ? Number(o.staleDays) : 30;
  const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const staleMs = staleDays * DAY_MS;
  const retired = [];
  for (const it of list) {
    if (!it || typeof it !== 'object' || it.status === 'retired') continue;
    const surfaced = Number(it.surfaced) || 0;
    const helped = Number(it.helped) || 0;
    const corrected = Number(it.corrected) || 0;
    const conf = Number(it.confidence) || 0;
    const learnedAt = Number(it.learnedAt) || 0;
    let reason = null;
    if (surfaced >= 3 && helped === 0 && corrected >= 1) reason = 'useless';
    else if (conf < retireBelow && surfaced === 0 && (t - learnedAt) > staleMs) reason = 'stale';
    if (reason) { it.status = 'retired'; retired.push({ id: it.id, ref: it.ref, reason }); }
  }
  return { items: list, retired };
}

// --- views -----------------------------------------------------------------

// Trusted items, strongest first - what the brain should actually surface.
function trusted(items) {
  return (Array.isArray(items) ? items : [])
    .filter((it) => it && it.status === 'trusted')
    .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0));
}

// Ledger snapshot for the dashboard/telemetry.
function stats(items) {
  const list = Array.isArray(items) ? items : [];
  const out = { total: 0, trusted: 0, proposed: 0, retired: 0, byType: { lesson: 0, skill: 0, user: 0 }, avgConfidence: 0 };
  let sum = 0;
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    out.total++;
    if (it.status === 'trusted') out.trusted++;
    else if (it.status === 'proposed') out.proposed++;
    else if (it.status === 'retired') out.retired++;
    if (isType(it.type)) out.byType[it.type]++;
    sum += Number(it.confidence) || 0;
  }
  out.avgConfidence = out.total ? sum / out.total : 0;
  return out;
}

module.exports = {
  LEDGER_FILE, load, save, norm, id, upsert, initialConfidence, applyVerdict,
  surface, reinforce, markCorrected, recompute, consolidate, trusted, stats,
};
