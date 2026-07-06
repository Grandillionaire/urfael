'use strict';
// app/reflect.js — SLEEP-TIME REFLECTION: Urfael's "soul". While the owner is idle, Urfael reflects on the day and
// GROWS with them — it re-consolidates the durable memory it already learned, mines the day's sessions for higher-
// level patterns ("across N sessions you keep deferring X"), and leaves a dated, inspectable, REVERSIBLE vault note.
// It NEVER acts on what it notices: every proactive nudge is QUEUED for the owner's review (notify/accept/edit/ignore),
// so this is a memory that tends itself without ever nagging, over-reaching, or fostering over-reliance.
//
// Prior art this borrows from (all permissively licensed; adapted, not copied):
//   • Letta "sleep-time compute" — a background agent that thinks between interactions to improve its memory
//     (Apache-2.0; Lin et al., arXiv:2504.13171). Here: an OFFLINE, idle-cadence pass, not a live turn.
//   • Stanford "Generative Agents" — periodic REFLECTION that synthesizes higher-level insights from a stream of
//     experience, fired a few times a day on accumulated salience, not every tick (Apache-2.0; Park et al. 2023).
//   • ACE (Agentic Context Engineering) — an evolving PLAYBOOK grown by mechanical, delta-style merges rather than
//     monolithic rewrites, so knowledge accretes without collapse (Apache-2.0; arXiv:2510.04618). Here: the note is
//     APPEND-ONLY and the ledger is re-consolidated by evidence, never wholesale-rewritten.
//   • LangChain "agent-inbox" — the notify/respond/edit/accept/ignore interrupt taxonomy for human-in-the-loop review
//     (MIT). Here: the NOTIFY-NOT-ACT nudge queue (notify/accept/edit/ignore).
//
// DESIGN RULES, non-negotiable and mirrored on learn.js/consolidate.js:
//   FAIL-CLOSED — every function fails closed on junk input (empty/neutral result, never an exception). The daemon
//     calls this from a timer; a bad ledger or a corrupt archive must degrade to "skip, log honestly", never a throw.
//   REUSE, don't reinvent — the trust machinery is learn.js (confidence + consolidate) and consolidate.js (near-dup
//     merge + evidence-based retire + secret redaction). This module orchestrates them; it does not re-implement them.
//   NO ACTIONS — there is deliberately NO branch here that schedules a reminder, edits another note, spawns a process,
//     or reaches the network. The strongest possible anti-over-reliance guarantee is structural: reflection can only
//     (1) re-consolidate the ledger it already owns, (2) write/append its OWN dated note, (3) queue a nudge for review.
//
// The daemon does the wiring (the idle tick, loading the day's archive, persisting the ledger); the pure logic +
// two atomic, never-throwing fs helpers (writeNote / inbox+state I/O, modeled on learn.load/save) live here so the
// whole pass is unit-testable in isolation against a temp dir.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const learn = require('./learn');             // the evidence ledger: confidence math + consolidate() retirement
const consolidate = require('./consolidate'); // dedupeLessons + selectRetirable + redact (all pure)

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

// ── tiny, dependency-free, ReDoS-safe helpers (mirror consolidate.js shapes so this stays a clean leaf) ──
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function tokenize(s) { return String(s == null ? '' : s).toLowerCase().match(/[a-z0-9]+/g) || []; }
function oneLine(s, max) { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return max && t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t; }
function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200); }
// accept epoch-ms OR ISO string; NaN when unparseable (callers treat NaN as "unknown" and fail closed)
function toMs(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const s = String(v).trim();
  if (s && /^[0-9.]+$/.test(s)) { const n = Number(s); return Number.isFinite(n) ? n : NaN; }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}
function isoDay(ms) { const d = new Date(num(ms, Date.now())); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10); }

