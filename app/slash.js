'use strict';
// app/slash.js — the in-session slash-command surface for the cockpit (`urfael tui`). PURE + unit-tested: it owns
// the command CATALOG and the typeahead MATCHER; tui.js is the thin shell that renders the menu and runs the chosen
// action. Two rules, borrowed from registry.js: (1) HONESTY — every command here maps to a real action tui.js can
// perform right now (a daemon endpoint or a local key), never a nice-to-have; (2) SINGLE SOURCE OF TRUTH — the menu,
// the Tab-completion, and `/help` all derive from COMMANDS, so they can never drift. The matcher only does prefix /
// indexOf over a bounded buffer (no regex on user input), so it is ReDoS-safe and never throws.
//
//   arg       (optional) the argument signature shown in the menu, e.g. '<query>' or '[opus|sonnet|auto]'
//   needsArg  true → Enter completes (adds a space) instead of running until an argument is typed (only `search`)
//   key       (optional) the equivalent keystroke, surfaced in `/help` so the menu teaches the shortcuts
//   aliases   (optional) extra names the matcher accepts (fed to byName + rank), e.g. exit/q for quit

// picker:true → accepting the command opens a bespoke, navigable VALUE picker (cards you arrow through) instead of
// completing to raw text. The catalog only flags it; tui.js owns each picker's look + data (personas carry a glyph
// and an essence, models a tier blurb, theme/anim live-preview as you move). A free-text command (search) is NOT a
// picker — there is no fixed value set, so it completes to text and you type. Honesty rule still holds: every entry,
// picker or not, runs a real action right now.
const COMMANDS = [
  { name: 'help',    summary: 'show everything you can do in here' },
  { name: 'model',   arg: '[opus|sonnet|auto]', picker: true, summary: 'switch the model for this session (opens a picker)' },
  { name: 'persona', arg: '[architect|sage|operator|muse|analyst|reset]', picker: true, summary: 'switch the voice (opens a picker)' },
  { name: 'search',  arg: '<query>', needsArg: true, summary: 'full-text search every past conversation' },
  { name: 'usage',   summary: "today's turns, tokens, and estimated cost" },
  { name: 'context', arg: '[<message>]', summary: 'what fills the model input — bytes + est tokens per category' },
  { name: 'clear',   summary: 'clear the transcript', key: 'Ctrl+L' },
  { name: 'theme',   picker: true, summary: 'pick the colour theme, previewed live', key: 'Ctrl+T' },
  { name: 'anim',    picker: true, summary: 'pick the worker animation', key: 'Ctrl+Y' },
  { name: 'stop',    summary: 'abort the in-flight turn', key: 'Esc' },
  { name: 'quit',    summary: 'leave the cockpit', aliases: ['exit', 'q'], key: 'Ctrl+C' },
];

const norm = (s) => String(s == null ? '' : s).toLowerCase();
function byName(name) { const n = norm(name); return COMMANDS.find((c) => c.name === n || (c.aliases || []).includes(n)) || null; }
function sig(c) { return '/' + c.name + (c.arg ? ' ' + c.arg : ''); }

// rank(query) → commands whose name/alias PREFIXES the query first, then name/alias substring, then summary
// substring. Stable within each tier (catalog order), so the most useful entries stay near the top. `q` is already
// lowercased + length-bounded by resolve().
function rank(q) {
  if (!q) return COMMANDS.slice();
  const pre = [], sub = [], txt = [];
  for (const c of COMMANDS) {
    const names = [c.name, ...(c.aliases || [])];
    if (names.some((n) => n.startsWith(q))) pre.push(c);
    else if (names.some((n) => n.includes(q))) sub.push(c);
    else if (norm(c.summary).includes(q)) txt.push(c);
  }
  return pre.concat(sub, txt);
}

// clampSel(sel, len) → a valid, wrap-around index into a list of `len` items (0 when empty). Lets Up past the top
// land on the bottom and Down past the bottom land on the top, the way every command palette behaves.
function clampSel(sel, len) { if (!len) return 0; const n = Number.isInteger(sel) ? sel : 0; return ((n % len) + len) % len; }

// resolve(input, selected) → the slash context for the current buffer. Drives BOTH the menu render and the key
// handling, so the two can't disagree. Returns { active:false } when the buffer is not a /command. Never throws.
//   mode 'menu' → still typing the command name: { query, items (ranked), selected, exact }
//   mode 'arg'  → a name + space typed: { name, cmd, arg, valid } — show that one command's signature as a hint
function resolve(input, selected) {
  const s = String(input == null ? '' : input);
  if (s.charCodeAt(0) !== 47) return { active: false };                 // 47 = '/'
  const sp = s.indexOf(' ');
  if (sp === -1) {
    const q = norm(s.slice(1, 64));
    const items = rank(q);
    return { active: true, mode: 'menu', query: q, items, selected: clampSel(selected, items.length), exact: byName(q) };
  }
  const name = norm(s.slice(1, sp));
  return { active: true, mode: 'arg', name, cmd: byName(name), arg: s.slice(sp + 1), valid: !!byName(name) };
}

// parse(input) → { name, arg } for execution. arg is trimmed; '' when no argument was typed.
function parse(input) {
  const s = String(input == null ? '' : input).replace(/^\//, '');
  const sp = s.indexOf(' ');
  return sp === -1 ? { name: norm(s), arg: '' } : { name: norm(s.slice(0, sp)), arg: s.slice(sp + 1).trim() };
}

// completion(c) → the buffer after accepting command c from the menu: a trailing space iff it takes an argument,
// so the caret lands where the argument goes (no space for a no-arg command, which is then ready to run).
function completion(c) { return '/' + c.name + (c.arg || c.needsArg ? ' ' : ''); }

// pickerView(items, query, sel) → the VISIBLE state of a value picker: the items filtered by an incremental
// type-to-filter query (case-insensitive substring over value + label + desc), with the selection clamped into the
// filtered range. Pure, ReDoS-safe (only indexOf), never throws. tui.js renders this; the same call drives nav.
function pickerView(items, query, sel) {
  const all = Array.isArray(items) ? items : [];
  const q = String(query == null ? '' : query).toLowerCase().slice(0, 64);
  const hay = (it) => (String(it.value || '') + ' ' + String(it.label || '') + ' ' + String(it.desc || '')).toLowerCase();
  const vis = q ? all.filter((it) => hay(it).includes(q)) : all.slice();
  return { items: vis, sel: clampSel(sel, vis.length), query: q };
}

module.exports = { COMMANDS, byName, sig, rank, clampSel, resolve, parse, completion, pickerView };
