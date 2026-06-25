'use strict';
// LOCAL-FIRST calendar event store. The owner's events live on THEIR OWN disk, git-versioned in the
// memory repo for sovereignty (MEMORY_DIR/calendar.json, exactly where the daemon keeps audit-chain,
// seals, and sessions). No database, no cloud, no inbound port. This module is Node-stdlib only and
// pure-ish: the helpers take a `store` and return a NEW store (no hidden global), so they are trivially
// unit-testable without a daemon. Persistence is fail-soft (a missing/corrupt file yields an EMPTY store,
// never a throw) and fail-closed on input (a bad event is REJECTED, not silently mangled).
//
// SECURITY POSTURE (mirrors scheduler.js / the daemon boundary):
//  - The schedule/calendar channel is LOCAL-ONLY. This module never opens a socket and never reaches the
//    network; reachability is the DAEMON's job. It must wire cal-add/move/cancel on the LOCAL turn only
//    (profile.name === 'local'), never on askScoped / a remote chat channel. See the integration notes.
//  - It can ONLY touch calendar events. It holds no credentials, no keys, no permissions.
//  - All fields are bounded + sanitized here so a buggy/hostile caller can't store the year 3000, a 10MB
//    note, or control characters that would corrupt the ICS export.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- bounds (sanity caps; the owner socket is trusted, but a buggy loop shouldn't fill the disk) -------
const MAX_TITLE = 300;
const MAX_NOTES = 4000;
const MAX_LOCATION = 300;
const MAX_EVENTS = 5000;                 // hard cap on the store
const YEAR_MS = 525600 * 60000;          // 1 year (same horizon scheduler uses)
const MAX_FUTURE_MS = 5 * YEAR_MS;       // events may be scheduled up to ~5y out
const MAX_PAST_MS = 10 * YEAR_MS;        // and recorded up to ~10y back (history is legitimate)
const MAX_DURATION_MS = 366 * 24 * 3600 * 1000; // a single event spans at most ~1 year

// Stable id, same scheme as scheduler.js / jobstore.js: sortable ms prefix + random tail. Injectable
// clock + entropy so a test can assert exact ids; defaults are real time + 4 random bytes.
function newId(nowMs = Date.now(), rand) {
  const tail = rand || crypto.randomBytes(4).toString('hex');
  return Number(nowMs).toString(36) + '-' + tail;
}

// ---- field coercion -------------------------------------------------------------------------------------
// Accept an ISO 8601 string OR an epoch-millis number; return epoch ms, or null if unparseable. Strings
// are parsed with Date.parse (handles ISO with or without tz). A bare finite number is treated as ms.
function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    // a pure integer string is epoch ms (so callers can pass either form); otherwise parse as a date.
    if (/^-?\d+$/.test(s)) { const n = Number(s); return Number.isFinite(n) ? n : null; }
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

// Strip control chars (incl. CR/LF, which would otherwise break ICS line folding / inject fields) and
// collapse runs of whitespace; then bound the length. Returns '' for non-strings.
function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Normalize a raw event spec into a stored event, or null (fail-closed). Bounds-clamped so the past, the
// far future, a negative duration, or junk fields can never enter the store.
function normalizeEvent(spec, nowMs = Date.now()) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const title = cleanText(spec.title, MAX_TITLE);
  if (!title) return null;
  const start = toMs(spec.start);
  if (start == null) return null;
  if (start > nowMs + MAX_FUTURE_MS) return null;   // too far out
  if (start < nowMs - MAX_PAST_MS) return null;      // implausibly old
  let end = spec.end != null ? toMs(spec.end) : null;
  if (end != null) {
    if (end < start) return null;                    // no negative-duration events (fail-closed)
    if (end - start > MAX_DURATION_MS) end = start + MAX_DURATION_MS; // clamp absurd spans
  }
  const ev = { title, start };
  if (end != null) ev.end = end;
  const notes = cleanText(spec.notes, MAX_NOTES);
  if (notes) ev.notes = notes;
  const location = cleanText(spec.location, MAX_LOCATION);
  if (location) ev.location = location;
  return ev;
}

// ---- store shape ----------------------------------------------------------------------------------------
// A store is { version: 1, events: [ {id, title, start(ms), end?(ms), notes?, location?, createdAt(ISO),
// updatedAt?(ISO), canceledAt?(ISO)} ] }. Canceled events are KEPT (tombstoned) so the git history stays
// honest and a cancel is itself a versioned fact; listEvents/upcoming/toICS skip them by default.
function emptyStore() { return { version: 1, events: [] }; }

