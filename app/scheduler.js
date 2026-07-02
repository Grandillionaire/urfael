'use strict';
// Persisted reminder scheduler — "remind me in 20 minutes" that actually fires, with no launchd
// plumbing. One JSON file (~/.claude/urfael/reminders.json), re-armed on daemon boot, ticked on a
// coarse interval (reminders are minute-grained, not millisecond-grained). Delivery is injected by
// the daemon so this module stays pure-ish and testable.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { normalizeReminder, normalizeCron, normalizeWatch, nextOccurrence } = require('./lib');
const { isAlive } = require('./jobstore');

const DIR = path.join(os.homedir(), '.claude', 'urfael');
const FILE = path.join(DIR, 'reminders.json');
const CRON_FILE = path.join(DIR, 'cronjobs.json');
const WATCHES_FILE = path.join(DIR, 'watches.json');
const MAX_ITEMS = 200; // sanity cap — the owner-only socket is trusted, but a buggy loop shouldn't fill the disk
const MAX_FILE_WATCHERS = 128; // FD guard: a glob over a huge tree (or many watches) must not exhaust file handles

let items = [];
let deliver = () => {};
let timer = null;

// Second, independent store: scheduled AGENT JOBS — each RUNS THE BRAIN on its schedule and DELIVERS the
// result (deliverCron is injected by the daemon, so this module never imports the brain). Re-armed on boot,
// ticked in the SAME interval as reminders. Reminders are untouched.
let crons = [];
let deliverCron = () => {};

// Third, independent store: LOCAL EVENT TRIGGERS ("watches") — each wakes the BRAIN when a local event happens
// (a file changes, a directory subtree sees activity, or a watched pid exits). EVENT/POLL-armed, not time-math:
// file/glob arm an fs.watch with a debounce-collapse; pid rides the SAME 20s interval as reminders/crons via
// tickWatch. deliverWatch is injected by the daemon (this module never imports the brain). Runtime handles +
// liveness live in side maps so the persisted JSON stays a pure spec. Reminders + crons are untouched.
let watches = [];
let deliverWatch = () => {};
let watchersStarted = false;
let aliveFn = isAlive;                 // PID liveness; injectable for tests (deterministic transitions)
const wruntime = new Map();            // id -> { close?, debounced? } — RUNTIME only, NEVER persisted
const wpidAlive = new Map();           // id -> last-known liveness for pid watches — RUNTIME only, NEVER persisted