// Conversational/function words carry no topic — excluded from theme + deferral mining so a query like "remind me
// about it later" doesn't make "remind"/"it"/"the" look like a recurring theme. Mirrors memctx.js's STOP intent.
const STOP = new Set(('a an the is are was were be been being am do does did doing have has had how what when where who whom '
  + 'which why we i you me my your his her our their it its this that these those of to in on for with at by from and or but '
  + 'as about please can could would should will shall may might must tell show give get let us if then so just only also very '
  + 'more most some any all no not into out up down over under again here there now today tomorrow yesterday sir yes ok okay '
  + 'need want like know think see thing things stuff really actually maybe back one two make made done urfael '
  // deferral-SIGNAL words are how we DETECT a deferral, not what is being deferred — never let them become a "topic"
  + 'later soon eventually pending todo backlog revisit defer deferred punt shelve hold later next another someday').split(/\s+/));
function contentTerms(text) { return [...new Set(tokenize(text))].filter((t) => t.length > 2 && !STOP.has(t)); }

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// 1) TRIGGER — fire on cadence/threshold, NOT every idle tick. Conservative + unobtrusive by default.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// Generative-Agents-style: reflect a FEW times a day when accumulated activity crosses a bar, never more often than
// minHoursBetween (so it can't nag), and at least once a day if anything happened at all. Pure; never throws.
//   state = { lastReflectAt(ms) }, turnsSince = count of archived turns since lastReflectAt.
const DEFAULT_TRIGGER = Object.freeze({
  minHoursBetween: 6,    // rate limit: at most ~2-3 reflections a day, so it stays unobtrusive
  minTurns: 8,           // "accumulated" path: enough of a day to be worth reflecting on
  activityThreshold: 20, // busy-day early fire: this much activity is worth a reflection even before the day is out
  maxHoursBetween: 24,   // daily floor: reflect once a day if there was ANY activity
});
function shouldReflect(state, turnsSince, now, opts) {
  const o = Object.assign({}, DEFAULT_TRIGGER, (opts && typeof opts === 'object') ? opts : {});
  const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const last = num(state && state.lastReflectAt, 0);
  const turns = Math.max(0, Math.floor(num(turnsSince, 0)));
  const sinceH = last > 0 ? (t - last) / HOUR_MS : Infinity;   // never reflected -> treat as "long ago"
  if (turns < 1) return { fire: false, reason: 'no-activity' };                 // nothing happened -> nothing to reflect on
  if (sinceH < o.minHoursBetween) return { fire: false, reason: 'too-soon' };   // rate limit (anti-nag) wins over everything
  if (turns >= o.activityThreshold) return { fire: true, reason: 'activity-threshold' };
  if (sinceH >= o.maxHoursBetween) return { fire: true, reason: 'daily-cadence' };
  if (turns >= o.minTurns) return { fire: true, reason: 'accumulated' };
  return { fire: false, reason: 'below-threshold' };
}