// Coerce ANY parsed JSON into a well-formed store (defensive: a hand-edited or partially corrupt file must
// not crash the daemon). Unknown/garbage events are dropped, not thrown on.
function coerceStore(raw) {
  const store = emptyStore();
  if (!raw || typeof raw !== 'object') return store;
  const arr = Array.isArray(raw.events) ? raw.events : (Array.isArray(raw) ? raw : []);
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const id = typeof e.id === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(e.id) ? e.id : null;
    const start = toMs(e.start);
    const title = cleanText(e.title, MAX_TITLE);
    if (!id || start == null || !title) continue;
    const ev = { id, title, start, createdAt: typeof e.createdAt === 'string' ? e.createdAt : new Date(start).toISOString() };
    const end = e.end != null ? toMs(e.end) : null;
    if (end != null && end >= start) ev.end = end;
    const notes = cleanText(e.notes, MAX_NOTES); if (notes) ev.notes = notes;
    const location = cleanText(e.location, MAX_LOCATION); if (location) ev.location = location;
    if (typeof e.updatedAt === 'string') ev.updatedAt = e.updatedAt;
    if (typeof e.canceledAt === 'string') ev.canceledAt = e.canceledAt;
    store.events.push(ev);
    if (store.events.length >= MAX_EVENTS) break;
  }
  return store;
}

// Shallow-ish clone so helpers stay pure: callers get a NEW store + NEW events array; we never mutate the
// store passed in. (Event objects themselves are recreated when changed.)
function cloneStore(store) {
  const s = coerceStore(store);   // also normalizes/repairs in one shot
  return s;
}

// ---- mutations (pure: take a store, return {.., store}) -------------------------------------------------
// addEvent(store, spec) -> { event, store } | { error, store }. The store is never mutated; on success a
// NEW store with the appended event is returned. Stable id. Fail-closed: a bad spec returns {error} and the
// ORIGINAL (cloned) store unchanged.
function addEvent(store, spec, opts = {}) {
  const next = cloneStore(store);
  const nowMs = opts.nowMs || Date.now();
  const n = normalizeEvent(spec, nowMs);
  if (!n) return { error: 'invalid event (need a non-empty title and a valid start within bounds; end must be >= start)', store: next };
  if (next.events.length >= MAX_EVENTS) return { error: 'calendar full', store: next };
  const event = { id: opts.id || newId(nowMs, opts.rand), ...n, createdAt: new Date(nowMs).toISOString() };
  next.events.push(event);
  return { event, store: next };
}

// moveEvent(store, id, newStartISO, newEndISO?) -> { ok, event?, store }. Reschedules an existing,
// non-canceled event. newEnd is optional; if omitted and the event had a duration, the duration is PRESERVED
// (shift). Fail-closed: unknown id or unparseable date -> { ok:false }.
function moveEvent(store, id, newStart, newEnd, opts = {}) {
  const next = cloneStore(store);
  const nowMs = opts.nowMs || Date.now();
  const i = next.events.findIndex((e) => e.id === id && !e.canceledAt);
  if (i < 0) return { ok: false, store: next };
  const start = toMs(newStart);
  if (start == null) return { ok: false, store: next };
  if (start > nowMs + MAX_FUTURE_MS || start < nowMs - MAX_PAST_MS) return { ok: false, store: next };
  const prev = next.events[i];
  let end;
  if (newEnd != null) {
    end = toMs(newEnd);
    if (end == null || end < start) return { ok: false, store: next };
  } else if (prev.end != null) {
    end = start + (prev.end - prev.start);            // preserve the original duration on a bare shift
  }
  if (end != null && end - start > MAX_DURATION_MS) end = start + MAX_DURATION_MS;
  const event = { ...prev, start, updatedAt: new Date(nowMs).toISOString() };
  if (end != null) event.end = end; else delete event.end;
  next.events[i] = event;
  return { ok: true, event, store: next };
}

// cancelEvent(store, id) -> { ok, store }. Tombstones the event (keeps it, sets canceledAt) so the cancel is
// a versioned fact rather than a silent deletion. Idempotent-ish: canceling an already-canceled or unknown
// id returns { ok:false }.
function cancelEvent(store, id, opts = {}) {
  const next = cloneStore(store);
  const nowMs = opts.nowMs || Date.now();
  const i = next.events.findIndex((e) => e.id === id && !e.canceledAt);
  if (i < 0) return { ok: false, store: next };
  next.events[i] = { ...next.events[i], canceledAt: new Date(nowMs).toISOString() };
  return { ok: true, store: next };
}

