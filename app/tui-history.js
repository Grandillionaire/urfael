'use strict';
// tui-history.js — persistent, multi-line-aware input history for the cockpit. The file is JSON-per-line
// (so newlines in a multi-line prompt survive a round-trip), capped to the most recent CAP entries, 0600.
// The navigation (append/back/fwd) is PURE and unit-tested; the I/O (load/persist) is a thin, fail-soft shell.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(os.homedir(), '.claude', 'urfael', 'tui-history');
const CAP = 500;

// pure: append `text`, skipping a blank line or a consecutive duplicate, capped to CAP.
function append(list, text) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return list;
  if (list.length && list[list.length - 1] === t) return list;
  const next = list.concat([t]);
  return next.length > CAP ? next.slice(next.length - CAP) : next;
}

// pure navigation over { list, idx, draft }. idx === -1 means "at the live input" (the draft). back = older,
// fwd = newer; stepping forward past the newest returns to the draft. Returns the same shape plus `value`.
function back(state) {
  const list = state.list || [];
  if (!list.length) return { ...state, value: state.idx < 0 ? state.draft : (list[state.idx] || state.draft) };
  const idx = state.idx < 0 ? list.length - 1 : Math.max(0, state.idx - 1);
  return { ...state, idx, value: list[idx] };
}
function fwd(state) {
  const list = state.list || [];
  if (state.idx < 0) return { ...state, value: state.draft };
  const idx = state.idx + 1;
  if (idx >= list.length) return { ...state, idx: -1, value: state.draft };
  return { ...state, idx, value: list[idx] };
}

// I/O, fail-soft: never throw, never block the TUI.
function load() {
  try {
    const out = [];
    for (const ln of fs.readFileSync(FILE, 'utf8').split('\n')) {
      if (!ln) continue;
      try { const v = JSON.parse(ln); if (typeof v === 'string') out.push(v); } catch {}
    }
    return out.length > CAP ? out.slice(out.length - CAP) : out;
  } catch { return []; }
}
function persist(text) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(t) + '\n', { mode: 0o600 });
    try { fs.chmodSync(FILE, 0o600); } catch {}
  } catch {}
}

module.exports = { append, back, fwd, load, persist, FILE, CAP };