// ── read the day/window: archive entries at-or-after `sinceMs` (the daemon passes loadSessions()'s output). Pure.
function turnsSince(entries, sinceMs, nowMs) {
  const list = Array.isArray(entries) ? entries : [];
  const from = num(sinceMs, 0);
  const now = num(nowMs, Date.now());
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const t = toMs(e.t);
    if (!Number.isFinite(t)) continue;      // undated line fails closed (not counted, never throws)
    if (t >= from && t <= now + DAY_MS) out.push(e);   // small forward slack for clock skew
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// 2) CONSOLIDATE — reuse the EXISTING trust machinery to tend the ledger at rest. Pure; never throws.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// Exactly the pass the curator already runs, expressed as one reusable function: collapse near-duplicate lessons
// (keep the higher-confidence one, fold evidence — consolidate.dedupeLessons), retire the proven-useless / stale-
// unloved (learn.consolidate), then flag any remaining evidence-based retire candidates (consolidate.selectRetirable).
// verify-before-trust already happened when each lesson entered the ledger; this re-consolidates the trusted set so
// reflection keeps memory small, true, and non-redundant without ever re-spawning a verifier (no idle-time token burn).
// Returns { items, merged, retired, trustedCount, changed }. The daemon persists `items` only when `changed`.
function consolidatePass(items, now, opts) {
  const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  let list = Array.isArray(items) ? items.slice() : [];
  let merged = 0, retired = 0, changed = false;
  try {
    const dd = consolidate.dedupeLessons(list);
    if (dd.merged.length) { list = dd.kept; merged = dd.merged.length; changed = true; }
  } catch {}
  try {
    const lc = learn.consolidate(list, t, opts);   // mutates status in place; returns { items, retired:[] }
    if (lc.retired.length) { list = lc.items; retired += lc.retired.length; changed = true; }
  } catch {}
  try {
    const cand = consolidate.selectRetirable(list, t, opts);
    if (cand.length) {
      const ids = new Set(cand.map((r) => r.id));
      let flipped = 0;
      for (const it of list) { if (it && ids.has(it.id) && it.status !== 'retired') { it.status = 'retired'; flipped++; } }
      if (flipped) { retired += flipped; changed = true; }
    }
  } catch {}
  let trustedCount = 0;
  try { trustedCount = learn.trusted(list).length; } catch {}
  return { items: list, merged, retired, trustedCount, changed };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// 3) SYNTHESIZE — mine the day's sessions for higher-level patterns. DETERMINISTIC (no LLM, no spawn). Pure.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// This is the honest, offline approximation of Generative-Agents reflection: instead of asking a model "what did
// you learn today", we mechanically surface the two signals that most reward the owner's attention —
//   deferralPatterns : topics the owner keeps PUTTING OFF across ≥2 distinct sessions/days (the classic "you keep
//                       deferring X"), the strongest candidate for a (queued, never-acted) nudge; and
//   sessionThemes    : what the day actually centered on (top content terms), for the note's "Today" section.
// A false pattern here is harmless (it becomes a queued note, not an action); a missed one just isn't surfaced.
const turnText = (e) => (String((e && e.user) || '') + ' ' + String((e && e.urfael) || '')).trim();
const DEFER_RE = /\b(later|not now|not yet|tomorrow|next week|next time|another time|some ?day|eventually|down the line|put off|putting off|hold off|deprioriti[sz]e|defer|deferred|deferring|punt|shelve|shelved|circle back|revisit|come back to|still (?:need|have) to|haven'?t (?:yet|gotten)|todo|to-do|to do|when i (?:have|get) (?:time|a chance)|pending|on hold|backlog|remind me (?:to|later|again)|will (?:do|get to) (?:it|that))\b/i;
// Detect a topic being DEFERRED across multiple sessions. Group deferral-flagged turns by their content terms; a
// term deferred in ≥ minSessions DISTINCT days is a recurring deferral. Returns [{ topic, count, days, sample }].
function deferralPatterns(entries, opts) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  const o = (opts && typeof opts === 'object') ? opts : {};
  const minSessions = Math.max(2, Math.floor(num(o.minSessions, 2)));   // "recurring" means at least two distinct sessions
  const byTerm = new Map();   // term -> { days:Set, count, sample }
  for (const e of list) {
    const text = turnText(e);
    if (!text || !DEFER_RE.test(text)) continue;
    const day = isoDay(toMs(e.t));
    // only mine the USER's own words for the topic (what THEY keep deferring), not Urfael's reply phrasing
    for (const term of contentTerms(String((e && e.user) || ''))) {
      let rec = byTerm.get(term);
      if (!rec) { rec = { days: new Set(), count: 0, sample: '' }; byTerm.set(term, rec); }
      rec.days.add(day); rec.count++;
      if (!rec.sample) rec.sample = oneLine(consolidate.redact(String(e.user)), 140);
    }
  }
  const out = [];
  for (const [topic, rec] of byTerm) {
    if (rec.days.size >= minSessions) out.push({ topic, count: rec.count, days: [...rec.days].sort(), sample: rec.sample });
  }
  // strongest signal first: more distinct days, then more mentions, then stable alpha for determinism
  out.sort((a, b) => (b.days.length - a.days.length) || (b.count - a.count) || a.topic.localeCompare(b.topic));
  return out.slice(0, Math.max(1, Math.floor(num(o.max, 5))));
}
// What the window centered on: the most frequent content terms across all turns (both sides). Returns [{ term, count }].
function sessionThemes(entries, opts) {
  const list = Array.isArray(entries) ? entries : [];
  const o = (opts && typeof opts === 'object') ? opts : {};
  const minCount = Math.max(2, Math.floor(num(o.minCount, 2)));   // a one-off mention is not a "theme"
  const counts = new Map();
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    for (const term of contentTerms(turnText(e))) counts.set(term, (counts.get(term) || 0) + 1);
  }
  const out = [];
  for (const [term, count] of counts) if (count >= minCount) out.push({ term, count });
  out.sort((a, b) => (b.count - a.count) || a.term.localeCompare(b.term));
  return out.slice(0, Math.max(1, Math.floor(num(o.max, 8))));
}

// synthesize(windowTurns, consolidation, now, opts) -> the whole reflection payload, PURE + deterministic (identical
// input yields byte-identical output except nudge ids). `consolidation` is a consolidatePass() result (or null). Never throws.
function synthesize(entries, consolidation, now, opts) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && typeof e === 'object') : [];
  const o = (opts && typeof opts === 'object') ? opts : {};
  const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const cons = (consolidation && typeof consolidation === 'object') ? consolidation : { merged: 0, retired: 0, trustedCount: 0 };

  const days = new Set(), models = new Set(), channels = new Set();
  for (const e of list) { const d = isoDay(toMs(e.t)); if (d) days.add(d); if (e.model) models.add(String(e.model)); if (e.channel) channels.add(String(e.channel)); }
  const themes = sessionThemes(list, o);
  const deferrals = deferralPatterns(list, o);

  // Higher-level, plain-English reflections (deterministic sentences over the mined signals).
  const reflections = [];
  if (deferrals.length) for (const d of deferrals) {
    reflections.push('Across ' + d.days.length + ' session' + (d.days.length === 1 ? '' : 's') + ' you keep returning to but deferring [[' + d.topic + ']].');
  }
  if (themes.length) reflections.push('Today centered on ' + themes.slice(0, 4).map((x) => '[[' + x.term + ']]').join(', ') + '.');
  if (num(cons.merged, 0) || num(cons.retired, 0)) {
    reflections.push('Tended memory: merged ' + num(cons.merged, 0) + ' near-duplicate lesson' + (num(cons.merged, 0) === 1 ? '' : 's')
      + ', retired ' + num(cons.retired, 0) + ' proven-useless or stale, ' + num(cons.trustedCount, 0) + ' trusted lesson' + (num(cons.trustedCount, 0) === 1 ? '' : 's') + ' in play.');
  }

  // NOTIFY-NOT-ACT: turn recurring deferrals into QUEUED nudges. A nudge is a suggestion for the OWNER to review;
  // this code never schedules, reminds, or messages anyone. (Themes/consolidation are informational, not nudges.)
  const nudges = deferrals.map((d) => makeNudge({
    kind: 'deferral',
    text: 'You have deferred "' + d.topic + '" across ' + d.days.length + ' sessions — want to tackle or schedule it?',
    links: [d.topic],
    now: t,
  }));

  return {
    window: { from: days.size ? [...days].sort()[0] : '', to: days.size ? [...days].sort().slice(-1)[0] : '' },
    sessionCount: days.size, turnCount: list.length,
    models: [...models].sort(), channels: [...channels].sort(),
    themes, deferrals, reflections,
    ledger: { merged: num(cons.merged, 0), retired: num(cons.retired, 0), trustedCount: num(cons.trustedCount, 0) },
    nudges,
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// 4) NOTIFY-NOT-ACT — the review queue. Every nudge is QUEUED as 'pending'; nothing here ever acts. Pure.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// The taxonomy is the set of OWNER decisions on a pending nudge, adapted from LangChain agent-inbox:
//   notify  -> surface it (mildest: "just tell me")   accept -> the owner will act on it (marks accepted)
//   edit    -> the owner rewrote the nudge text        ignore -> dismiss it
// reviewNudge only ever RECORDS the decision (returns new data); it performs no side effect. There is intentionally
// no act()/execute()/schedule() in this module, so "a reflection can never act on its own" is true by construction.
const NUDGE_ACTIONS = Object.freeze(['notify', 'accept', 'edit', 'ignore']);
const NUDGE_MAX = 50;   // bounded queue — an always-on daemon can't grow the inbox unbounded
let _nctr = 0;
function nudgeId() { return 'n' + crypto.randomBytes(5).toString('hex') + (_nctr++).toString(36); }
function makeNudge(spec) {
  const s = (spec && typeof spec === 'object') ? spec : {};
  const now = Number.isFinite(Number(s.now)) ? Number(s.now) : Date.now();
  return {
    id: nudgeId(),
    kind: typeof s.kind === 'string' ? s.kind.slice(0, 40) : 'note',
    text: oneLine(consolidate.redact(String(s.text == null ? '' : s.text)), 300),   // redacted + bounded; never a live secret
    links: Array.isArray(s.links) ? s.links.map((l) => String(l).slice(0, 60)).slice(0, 8) : [],
    status: 'pending',        // QUEUED for review — never 'acted'
    action: null,             // the owner's decision, once reviewed
    createdAt: now, reviewedAt: null,
  };
}
// Enqueue a nudge, deduped by normalized text (never re-queue a nudge the owner already has pending/reviewed) and
// bounded (drop the oldest already-reviewed entry first, else the oldest). Returns a NEW array; input untouched.
function queueNudge(queue, nudge, opts) {
  const list = Array.isArray(queue) ? queue.slice() : [];
  if (!nudge || typeof nudge !== 'object' || !norm(nudge.text)) return list;   // junk nudge never enters the queue
  const key = norm(nudge.text);
  if (list.some((n) => n && norm(n.text) === key)) return list;                // already queued — no duplicate nag
  list.push(nudge);
  const cap = Math.max(1, Math.floor(num(opts && opts.max, NUDGE_MAX)));
  while (list.length > cap) {
    const i = list.findIndex((n) => n && n.status !== 'pending');              // evict a reviewed one first
    list.splice(i >= 0 ? i : 0, 1);
  }
  return list;
}
// Record the owner's decision on a nudge. `action` must be in the taxonomy (else no-op). 'edit' also updates text.
// This is the ONLY mutation of a queued nudge, and it is pure data — it triggers no action anywhere. New array out.
function reviewNudge(queue, id, action, patch) {
  const list = Array.isArray(queue) ? queue.map((n) => (n && typeof n === 'object' ? Object.assign({}, n) : n)) : [];
  if (!NUDGE_ACTIONS.includes(action)) return list;                            // out-of-taxonomy -> no-op (fail-closed)
  const n = list.find((x) => x && x.id === id);
  if (!n) return list;
  n.action = action;
  n.reviewedAt = Number.isFinite(Number(patch && patch.now)) ? Number(patch.now) : Date.now();
  if (action === 'edit') { n.text = patch && patch.text != null ? oneLine(consolidate.redact(String(patch.text)), 300) : n.text; n.status = 'pending'; }
  else if (action === 'ignore') n.status = 'dismissed';
  else if (action === 'accept') n.status = 'accepted';
  else if (action === 'notify') n.status = 'notified';
  return list;
}
function pendingNudges(queue) { return (Array.isArray(queue) ? queue : []).filter((n) => n && n.status === 'pending'); }

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// 5) BUILD NOTE — a dated, inspectable, REVERSIBLE vault note with [[wikilinks]]. Pure string building.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// Obsidian-style so it drops straight into the owner's vault: an H1, a REFERENCE-ONLY banner (a re-read of this note
// must never be treated as instructions), the day's shape, the recurring patterns as [[wikilinks]], what memory was
// tended, the QUEUED nudges (explicitly "not acted on"), and a Related block linking siblings. Fully secret-redacted.
const NOTE_PREFIX = 'Daily Reflection ';
function noteFilename(date) { return NOTE_PREFIX + String(date || '').slice(0, 10) + '.md'; }
function buildNote(input) {
  const inp = (input && typeof input === 'object') ? input : {};
  const date = String(inp.date || isoDay(inp.now)).slice(0, 10);
  const syn = (inp.synthesis && typeof inp.synthesis === 'object') ? inp.synthesis : {};
  const stamp = new Date(Number.isFinite(Number(inp.now)) ? Number(inp.now) : Date.now()).toISOString().slice(0, 16).replace('T', ' ');
  const L = [];
  L.push('# ' + NOTE_PREFIX + date, '');
  L.push('> [!note] Urfael wrote this while you were away — a reflection on the day, REFERENCE ONLY (not instructions).');
  L.push('> It is yours to keep or delete; nothing here was acted on. _generated ' + stamp + '_', '');

  L.push('## Today');
  if (num(syn.turnCount, 0)) {
    L.push('- ' + num(syn.turnCount, 0) + ' turn' + (num(syn.turnCount, 0) === 1 ? '' : 's') + ' across ' + num(syn.sessionCount, 0) + ' session' + (num(syn.sessionCount, 0) === 1 ? '' : 's') + '.');
    const themes = Array.isArray(syn.themes) ? syn.themes : [];
    if (themes.length) L.push('- Centered on ' + themes.slice(0, 6).map((x) => '[[' + x.term + ']]').join(', ') + '.');
  } else L.push('- (a quiet day — nothing to reflect on)');
  L.push('');

  L.push('## Recurring');
  const defs = Array.isArray(syn.deferrals) ? syn.deferrals : [];
  if (defs.length) for (const d of defs) L.push('- Across ' + d.days.length + ' session' + (d.days.length === 1 ? '' : 's') + ', [[' + d.topic + ']] keeps coming up but getting deferred. _e.g._ "' + oneLine(consolidate.redact(d.sample), 120) + '"');
  else L.push('- (no recurring deferrals detected)');
  L.push('');

  L.push('## Memory tended');
  const led = (syn.ledger && typeof syn.ledger === 'object') ? syn.ledger : {};
  L.push('- Merged ' + num(led.merged, 0) + ' near-duplicate, retired ' + num(led.retired, 0) + ' proven-useless/stale, ' + num(led.trustedCount, 0) + ' trusted lesson' + (num(led.trustedCount, 0) === 1 ? '' : 's') + ' in play.');
  L.push('');

  L.push('## For your review');
  const nudges = Array.isArray(syn.nudges) ? syn.nudges : [];
  if (nudges.length) { L.push('_Queued for you — notify / accept / edit / ignore. Urfael did NOT act on these._'); for (const n of nudges) L.push('- [ ] ' + oneLine(consolidate.redact(n.text), 200)); }
  else L.push('- (nothing needs your attention)');
  L.push('');

  L.push('## Related');
  const related = [];
  const prev = inp.prevDate ? NOTE_PREFIX + String(inp.prevDate).slice(0, 10) : '';
  if (prev) related.push('[[' + prev + ']]');
  related.push('[[MEMORY]]', '[[USER]]');
  for (const d of defs.slice(0, 5)) related.push('[[' + d.topic + ']]');
  L.push(related.map((r) => '- ' + r).join('\n'));
  L.push('');
  return L.join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// 6) fs helpers — atomic, NEVER-THROWING (modeled on learn.load/save). The ONLY places this module touches disk.
// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
// writeNote is the load-bearing "never mutates existing notes" guarantee: it can ONLY ever touch its OWN dated note
// (noteFilename(date)). If that note does not exist it CREATES it (atomic temp+rename); if it already exists (a same-
// day re-run) it APPENDS a fenced re-run section to ITS OWN note — never truncating prior content, never touching any
// other file. Returns { ok, path, created, appended }. Fails closed (ok:false) on any I/O error; never throws.
function writeNote(vaultDir, date, content, opts) {
  const out = { ok: false, path: '', created: false, appended: false };
  try {
    const dir = String(vaultDir || '');
    if (!dir) return out;
    const file = path.join(dir, noteFilename(date));
    out.path = file;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const body = String(content == null ? '' : content);
    let exists = false;
    try { fs.accessSync(file); exists = true; } catch {}
    if (!exists) {
      const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
      out.created = true;
    } else {
      const stamp = new Date(Number.isFinite(Number(opts && opts.now)) ? Number(opts.now) : Date.now()).toISOString().slice(0, 16).replace('T', ' ');
      fs.appendFileSync(file, '\n\n---\n\n_re-reflected ' + stamp + '_\n\n' + body + '\n');   // append-only to its OWN note
      out.appended = true;
    }
    out.ok = true;
  } catch {}
  return out;
}
// The prior reflection's date (for the note's Related [[wikilink]]): scan the vault for "Daily Reflection *.md" and
// return the newest date strictly before `beforeDate`, or '' if none. Read-only readdir; fail-closed to ''.
function prevReflectionDate(vaultDir, beforeDate) {
  try {
    const before = String(beforeDate || '').slice(0, 10);
    const dates = fs.readdirSync(String(vaultDir || ''))
      .map((f) => { const m = /^Daily Reflection (\d{4}-\d{2}-\d{2})\.md$/.exec(f); return m ? m[1] : null; })
      .filter((d) => d && (!before || d < before)).sort();
    return dates.length ? dates[dates.length - 1] : '';
  } catch { return ''; }
}
// Inbox (the persisted nudge queue) + state ({ lastReflectAt }): atomic JSON, fail-closed to a safe empty value.
function loadJson(file, fallback) {
  try { const raw = fs.readFileSync(file, 'utf8'); if (!raw.trim()) return fallback; const v = JSON.parse(raw); return v == null ? fallback : v; } catch { return fallback; }
}
function saveJson(file, value) {
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
    return true;
  } catch { return false; }
}
function loadInbox(file) { const v = loadJson(file, []); return Array.isArray(v) ? v : []; }
function saveInbox(file, queue) { return saveJson(file, Array.isArray(queue) ? queue.slice(0, NUDGE_MAX) : []); }
function loadState(file) { const v = loadJson(file, {}); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
function saveState(file, state) { return saveJson(file, (state && typeof state === 'object') ? state : {}); }

module.exports = {
  DAY_MS, HOUR_MS, DEFAULT_TRIGGER, NUDGE_ACTIONS, NUDGE_MAX, NOTE_PREFIX,
  // trigger + window
  shouldReflect, turnsSince,
  // consolidation (reuses learn + consolidate)
  consolidatePass,
  // synthesis (pure)
  synthesize, deferralPatterns, sessionThemes,
  // notify-not-act queue (pure)
  makeNudge, queueNudge, reviewNudge, pendingNudges,
  // note building (pure)
  noteFilename, buildNote,
  // fs helpers (atomic, never-throw)
  writeNote, prevReflectionDate, loadInbox, saveInbox, loadState, saveState,
  // exported for tests/reuse
  contentTerms,
};
