'use strict';
// Persisted reminder scheduler — "remind me in 20 minutes" that actually fires, with no launchd
// plumbing. One JSON file (~/.claude/urfael/reminders.json), re-armed on daemon boot, ticked on a
// coarse interval (reminders are minute-grained, not millisecond-grained). Delivery is injected by
// the daemon so this module stays pure-ish and testable.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { normalizeReminder, nextOccurrence } = require('./lib');

const FILE = path.join(os.homedir(), '.claude', 'urfael', 'reminders.json');
const MAX_ITEMS = 200; // sanity cap — the owner-only socket is trusted, but a buggy loop shouldn't fill the disk

let items = [];
let deliver = () => {};
let timer = null;

function load() { try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); items = Array.isArray(j) ? j : []; } catch { items = []; } }
function save() { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(items, null, 2)); } catch {} }

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

function start(deliverFn, intervalMs = 20000) {
  deliver = deliverFn;
  load();
  clearInterval(timer);
  timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
}

module.exports = { start, add, cancel, list, tick };
