'use strict';
// Persisted reminder scheduler — "remind me in 20 minutes" that actually fires, with no launchd
// plumbing. One JSON file (~/.claude/urfael/reminders.json), re-armed on daemon boot, ticked on a
// coarse interval (reminders are minute-grained, not millisecond-grained). Delivery is injected by
// the daemon so this module stays pure-ish and testable.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { normalizeReminder, normalizeCron, normalizeWatch, nextOccurrence, atomicWriteJSON, envOn } = require('./lib');
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
// Cron reliability hardening (opt-in URFAEL_CRON_HARDEN=1; DEFAULT OFF). Injected by the daemon via startCron opts;
// both stay dormant unless the flag is flipped, so the shipped default fire path + persisted store shape are
// byte-identical. See tickCron / cronDecision below.
let livePinFn = () => null;       // returns the live brain pin { provider, model } (or null when unknown)
let cronNotifyFn = null;          // OPTIONAL sink for a skipped-run notice (drift/stale); console.error fallback

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

// FS-watch + timer primitives, injectable so the atomic-save RE-ARM path (armWatch, below) is unit-testable with a
// fake clock/handle. Defaults to the real node:fs + global timers; startWatchers({ watchIO }) overrides them for tests.
const REAL_IO = {
  watch: (p, opts, cb) => fs.watch(p, opts, cb),
  watchFile: (p, opts, cb) => fs.watchFile(p, opts, cb),
  unwatchFile: (p) => fs.unwatchFile(p),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};
let _io = REAL_IO;

// Read a durable store. A MISSING/unreadable file is a normal first boot → start fresh, silently. But a file that
// EXISTS yet is corrupt (truncated by an old non-atomic crash, or not a JSON array) is NEVER silently reset to
// empty — that would lose the owner's reminders/crons under the sovereignty promise. Quarantine it (rename to
// <file>.corrupt-<n>) so the owner can recover it, log loudly, then start fresh.
function loadStore(file, label) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }   // ENOENT / unreadable → fresh, no file to lose
  let parsed; try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  if (Array.isArray(parsed)) return parsed;
  quarantineCorrupt(file, label);
  return [];
}
function quarantineCorrupt(file, label) {
  try {
    let n = 0, dest;
    do { dest = file + '.corrupt-' + n; n++; } while (fs.existsSync(dest) && n < 10000); // never clobber an earlier quarantine
    fs.renameSync(file, dest);
    console.error('[urfael] ' + label + ' store at ' + file + ' was corrupt; quarantined to ' + dest + ' and started fresh (your data is recoverable there).');
  } catch (e) {
    console.error('[urfael] ' + label + ' store at ' + file + ' was corrupt and could not be quarantined: ' + ((e && e.message) || e));
  }
}
function load() { items = loadStore(FILE, 'reminders'); }
function save() { try { atomicWriteJSON(FILE, items); } catch {} }
function loadCron() { crons = loadStore(CRON_FILE, 'cronjobs'); }
function saveCron() { try { atomicWriteJSON(CRON_FILE, crons); } catch {} }
function loadWatches() { watches = loadStore(WATCHES_FILE, 'watches'); }               // quarantine a corrupt store, never silently wipe
function saveWatches() { try { atomicWriteJSON(WATCHES_FILE, watches); } catch {} }     // crash-safe atomic write (unique tmp + fsync + rename)
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
  if (hardenOn()) {                                // opt-in: pin the brain this job was authored against, for drift-skip at fire time
    let p = null; try { p = livePinFn(); } catch {}
    if (p && p.provider != null) c.pin = { provider: String(p.provider), model: p.model == null ? null : String(p.model) };
  }
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