// ---- queries (read-only) --------------------------------------------------------------------------------
// listEvents(store, {fromISO, toISO}) -> active events whose START falls in [from, to], sorted by start.
// Either bound may be omitted (open range). Canceled events are excluded.
function listEvents(store, range = {}) {
  const s = coerceStore(store);
  const from = range.fromISO != null ? toMs(range.fromISO) : null;
  const to = range.toISO != null ? toMs(range.toISO) : null;
  return s.events
    .filter((e) => !e.canceledAt)
    .filter((e) => (from == null || e.start >= from) && (to == null || e.start <= to))
    .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// upcoming(store, n, nowMs) -> the next n active events at or after `now`, soonest first. n is clamped 1..200.
function upcoming(store, n = 5, nowMs = Date.now()) {
  const s = coerceStore(store);
  const k = Math.min(Math.max(parseInt(n, 10) || 5, 1), 200);
  return s.events
    .filter((e) => !e.canceledAt && e.start >= nowMs)
    .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, k);
}

// getEvent(store, id) -> the event (incl. canceled) or null.
function getEvent(store, id) {
  const s = coerceStore(store);
  return s.events.find((e) => e.id === id) || null;
}

// ---- ICS export -----------------------------------------------------------------------------------------
// toICS(events) -> a minimal, valid RFC 5545 iCalendar string for the given events (e.g. the output of
// listEvents/upcoming). UTC timestamps (the Z form) so it is timezone-unambiguous. Canceled events are
// skipped. Text fields are escaped + lines folded at 75 octets per the spec.
function icsEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}
function icsTime(ms) {
  // YYYYMMDDTHHMMSSZ
  const d = new Date(ms);
  const p = (x, w = 2) => String(x).padStart(w, '0');
  return p(d.getUTCFullYear(), 4) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + 'T' +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
}
// Fold a content line to <=75 octets, continuation lines begin with a single space (RFC 5545 3.1).
function foldLine(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out = [];
  let cur = '';
  for (const ch of line) {                      // iterate by code point so we never split a multibyte char
    if (Buffer.byteLength(cur + ch, 'utf8') > 75) { out.push(cur); cur = ' ' + ch; }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out.join('\r\n');
}
function toICS(events, opts = {}) {
  const list = Array.isArray(events) ? events : [];
  const stampMs = opts.nowMs || Date.now();
  const dtstamp = icsTime(stampMs);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Urfael//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  for (const e of list) {
    if (!e || e.canceledAt || typeof e.start !== 'number') continue;
    const uid = (typeof e.id === 'string' && e.id ? e.id : newId(stampMs)) + '@urfael.local';
    lines.push('BEGIN:VEVENT');
    lines.push(foldLine('UID:' + icsEscape(uid)));
    lines.push('DTSTAMP:' + dtstamp);
    lines.push('DTSTART:' + icsTime(e.start));
    if (typeof e.end === 'number') lines.push('DTEND:' + icsTime(e.end));
    lines.push(foldLine('SUMMARY:' + icsEscape(e.title || '(untitled)')));
    if (e.location) lines.push(foldLine('LOCATION:' + icsEscape(e.location)));
    if (e.notes) lines.push(foldLine('DESCRIPTION:' + icsEscape(e.notes)));
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// ---- persistence (MEMORY_DIR/calendar.json; 0600; atomic temp+rename; fail-soft) -----------------------
// load(filePath) NEVER throws: a missing or corrupt file yields an EMPTY store (fail-soft). The store is
// run through coerceStore so even a partially-valid file loads its good rows.
function load(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return coerceStore(JSON.parse(raw));
  } catch {
    return emptyStore();
  }
}

// save(filePath, store) -> true|false. Atomic (write a sibling .tmp then rename, so a crash mid-write can't
// leave a half-file), 0600 (owner-only, like every other secret/state file the daemon writes), fail-soft
// (returns false instead of throwing). The parent dir is created if absent (matches scheduler.save()).
function save(filePath, store) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    const data = JSON.stringify(coerceStore(store), null, 2) + '\n';
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}   // belt + suspenders if the file pre-existed at a looser mode
    return true;
  } catch {
    return false;
  }
}

// Resolve the canonical store path from a MEMORY_DIR (the daemon passes its own MEMORY_DIR so this module
// never has to re-derive ~/Urfael-memory and the two can't drift).
function pathFor(memoryDir) { return path.join(memoryDir, 'calendar.json'); }

module.exports = {
  // mutations
  addEvent, moveEvent, cancelEvent,
  // queries
  listEvents, upcoming, getEvent,
  // export
  toICS,
  // persistence
  load, save, pathFor,
  // building blocks (exported for the daemon + tests)
  newId, normalizeEvent, coerceStore, emptyStore, toMs, cleanText,
  // bounds (so callers/tests can reference the same constants)
  MAX_TITLE, MAX_NOTES, MAX_LOCATION, MAX_EVENTS,
};