function load() { try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); items = Array.isArray(j) ? j : []; } catch { items = []; } }
function save() { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(items, null, 2)); } catch {} }
function loadCron() { try { const j = JSON.parse(fs.readFileSync(CRON_FILE, 'utf8')); crons = Array.isArray(j) ? j : []; } catch { crons = []; } }
function saveCron() { try { fs.mkdirSync(path.dirname(CRON_FILE), { recursive: true }); fs.writeFileSync(CRON_FILE, JSON.stringify(crons, null, 2)); } catch {} }
function loadWatches() { try { const j = JSON.parse(fs.readFileSync(WATCHES_FILE, 'utf8')); watches = Array.isArray(j) ? j : []; } catch { watches = []; } }
function saveWatches() { try { fs.mkdirSync(path.dirname(WATCHES_FILE), { recursive: true }); const tmp = WATCHES_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(watches, null, 2), { mode: 0o600 }); fs.renameSync(tmp, WATCHES_FILE); } catch {} }
function newId() { return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'); }

function add(spec) {
  const n = normalizeReminder(spec);
  if (!n || items.length >= MAX_ITEMS) return null;
  const r = { id: Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'), ...n, createdAt: new Date().toISOString() };
  if (r.repeat) nextOccurrence(r);                 // a repeating spec dated in the past starts at its next occurrence
  items.push(r); save();
  return r;
}
function cancel(id) { const i = items.findIndex((r) => r.id === id); if (i < 0) return false; items.splice(i, 1); save(); return true; }
function list() { return items.slice().sort((a, b) => a.at - b.at); }

function addCron(spec) {
  const n = normalizeCron(spec);
  if (!n || crons.length >= MAX_ITEMS) return null;
  const c = { id: Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'), ...n, createdAt: new Date().toISOString() };
  if (c.repeat) nextOccurrence(c);                 // a repeating spec dated in the past starts at its next occurrence
  crons.push(c); saveCron();
  return c;
}
function cancelCron(id) { const i = crons.findIndex((c) => c.id === id); if (i < 0) return false; crons.splice(i, 1); saveCron(); return true; }
function listCron() { return crons.slice().sort((a, b) => a.at - b.at); }
function getCron(id) { return crons.find((c) => c.id === id) || null; }

function tick(now = Date.now()) {
  let changed = false;
  for (const r of items.slice()) {
    if (r.at > now) continue;
    try { deliver(r); } catch {}
    changed = true;
    if (!nextOccurrence(r, now)) items.splice(items.indexOf(r), 1);
  }
  if (changed) save();
}

function tickCron(now = Date.now()) {
  let changed = false;
  for (const c of crons.slice()) {
    if (c.at > now) continue;
    try { deliverCron(c); } catch {}            // injected by the daemon — never coupled to the brain here
    changed = true;
    if (!nextOccurrence(c, now)) crons.splice(crons.indexOf(c), 1);   // one-shots fire once then drop
  }
  if (changed) saveCron();
}

function addWatch(spec) {
  const n = normalizeWatch(spec);
  if (!n || watches.length >= MAX_ITEMS) return null;
  const w = { id: newId(), ...n, createdAt: new Date().toISOString() };
  watches.push(w); saveWatches();
  if (watchersStarted) armWatch(w);   // event-armed: a new watch must start watching NOW, not at the next boot
  return w;
}
function cancelWatch(id) { const i = watches.findIndex((w) => w.id === id); if (i < 0) return false; disarmWatch(id); watches.splice(i, 1); saveWatches(); return true; }
function listWatch() { return watches.slice(); }
function getWatch(id) { return watches.find((w) => w.id === id) || null; }

// A trailing-edge debouncer with INJECTABLE timers, so the exact collapse the armed file-watcher uses is also
// unit-testable with a fake clock. fs.watch fires 1-2 events per save (and editors that atomic-rename fire more);
// this collapses a burst to ONE fire per quiet window. Returns a trigger() with a .cancel().
function makeDebouncer(waitMs, fire, setT, clearT) {
  setT = setT || setTimeout; clearT = clearT || clearTimeout;
  let t = null;
  const trigger = () => { if (t != null) clearT(t); t = setT(() => { t = null; try { fire(); } catch {} }, waitMs); };
  trigger.cancel = () => { if (t != null) { clearT(t); t = null; } };
  return trigger;
}

function fileWatcherCount() { let n = 0; for (const s of wruntime.values()) if (s && s.close) n++; return n; }

// Arm ONE watch. file/glob → an fs.watch (recursive for glob) with a debounce-collapse; a platform without
// recursive support (older Linux) OR a target fs.watch can't open falls back to a polling fs.watchFile. pid →
// a baseline liveness recorded here, then polled in tickWatch. Fail-closed: any arm failure leaves the watch in
// the store UNARMED rather than crashing the daemon.
function armWatch(w) {
  if (!w || wruntime.has(w.id)) return;
  if (w.on === 'pid') {
    wruntime.set(w.id, { pid: true });
    wpidAlive.set(w.id, aliveFn(w.target));    // baseline; fire ONLY on a true -> false (alive -> exited) transition
    return;
  }
  if (fileWatcherCount() >= MAX_FILE_WATCHERS) return;   // FD guard: leave in the store, unarmed
  const state = { lastPath: w.target, close: null };
  const debounced = makeDebouncer(w.debounceMs, () => onWatchFire(w, { path: state.lastPath }));
  state.debounced = debounced;
  const onEvent = (ev, fname) => { if (fname) { try { state.lastPath = path.join(w.target, String(fname)); } catch {} } debounced(); };
  let handle = null;
  try {
    handle = fs.watch(w.target, w.on === 'glob' ? { recursive: true } : {}, onEvent);
    if (handle && typeof handle.on === 'function') handle.on('error', () => {}); // a deleted/rotated target must not crash the daemon
  } catch {
    try {
      fs.watchFile(w.target, { interval: Math.max(w.debounceMs, 1000) }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs || String(cur.ino) !== String(prev.ino)) { state.lastPath = w.target; debounced(); } });
      handle = { close: () => { try { fs.unwatchFile(w.target); } catch {} } };
    } catch { return; }   // couldn't arm at all — leave it in the store, unarmed (fail-closed, no crash)
  }
  state.close = () => { try { handle && handle.close(); } catch {} try { debounced.cancel(); } catch {} };
  wruntime.set(w.id, state);
}

function disarmWatch(id) {
  const s = wruntime.get(id);
  if (s) { try { s.close && s.close(); } catch {} wruntime.delete(id); }
  wpidAlive.delete(id);
}

// Fire ONE watch. For a one-shot (the default), DISARM + remove from the store BEFORE delivering, fail-closed:
// a crash mid-fire can never double-fire on restart. repeat watches stay armed.
function onWatchFire(w, meta) {
  if (!w.repeat) {
    disarmWatch(w.id);
    const i = watches.findIndex((x) => x.id === w.id);
    if (i >= 0) { watches.splice(i, 1); saveWatches(); }
  }
  try { deliverWatch(w, meta || {}); } catch {}   // injected by the daemon — never coupled to the brain here
}

// PID watches ride the existing 20s interval (no extra timer): fire on the alive -> exited transition.
function tickWatch(now = Date.now()) {
  let fired = false;
  for (const w of watches.slice()) {
    if (w.on !== 'pid' || !wruntime.has(w.id)) continue;
    const alive = aliveFn(w.target);
    const was = wpidAlive.get(w.id);
    wpidAlive.set(w.id, alive);
    if (was && !alive) { onWatchFire(w, { exitPid: w.target }); fired = true; }
  }
  return fired;
}

function start(deliverFn, intervalMs = 20000) {
  deliver = deliverFn;
  load();
  clearInterval(timer);
  timer = setInterval(() => { try { tick(); } catch {} try { tickCron(); } catch {} try { tickWatch(); } catch {} }, intervalMs); // one interval drives all three stores; a malformed store row must not stop the scheduler
  if (timer.unref) timer.unref();
}

// Wire watch delivery + re-arm the persisted watch store. Called by the daemon after start(); kept separate so
// the deliverWatch closure (which wakes the no-egress brain) is injected without coupling this module. opts.isAlive
// overrides the PID liveness check (tests inject a deterministic sequence). Idempotent: re-invoking re-reconciles.
function startWatchers(fireFn, opts) {
  deliverWatch = fireFn || (() => {});
  aliveFn = (opts && typeof opts.isAlive === 'function') ? opts.isAlive : isAlive;
  for (const id of [...wruntime.keys()]) disarmWatch(id);
  loadWatches();
  watchersStarted = true;
  for (const w of watches.slice()) armWatch(w);
}

// Wire cron delivery + re-arm the persisted cron store. Called by the daemon after start(); kept separate so
// the deliverCron closure (which spawns the sandboxed brain one-shot) is injected without coupling this module.
function startCron(deliverFn) { deliverCron = deliverFn; loadCron(); }

module.exports = { start, add, cancel, list, tick, startCron, addCron, cancelCron, listCron, getCron, tickCron,
  startWatchers, addWatch, cancelWatch, listWatch, getWatch, tickWatch, makeDebouncer };