// ---- CRON RELIABILITY HARDENING (opt-in: URFAEL_CRON_HARDEN=1) ----------------------------------------------
// Default OFF: hardenOn() is false, tickCron takes the ORIGINAL branch verbatim, addCron records no pin, and the
// persisted store shape + fire order are byte-identical to the shipped default (proven by the flag-off parity test).
// When the owner flips it on, two FAIL-CLOSED guards engage — both can only ever REDUCE fires, never add one:
//   (a) MISSED-RUN SINGLE-GRACE: a repeat job whose window was slept/crashed through fires EXACTLY ONCE on the next
//       tick if its due time is still within a BOUNDED grace; missed by more than the bound => SKIPPED (advanced,
//       not fired stale). nextOccurrence already collapses N missed windows to one advance, so there is never a
//       catch-up storm, and lastRun is stamped BEFORE delivery so a crash mid-fire cannot double-fire on restart.
//   (b) PROVIDER-DRIFT FAIL-CLOSED: a job that recorded the brain it was authored against (pin) is SKIPPED if that
//       pin no longer matches the live config at fire time, rather than silently running on a different brain. A
//       job with no pin (the flag-off authoring shape) can never drift, so this is a pure no-op there.
// idea from NousResearch/hermes-agent (MIT), patterns only, NO code copied.
const CRON_MISS_GRACE_MS = 3600000;   // 1h bound: a repeat job overdue by more than this is too stale to fire, only re-armed
function hardenOn() { return envOn(process.env.URFAEL_CRON_HARDEN); }
function samePin(a, b) {               // fail-closed equality: an unknown side (null) never matches a recorded pin
  if (!a || !b) return false;
  return String(a.provider) === String(b.provider) && String(a.model == null ? '' : a.model) === String(b.model == null ? '' : b.model);
}
// Pure per-job fire decision, evaluated ONLY under the flag for a job already known to be due (c.at <= now).
// Returns { fire, reason }: fire=true runs it once; fire=false advances WITHOUT running (drift/stale/already-ran).
// Computed purely from the recorded pin/lastRun/at vs now — no side effects, so it is unit-testable in isolation.
function cronDecision(c, now, graceMs, livePin) {
  const at = typeof (c && c.at) === 'number' ? c.at : now;
  if (c && c.pin && !samePin(c.pin, livePin)) return { fire: false, reason: 'drift' };            // (b) never run on a drifted brain
  if (typeof (c && c.lastRun) === 'number' && c.lastRun >= at) return { fire: false, reason: 'already-ran' }; // idempotence: this occurrence already fired
  if (now - at > graceMs) return { fire: false, reason: 'stale' };                                // (a) bounded grace: too stale, re-arm only
  return { fire: true, reason: 'due' };
}
function emitCronSkip(c, reason, now) {
  const info = { ev: 'cron_skip', id: c && c.id, reason, at: c && c.at, now, pin: (c && c.pin) || null };
  if (typeof cronNotifyFn === 'function') { try { cronNotifyFn(info); return; } catch {} }
  console.error('[urfael] cron ' + (c && c.id) + ' skipped (' + reason + '): not fired on this tick (fail-closed).');
}

function tickCron(now = Date.now()) {
  if (hardenOn()) return tickCronHardened(now);
  // ORIGINAL fire path — reached whenever URFAEL_CRON_HARDEN is unset, so it stays byte-identical to the shipped default.
  let changed = false;
  for (const c of crons.slice()) {
    if (c.at > now) continue;
    try { deliverCron(c); } catch {}            // injected by the daemon — never coupled to the brain here
    changed = true;
    if (!nextOccurrence(c, now)) crons.splice(crons.indexOf(c), 1);   // one-shots fire once then drop
  }
  if (changed) saveCron();
}

