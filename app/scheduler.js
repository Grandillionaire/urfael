'use strict';
// Persisted reminder scheduler — "remind me in 20 minutes" that actually fires, with no launchd
// plumbing. One JSON file (~/.claude/urfael/reminders.json), re-armed on daemon boot, ticked on a
// coarse interval (reminders are minute-grained, not millisecond-grained). Delivery is injected by
// the daemon so this module stays pure-ish and testable.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { normalizeReminder, normalizeCron, nextOccurrence } = require('./lib');

const DIR = path.join(os.homedir(), '.claude', 'urfael');
const FILE = path.join(DIR, 'reminders.json');
const CRON_FILE = path.join(DIR, 'cronjobs.json');
const MAX_ITEMS = 200; // sanity cap — the owner-only socket is trusted, but a buggy loop shouldn't fill the disk

let items = [];
let deliver = () => {};
let timer = null;

// Second, independent store: scheduled AGENT JOBS — each RUNS THE BRAIN on its schedule and DELIVERS the
// result (deliverCron is injected by the daemon, so this module never imports the brain). Re-armed on boot,
// ticked in the SAME interval as reminders. Reminders are untouched.
let crons = [];
let deliverCron = () => {};

function load() { try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); items = Array.isArray(j) ? j : []; } catch { items = []; } }
function save() { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(items, null, 2)); } catch {} }
function loadCron() { try { const j = JSON.parse(fs.readFileSync(CRON_FILE, 'utf8')); crons = Array.isArray(j) ? j : []; } catch { crons = []; } }
function saveCron() { try { fs.mkdirSync(path.dirname(CRON_FILE), { recursive: true }); fs.writeFileSync(CRON_FILE, JSON.stringify(crons, null, 2)); } catch {} }

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

function start(deliverFn, intervalMs = 20000) {
  deliver = deliverFn;
  load();
  clearInterval(timer);
  timer = setInterval(() => { try { tick(); } catch {} try { tickCron(); } catch {} }, intervalMs); // one interval drives both stores; a malformed store row must not stop the scheduler
  if (timer.unref) timer.unref();
}

// Wire cron delivery + re-arm the persisted cron store. Called by the daemon after start(); kept separate so
// the deliverCron closure (which spawns the sandboxed brain one-shot) is injected without coupling this module.
function startCron(deliverFn) { deliverCron = deliverFn; loadCron(); }

module.exports = { start, add, cancel, list, tick, startCron, addCron, cancelCron, listCron, getCron, tickCron };