// Hardened twin of tickCron: SAME due filter + SAME single-advance, plus the two fail-closed guards above. Only ever
// reached when URFAEL_CRON_HARDEN=1. A non-fire outcome advances the job WITHOUT delivering (never a stale/drifted run).
function tickCronHardened(now) {
  let changed = false;
  let livePin = null; try { livePin = livePinFn(); } catch {}
  for (const c of crons.slice()) {
    if (c.at > now) continue;                             // not due yet — IDENTICAL filter to the normal path (no retro-fire of a future job)
    const d = cronDecision(c, now, CRON_MISS_GRACE_MS, livePin);
    if (d.fire) { c.lastRun = now; try { deliverCron(c); } catch {} }  // stamp lastRun BEFORE delivery so a crash mid-fire cannot double-fire
    else emitCronSkip(c, d.reason, now);                  // loud, bounded notice — a skip is never silent
    changed = true;
    if (!nextOccurrence(c, now)) crons.splice(crons.indexOf(c), 1);    // one advance collapses N missed windows; one-shots drop
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
  const recursive = w.on === 'glob';
  const state = { lastPath: w.target, close: null, handle: null, rearmT: null, closed: false };
  const debounced = makeDebouncer(w.debounceMs, () => onWatchFire(w, { path: state.lastPath }), _io.setTimeout, _io.clearTimeout);
  state.debounced = debounced;

  const closeHandle = () => { try { state.handle && state.handle.close(); } catch {} state.handle = null; };

  // (re-)open an fs.watch on the target. A target fs.watch can't open (absent mid-swap, or no recursive support on
  // older Linux) falls back to a polling fs.watchFile that UPGRADES back to fs.watch once the target reappears.
  function openWatch() {
    if (state.closed) return;
    try {
      const h = _io.watch(w.target, recursive ? { recursive: true } : {}, onEvent);
      if (h && typeof h.on === 'function') h.on('error', () => {}); // a deleted/rotated target must not crash the daemon
      state.handle = h;
    } catch { openPoll(); }
  }
  function openPoll() {
    if (state.closed) return;
    try {
      _io.watchFile(w.target, { interval: Math.max(w.debounceMs, 1000) }, (cur, prev) => {
        if (cur.mtimeMs !== prev.mtimeMs || String(cur.ino) !== String(prev.ino)) { state.lastPath = w.target; debounced(); }
        if (!recursive && cur.ino && String(cur.ino) !== '0') { try { _io.unwatchFile(w.target); } catch {} openWatch(); } // target back → upgrade to fs.watch
      });
      state.handle = { close: () => { try { _io.unwatchFile(w.target); } catch {} } };
    } catch {}
  }

  // Editors save atomically: write a temp file, then rename it OVER the target. That fires a 'rename' and leaves this
  // fs.watch bound to the now-unlinked OLD inode — it fires ONCE, then goes silently dead. For a single-file watch,
  // close the orphaned handle and RE-ARM after the debounce window so "watch this file" survives ordinary saves. A
  // glob watches the directory subtree (its inode survives the swap) and never needs a re-arm.
  function scheduleRearm() {
    if (state.closed || state.rearmT != null) return;   // collapse a burst of rename events onto ONE re-arm
    state.rearmT = _io.setTimeout(() => {
      state.rearmT = null;
      if (state.closed) return;
      closeHandle();
      openWatch();
    }, w.debounceMs);
  }

  function onEvent(ev, fname) {
    if (fname) { try { state.lastPath = path.join(w.target, String(fname)); } catch {} }
    debounced();
    if (ev === 'rename' && w.on === 'file') scheduleRearm();
  }

  openWatch();
  if (!state.handle) return;   // couldn't arm at all — leave it in the store, unarmed (fail-closed, no crash)
  state.close = () => {
    state.closed = true;
    if (state.rearmT != null) { try { _io.clearTimeout(state.rearmT); } catch {} state.rearmT = null; }
    closeHandle();
    try { debounced.cancel(); } catch {}
  };
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
  _io = (opts && opts.watchIO) ? opts.watchIO : REAL_IO;   // injectable fs-watch/timer seam (tests); real node:fs otherwise
  for (const id of [...wruntime.keys()]) disarmWatch(id);
  loadWatches();
  watchersStarted = true;
  for (const w of watches.slice()) armWatch(w);
}

// Wire cron delivery + re-arm the persisted cron store. Called by the daemon after start(); kept separate so
// the deliverCron closure (which spawns the sandboxed brain one-shot) is injected without coupling this module.
// opts (optional, all dormant unless URFAEL_CRON_HARDEN=1): { livePin } injects the live-brain reader used for the
// drift-skip guard; { notify } injects the skipped-run notice sink (console.error is the fallback). A single-arg call
// (the historical shape) leaves both at their inert defaults, so the flag-off path is unchanged.
function startCron(deliverFn, opts) {
  deliverCron = deliverFn;
  if (opts && typeof opts.livePin === 'function') livePinFn = opts.livePin;
  if (opts && typeof opts.notify === 'function') cronNotifyFn = opts.notify;
  loadCron();
}

module.exports = { start, add, cancel, list, tick, startCron, addCron, cancelCron, listCron, getCron, tickCron,
  startWatchers, addWatch, cancelWatch, listWatch, getWatch, tickWatch, makeDebouncer, cronDecision };
