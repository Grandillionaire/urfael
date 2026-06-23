'use strict';
// urfael tui — a full-screen terminal cockpit for the brain. No deps: raw stdin + ANSI + readline
// keypress parsing, talking to the daemon's unix socket exactly like cli.js ask() (POST /ask, NDJSON
// thinking.delta / thinking.tool / done streamed live). The [SPOKEN] tag is stripped on screen.
//   Enter send · Esc abort the in-flight turn · Ctrl+C / q on an empty line quit · Ctrl+L clear · Up recall
//   ^T cycle theme (gold/ember/mono/custom) · ^Y cycle the thinking animation
// Look + smoothness live in three pure modules: tui-theme (palette/config), tui-anim (the worker
// animation), tui-render (the flicker-free differential renderer). Discipline unchanged: ALWAYS restore
// the terminal (raw off, cursor shown, leave the alt buffer) on EVERY exit path via one cleanup() wired
// to exit/SIGINT/SIGTERM/uncaughtException; re-render on SIGWINCH; the worker timer is cleared first.
const http = require('http');
const os = require('os');
const path = require('path');
const readline = require('readline');
const theme = require('./tui-theme');
const anim = require('./tui-anim');
const rend = require('./tui-render');
const slash = require('./slash');
const hist = require('./tui-history');

const SOCK = path.join(os.homedir(), '.claude', 'urfael', 'daemon.sock');

const RST = '\x1b[0m';
const ALT_ON = '\x1b[?1049h', ALT_OFF = '\x1b[?1049l';
const CUR_HIDE = '\x1b[?25l', CUR_SHOW = '\x1b[?25h';
// mouse wheel reporting (SGR) so the natural scroll gesture moves the transcript; off on every exit path.
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h', MOUSE_OFF = '\x1b[?1000l\x1b[?1006l';
// bracketed paste: the terminal wraps a paste in 200~ … 201~, so a multi-line paste arrives as text instead of a flurry of Enters that each send.
const PASTE_ON = '\x1b[?2004h', PASTE_OFF = '\x1b[?2004l';
const stripSpoken = (t) => (t || '').replace(/\[\/?SPOKEN\]/gi, '');
// drop ANSI/control bytes that would corrupt the layout, but keep tab→space
const sanitize = (s) => String(s == null ? '' : s).replace(/\t/g, '  ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath: SOCK, method, path: p, headers: { 'Content-Type': 'application/json' }, timeout: 8000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

// ---- transcript model: a flat list of {who, text}; 'sys' rows carry footers/notices ----
const lines = [];          // { who: 'you'|'urfael'|'tool'|'sys', text }
let scroll = 0;            // rows scrolled UP from the bottom (0 = pinned to newest)
let input = '';            // current input buffer
let slashSel = 0;          // highlighted row in the /command typeahead (reset to top on every buffer edit)
let picker = null;         // an open VALUE picker (persona/model/theme/anim) — owns all input while set; see openers below
let history = [];          // persistent input history (loaded in run())
let histIdx = -1;          // navigation position in `history`; -1 = at the live draft below
let histDraft = '';        // the live input, saved when you start stepping back through history
let pasting = false;       // inside a bracketed paste (200~ … 201~): take everything as text, never send
let inflight = false;      // a turn is streaming
let vitals = { model: '', turnsToday: 0, warm: [] };
let streamReq = null;      // the live POST /ask request, so a hard quit can tear it down
// render/animation state
let cfg = null;            // the frozen TUI config (set in run())
let baseEnv = null;        // env used to resolve themes, for ^T cycling
let animTimer = null;      // the worker setInterval (unref'd)
let turnT0 = 0;            // wall-clock start of the in-flight turn
let lastTool = '';         // current tool name → the worker verb
let usageTokens = null;    // null in flight → authoritative output_tokens on done
let answerIdx = -1;        // index of the urfael answer row (added lazily, so tools sit above it)
let toolIdx = -1;          // index of the collapsed tool row for this turn

function add(who, text) { lines.push({ who, text: sanitize(text) }); }

// ---- the render: pure compose() of the model → flicker-free diff flush() ----
function geom() { return { cols: Math.max(20, process.stdout.columns || 80), rows: Math.max(8, process.stdout.rows || 24) }; }
function promptMark() { const T = cfg.theme; return inflight ? T.dim + '… ' + T.RST : T.accent + '> ' + T.RST; }
function statusLine() {
  const T = cfg.theme;
  const left = ' ' + T.gold + 'Urfael' + T.RST + T.dim + ' · ' + (vitals.model || '…') + ' · ' + (vitals.turnsToday || 0) + ' turns' +
    (inflight ? ' · ᚢ thinking' : (scroll ? ' · scrolled (End to pin)' : '')) + T.RST;
  return left + '   ' + T.dim + 'Enter send · ↑↓ PgUp scroll · ^P/^N history · Esc abort · q quit' + T.RST;
}
function workerLine(g, now) {
  if (!inflight) return null;
  const answerChars = (answerIdx >= 0 && lines[answerIdx] && lines[answerIdx].text || '').length;
  return anim.composeWorker(cfg, cfg.theme, { t0: turnT0, lastTool, answerChars, usageTokens }, g.cols, now);
}
const MAX_INPUT_ROWS = 6;   // the prompt grows up to this many rows for multi-line input, then tails to keep the caret visible
// inputBlock(g, T): the (possibly multi-line) prompt area as display rows + the caret column on the last row.
function inputBlock(g, T) {
  const mark = promptMark(), markW = rend.visLen(mark), width = Math.max(1, g.cols - markW - 1);
  if (!inflight && !input) return { lines: [mark + T.dim + 'ask Liquid Intelligence anything…  (Shift+Enter = new line · / = commands)' + T.RST], caretCol: markW + 1 };
  const indent = ' '.repeat(markW);
  const disp = [];                                                   // one { text, first } per display row
  const segs = input.split('\n');
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    if (!seg.length) { disp.push({ text: '', first: s === 0 }); continue; }
    for (let i = 0; i < seg.length; i += width) disp.push({ text: seg.slice(i, i + width), first: s === 0 && i === 0 });
  }
  const shown = disp.length > MAX_INPUT_ROWS ? disp.slice(disp.length - MAX_INPUT_ROWS) : disp;
  const lines = shown.map((d) => (d.first ? mark : indent) + d.text);
  return { lines, caretCol: markW + shown[shown.length - 1].text.length + 1 };
}

function render() {
  if (!cfg) return;
  const g = geom(), T = cfg.theme;
  const all = rend.renderTranscript(lines, g.cols, T, { inflight, answerIdx });
  const ib = inputBlock(g, T);
  const L = rend.layout(g, cfg, ib.lines.length);
  const maxScroll = Math.max(0, all.length - L.paneH);
  if (scroll > maxScroll) scroll = maxScroll; if (scroll < 0) scroll = 0;
  let menu = null;
  if (!inflight) {
    if (picker) menu = buildPicker(picker, T);
    else { const sl = slash.resolve(input, slashSel); if (sl.active) menu = buildMenu(sl, T); }
  }
  const frame = rend.compose({ theme: T, cfg, vitals, lines: all, worker: workerLine(g, Date.now()), statusText: statusLine(), inputLines: ib.lines, scroll, menu }, g);
  rend.flush(frame, ib.caretCol, g, process.stdout);
}

// ---- the /command typeahead: a palette that floats above the prompt (derived from slash.COMMANDS) ----
// buildMenu(sl, T) → the themed rows compose() overlays on the pane bottom. mode 'menu' = the ranked, highlighted
// list; mode 'arg' = a single signature hint for the chosen command. Plain strings (the renderer clips them).
function buildMenu(sl, T) {
  if (sl.mode === 'arg') {
    if (!sl.valid) return [T.dim + '  no command ' + ('/' + sl.name) + '  ·  Esc to cancel' + T.RST];
    return [T.accent + '  ' + slash.sig(sl.cmd) + T.RST + T.dim + '    ' + sl.cmd.summary + T.RST];
  }
  const items = sl.items.slice(0, 8);
  if (!items.length) return [T.dim + '  no match  ·  Esc to cancel' + T.RST];
  const W = Math.max(...items.map((c) => slash.sig(c).length));
  return items.map((c, i) => {
    const on = i === sl.selected, s = slash.sig(c);
    const head = on ? T.accent + '▌ ' : T.dim + '  ';
    return head + s + ' '.repeat(Math.max(2, W + 3 - s.length)) + (on ? '' : T.dim) + c.summary + T.RST;
  });
}

// ---- the value picker: a bespoke, navigable card list for a value-set command (persona/model/theme/anim) ----
// buildPicker(p, T) → a titled, highlighted card list: a header (title + how-to), then one card per value with an
// optional glyph, the label, a "(current)" marker, and a dim description, aligned. Honours the type-to-filter query.
// All cards share one label column width so the descriptions line up into a readable second column.
function buildPicker(p, T) {
  const view = slash.pickerView(p.all, p.query, p.sel);
  p.sel = view.sel;                                                  // keep state in step with the clamped selection
  const head = T.gold + '  ' + p.title + T.RST + '   ' + T.dim + p.hint + T.RST + (p.query ? T.RST + '   ' + T.accent + p.query + '▏' + T.RST : '');
  if (!view.items.length) return [head, T.dim + '  no match  ·  Esc to cancel' + T.RST];
  const labelOf = (it) => (it.glyph ? it.glyph + '  ' : '') + (it.label || it.value);
  const W = Math.max(...view.items.map((it) => visw(labelOf(it))));
  const rows = view.items.map((it, i) => {
    const on = i === view.sel, label = labelOf(it);
    const cur = it.current ? ' (current)' : '';
    const left = (on ? T.accent + '▌ ' : '  ') + (on ? T.accent : T.gold) + label + T.RST + T.dim + cur + T.RST;
    const pad = ' '.repeat(Math.max(2, W + 4 - visw(label) - cur.length));
    return left + (it.desc ? pad + T.dim + it.desc + T.RST : '');
  });
  return [head, ...rows];
}
// visible width of a short label (ASCII names + at most one leading rune glyph counted as width 1)
function visw(s) { return rend.visLen(String(s)); }

// closePicker → drop the picker and let the prompt take input again. The caller renders (or relies on the next one).
function closePicker() { picker = null; }

// pickerKey(str, key) → a picker OWNS every key while open: ↑↓ move (live-previewing if the picker asks), Enter/Tab
// pick, Esc/^C cancel, Backspace/printables drive the type-to-filter. Returns nothing; onKey returns right after.
function pickerKey(str, key) {
  const view = slash.pickerView(picker.all, picker.query, picker.sel);
  if (key.name === 'escape' || (key.ctrl && key.name === 'c')) { const c = picker.onCancel; closePicker(); if (c) c(); render(); return; }
  if (key.name === 'up') { picker.sel = slash.clampSel(picker.sel - 1, view.items.length); moveSel(); return; }
  if (key.name === 'down') { picker.sel = slash.clampSel(picker.sel + 1, view.items.length); moveSel(); return; }
  if (key.name === 'return' || key.name === 'enter' || key.name === 'tab') { const it = view.items[view.sel]; const pick = picker.onPick; if (it && pick) { pick(it); } else { render(); } return; }
  if (key.name === 'backspace') { picker.query = picker.query.slice(0, -1); picker.sel = 0; render(); return; }
  if (str && !key.ctrl && !key.meta && str.length === 1 && str >= ' ') { picker.query += str; picker.sel = 0; render(); return; }
  render();
}
// moveSel → after a selection change, live-preview if the picker opted in (theme/anim), then repaint.
function moveSel() {
  if (picker.live && picker.onMove) { const v = slash.pickerView(picker.all, picker.query, picker.sel); const it = v.items[v.sel]; if (it) picker.onMove(it); }
  render();
}

// completeSlash(c) → fill the buffer with command c (Tab / a partial accept), leaving the caret at the argument.
function completeSlash(c) { input = slash.completion(c); slashSel = 0; render(); }

// acceptSlash(sl) → Enter inside the palette. Completes a command that still needs an argument; otherwise RUNS it.
// A /command is never sent to the brain, so typing `/clear` clears the screen instead of asking the model about it.
function acceptSlash(sl) {
  let cmd, arg;
  if (sl.mode === 'arg') {
    if (!sl.valid) { input = ''; slashSel = 0; add('sys', '╶ no such command, type / to see the list'); render(); return; }
    cmd = sl.cmd; arg = sl.arg.trim();
  } else {
    cmd = sl.exact || sl.items[sl.selected] || null;
    if (!cmd) { input = ''; slashSel = 0; add('sys', '╶ no such command, type / to see the list'); render(); return; }
    // a free-text-arg command (search) completes to text so you can type; a PICKER command falls through to run with
    // no arg, which opens its visual picker; a no-arg command runs straight away.
    if (!cmd.picker && !sl.exact && (cmd.arg || cmd.needsArg)) return completeSlash(cmd);
    arg = '';
  }
  if (cmd.needsArg && !arg) return completeSlash(cmd);
  input = ''; slashSel = 0;
  runSlash(cmd.name, arg);
}

// runSlash(name, arg) → the single dispatch. Local commands reuse the exact key actions; the rest call the daemon
// over the same 0600 socket as everything else. Each daemon call shows a placeholder line, then fills it in place.
function runSlash(name, arg) {
  const c = slash.byName(name); if (!c) return;
  if (c.name === 'help') return showSlashHelp();
  if (c.name === 'clear') { lines.length = 0; scroll = 0; rend.resetFrame(); render(); return; }
  if (c.name === 'theme') return openThemePicker();
  if (c.name === 'anim') return openAnimPicker();
  if (c.name === 'stop') { if (inflight) abortTurn(); else { add('sys', '╶ nothing is running'); render(); } return; }
  if (c.name === 'quit') return quit(0);
  if (c.name === 'model') return runModel(arg);
  if (c.name === 'persona') return runPersona(arg);
  if (c.name === 'search') return runSearch(arg);
  if (c.name === 'usage') return runUsage();
}

function pending(text) { add('sys', '╶ ' + text); const ix = lines.length - 1; render(); return ix; }
function settle(ix, text) { if (lines[ix]) lines[ix].text = sanitize('╶ ' + text); render(); }

function runModel(arg) {
  const a = arg.toLowerCase().trim();
  if (a === '') return openModelPicker();                            // no value typed → the visual picker
  if (a === 'status') { const ix = pending('model…'); req('GET', '/model').then((r) => settle(ix, 'model: pinned ' + ((r && r.pinned) || 'auto') + ' · using ' + ((r && r.model) || '?'))).catch(() => settle(ix, 'model: daemon unreachable')); return; }
  const body = (a === 'auto') ? { action: 'auto' } : (a === 'opus' || a === 'sonnet') ? { model: a } : 'bad';
  if (body === 'bad') { add('sys', '╶ /model takes opus · sonnet · auto · status'); render(); return; }
  const ix = pending('model…');
  req('POST', '/model', body)
    .then((r) => settle(ix, 'model: ' + (r && (r.text || ('pinned ' + (r.pinned || 'auto') + ' · using ' + (r.model || '?'))))))
    .catch(() => settle(ix, 'model: daemon unreachable'));
}

function runPersona(arg) {
  const a = arg.toLowerCase().trim();
  if (a === '' || a === 'list') return openPersonaPicker();          // no value typed → the visual picker
  const body = (a === 'status') ? null : (a === 'reset' || a === 'urfael') ? { action: 'reset' } : { id: a };
  const ix = pending('persona…');
  (body ? req('POST', '/persona', body) : req('GET', '/persona'))
    .then((r) => {
      if (r && r.error) return settle(ix, 'persona: ' + r.error);
      if (r && r.text) return settle(ix, r.text);
      if (r && r.display) return settle(ix, 'persona: ' + (r.display.glyph ? r.display.glyph + ' ' : '') + (r.display.name || a));
      settle(ix, 'persona updated');
    })
    .catch(() => settle(ix, 'persona: daemon unreachable'));
}

// ---- the pickers: each fetches its live values, then opens a navigable card list (see buildPicker/pickerKey) ----
// openPersonaPicker → the headline: glyph + name + essence per voice, the active one marked, Enter switches.
function openPersonaPicker() {
  req('GET', '/persona').then((r) => {
    const roster = (r && Array.isArray(r.roster)) ? r.roster : [];
    if (!roster.length) { add('sys', '╶ persona: daemon unreachable'); render(); return; }
    const cur = r && r.persona;
    const all = roster.map((p) => ({ value: p.id, label: p.name, glyph: p.glyph, desc: p.essence || '', current: p.id === cur }));
    picker = {
      title: 'Switch persona', hint: '↑↓ choose · Enter apply · Esc cancel · type to filter', all, query: '',
      sel: Math.max(0, all.findIndex((it) => it.current)), live: false,
      onPick: (it) => { closePicker(); runPersona(it.value); },
      onCancel: null,
    };
    render();
  }).catch(() => { add('sys', '╶ persona: daemon unreachable'); render(); });
}

// openModelPicker → the three tiers with an honest one-line blurb, the pinned one marked.
function openModelPicker() {
  req('GET', '/model').then((r) => {
    const cur = (r && r.pinned) ? r.pinned : 'auto';
    const all = [
      { value: 'opus', label: 'Opus', desc: 'most capable; deepest reasoning + hardest coding' },
      { value: 'sonnet', label: 'Sonnet', desc: 'faster and cheaper; ample for most turns' },
      { value: 'auto', label: 'Auto', desc: 'route each turn to the tier that fits' },
    ].map((m) => ({ ...m, current: m.value === cur }));
    picker = {
      title: 'Switch model', hint: '↑↓ choose · Enter apply · Esc cancel', all, query: '',
      sel: Math.max(0, all.findIndex((it) => it.current)), live: false,
      onPick: (it) => { closePicker(); runModel(it.value); }, onCancel: null,
    };
    render();
  }).catch(() => { add('sys', '╶ model: daemon unreachable'); render(); });
}

// openThemePicker → live preview: moving the selection repaints the whole cockpit in that theme; Esc reverts.
function openThemePicker() {
  const blurb = { gold: 'warm gold on dark (default)', ember: 'orange ember', mono: 'monochrome, no colour', custom: 'your URFAEL_TUI_ACCENT' };
  const original = cfg;
  const all = theme.THEME_NAMES.map((n) => ({ value: n, label: n[0].toUpperCase() + n.slice(1), desc: blurb[n] || '', current: n === cfg.themeName }));
  picker = {
    title: 'Theme', hint: '↑↓ preview · Enter keep · Esc revert', all, query: '',
    sel: Math.max(0, all.findIndex((it) => it.current)), live: true,
    onMove: (it) => { cfg = theme.setTheme(cfg, it.value, baseEnv, cfg.isTTY); rend.resetFrame(); },
    onPick: (it) => { cfg = theme.setTheme(cfg, it.value, baseEnv, cfg.isTTY); closePicker(); rend.resetFrame(); add('sys', '╶ theme: ' + it.value); render(); },
    onCancel: () => { cfg = original; rend.resetFrame(); },
  };
  render();
}

// openAnimPicker → set the worker animation (seen next time it thinks); short honest blurbs.
function openAnimPicker() {
  const blurb = { oracle: 'a turning rune and word (default)', rune: 'cycling runes', ember: 'a glowing ember', braille: 'a braille spinner', scry: 'a scrying sweep', shimmer: 'a soft shimmer' };
  const all = theme.ANIM_NAMES.map((n) => ({ value: n, label: n[0].toUpperCase() + n.slice(1), desc: blurb[n] || '', current: n === cfg.anim }));
  picker = {
    title: 'Worker animation', hint: '↑↓ choose · Enter keep · Esc cancel', all, query: '',
    sel: Math.max(0, all.findIndex((it) => it.current)), live: false,
    onPick: (it) => { cfg = theme.setAnim(cfg, it.value); closePicker(); add('sys', '╶ animation: ' + it.value); render(); }, onCancel: null,
  };
  render();
}

function runSearch(query) {
  const q = String(query || '').trim();
  if (!q) { add('sys', '╶ /search needs a query'); render(); return; }
  const ix = pending('searching “' + q + '” …');
  req('GET', '/recall?q=' + encodeURIComponent(q) + '&k=8')
    .then((r) => {
      const hits = Array.isArray(r) ? r : [];
      if (!hits.length) { settle(ix, 'no matches for “' + q + '”'); return; }
      settle(ix, hits.length + ' match' + (hits.length > 1 ? 'es' : '') + ' for “' + q + '”');
      for (const h of hits.slice(0, 8)) {
        const when = (h.t || '').slice(0, 10);
        const snip = String(h.user || h.urfael || '').replace(/\s+/g, ' ').slice(0, 110);
        add('sys', '  · ' + (when ? when + '  ' : '') + snip);
      }
      render();
    })
    .catch(() => settle(ix, 'search: daemon unreachable'));
}

function runUsage() {
  const ix = pending('usage…');
  req('GET', '/usage')
    .then((u) => {
      if (!u || typeof u !== 'object') { settle(ix, 'usage: (none yet)'); return; }
      const row = (label, w) => { const d = w || {}; const cost = typeof d.costUsd === 'number' ? '  ~$' + d.costUsd.toFixed(2) : ''; return label + ': ' + (d.turns || 0) + ' turns · ' + (d.tokIn || 0) + ' in / ' + (d.tokOut || 0) + ' out' + cost; };
      settle(ix, 'usage');
      add('sys', '  ' + row('today  ', u.today));
      add('sys', '  ' + row('last 7d', u.last7d));
      add('sys', '  ' + row('last30d', u.last30d));
      render();
    })
    .catch(() => settle(ix, 'usage: daemon unreachable'));
}

// showSlashHelp → list the whole palette in the transcript (plain text; the 'sys' style is applied by the renderer).
function showSlashHelp() {
  add('sys', 'slash commands · type / then a name · ↑↓ choose · Tab complete · Enter run · Esc cancel');
  const W = Math.max(...slash.COMMANDS.map((c) => slash.sig(c).length));
  for (const c of slash.COMMANDS) add('sys', '  ' + slash.sig(c) + ' '.repeat(W + 3 - slash.sig(c).length) + c.summary + (c.key ? '  (' + c.key + ')' : ''));
  render();
}

// the cheap animation tick: repaint ONLY the worker row
function tickWorker() {
  if (!inflight || !cfg) return;
  const g = geom(), w = workerLine(g, Date.now());
  if (w == null) return;
  rend.renderWorkerOnly(rend.clipPad(w, g.cols, cfg.theme.RST), rend.layout(g, cfg).workerRow, caretFor(g), process.stdout);
}

// ---- streaming a turn: POST /ask NDJSON, render delta/tool/done live ----
function sendTurn(text) {
  if (inflight) return;
  history = hist.append(history, text); hist.persist(text); histIdx = -1;
  add('you', text);
  scroll = 0; inflight = true;
  turnT0 = Date.now(); lastTool = ''; usageTokens = null; answerIdx = -1; toolIdx = -1;
  animTimer = anim.startWorker(cfg, tickWorker);
  render();

  let buf = '', sawDelta = false;
  const ensureAnswer = () => { if (answerIdx < 0) { add('urfael', ''); answerIdx = lines.length - 1; } };
  const finish = (suffix) => {
    if (!inflight) return;
    inflight = false; streamReq = null; animTimer = anim.stopWorker(animTimer);
    if (answerIdx < 0) add('urfael', (suffix && suffix.trim()) || '(no reply)');
    else { if (suffix) lines[answerIdx].text = sanitize(lines[answerIdx].text + suffix); if (!lines[answerIdx].text) lines[answerIdx].text = '(no reply)'; }
    render();
  };

  const r = http.request({ socketPath: SOCK, method: 'POST', path: '/ask', headers: { 'Content-Type': 'application/json' }, timeout: 300000 }, (res) => {
    res.on('data', (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!ln) continue;
        let e; try { e = JSON.parse(ln); } catch { continue; }
        if (e.kind === 'thinking' && e.tool && e.tool !== lastTool) {
          lastTool = e.tool;
          if (toolIdx < 0) { add('tool', e.tool); toolIdx = lines.length - 1; } else lines[toolIdx].text = sanitize(lines[toolIdx].text + ' · ' + e.tool);
          render();
        } else if (e.kind === 'thinking' && e.delta) {
          sawDelta = true; ensureAnswer(); lines[answerIdx].text = sanitize(lines[answerIdx].text + stripSpoken(e.delta)); render();
        } else if (e.kind === 'done') {
          const finalText = stripSpoken(e.text || '');
          ensureAnswer();
          if (!sawDelta && finalText) lines[answerIdx].text = sanitize(finalText);
          if (!lines[answerIdx].text) lines[answerIdx].text = e.aborted ? '(stopped)' : '(no reply)';
          usageTokens = (e.usage && (e.usage.output_tokens || 0)) || null;       // authoritative; no '~'
          inflight = false; streamReq = null; animTimer = anim.stopWorker(animTimer);
          const secs = e.ms ? (e.ms / 1000).toFixed(1) + 's' : '';
          const tok = usageTokens != null ? anim.fmtTok(usageTokens) + ' tok' : '';
          const stamp = cfg.timestamps ? ' · ' + new Date().toTimeString().slice(0, 5) : '';
          add('sys', e.aborted ? '╶ stopped' : '╶ ' + (e.model || '') + (secs ? ' · ' + secs : '') + (tok ? ' · ' + tok : '') + stamp);
          render(); refreshVitals();
        }
      }
    });
    res.on('end', () => finish(''));
  });
  streamReq = r;
  r.on('error', () => finish(answerIdx >= 0 && lines[answerIdx].text ? '' : ' (brain unreachable)'));
  r.on('timeout', () => { try { r.destroy(); } catch {} finish(' (timed out)'); });
  r.end(JSON.stringify({ text }));
}

function abortTurn() {
  if (!inflight) return;
  add('sys', '╶ aborting…'); render();
  req('POST', '/abort').catch(() => {});
}

function refreshVitals() { req('GET', '/vitals').then((v) => { if (v && typeof v === 'object') { vitals = v; render(); } }).catch(() => {}); }

// ---- terminal lifecycle: ONE cleanup, wired to every exit path ----
let cleaned = false;
function cleanup() {
  if (cleaned) return; cleaned = true;
  animTimer = anim.stopWorker(animTimer);                 // stop the worker BEFORE we tear down the screen
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
  try { process.stdin.pause(); } catch {}
  try { process.stdout.write(RST + CUR_SHOW + MOUSE_OFF + PASTE_OFF + ALT_OFF); } catch {}
}
function quit(code) { cleanup(); process.exit(code || 0); }

// ---- key handling ----
function onKey(str, key) {
  key = key || {};
  if (key.sequence === '\x1b[200~') { pasting = true; return; }                            // bracketed paste begins
  if (key.sequence === '\x1b[201~') { pasting = false; slashSel = 0; render(); return; }    // paste ends: render the pasted block once
  if (pasting) {                                                                            // inside a paste: text only, Enter is a newline, never a send
    if (key.name === 'escape') { pasting = false; render(); return; }                       // escape hatch if the end marker is ever missed
    if (key.name === 'return' || key.name === 'enter' || key.name === 'linefeed') input += '\n';
    else if (str === '\t') input += '  ';
    else if (str && str.charCodeAt(0) >= 32) input += str;
    return;
  }
  if (str && str.length > 1 && str.charCodeAt(0) === 27) return; // unparsed escape sequence (mouse, etc.); wheel scroll is handled on the data stream
  // an open value picker (persona/model/theme/anim) owns every key until it is picked or cancelled
  if (picker && !inflight) { pickerKey(str, key); return; }
  if (key.ctrl && key.name === 'c') { if (inflight) { abortTurn(); return; } return quit(0); }
  if (key.ctrl && key.name === 'd') { return quit(0); }
  if (key.ctrl && key.name === 'l') { lines.length = 0; scroll = 0; rend.resetFrame(); render(); return; }
  if (key.ctrl && key.name === 't') { cfg = theme.withTheme(cfg, baseEnv, cfg.isTTY); rend.resetFrame(); render(); return; }   // cycle theme
  if (key.ctrl && key.name === 'y') { cfg = theme.withAnim(cfg); render(); return; }                                          // cycle animation
  if (key.ctrl && key.name === 'p') {                                                                                          // history: older
    if (inflight) return;
    if (histIdx < 0) histDraft = input;
    const s = hist.back({ list: history, idx: histIdx, draft: histDraft });
    histIdx = s.idx; if (s.value != null) input = s.value; slashSel = 0; render(); return;
  }
  if (key.ctrl && key.name === 'n') {                                                                                          // history: newer (back toward the live draft)
    if (inflight) return;
    const s = hist.fwd({ list: history, idx: histIdx, draft: histDraft });
    histIdx = s.idx; input = s.value != null ? s.value : ''; slashSel = 0; render(); return;
  }

  // ── /command typeahead: while the buffer is a /command (and nothing is streaming), the palette owns ↑↓ Tab Enter Esc ──
  if (!inflight && input.startsWith('/')) {
    const sl = slash.resolve(input, slashSel);
    if (key.name === 'escape') { input = ''; slashSel = 0; render(); return; }
    if (key.name === 'tab') { const c = sl.mode === 'menu' ? sl.items[sl.selected] : sl.cmd; if (c) completeSlash(c); return; }
    if (key.name === 'return' || key.name === 'enter') { acceptSlash(sl); return; }
    if (sl.mode === 'menu' && sl.items.length) {
      if (key.name === 'up') { slashSel = slash.clampSel(slashSel - 1, sl.items.length); render(); return; }
      if (key.name === 'down') { slashSel = slash.clampSel(slashSel + 1, sl.items.length); render(); return; }
    }
  }

  if (key.name === 'escape') { if (inflight) abortTurn(); return; }
  if ((key.name === 'return' || key.name === 'enter') && (key.meta || key.shift)) { input += '\n'; slashSel = 0; render(); return; }   // Shift/Alt+Enter inserts a new line
  if (key.name === 'return' || key.name === 'enter') { const text = input.replace(/\x1b\[20[01]~/g, '').trim(); if (!text) return; input = ''; sendTurn(text); return; }
  if (key.name === 'backspace') { input = input.slice(0, -1); slashSel = 0; histIdx = -1; render(); return; }

  if (key.name === 'up' && (key.shift || key.meta)) { scroll += 1; render(); return; }
  if (key.name === 'down' && (key.shift || key.meta)) { scroll = Math.max(0, scroll - 1); render(); return; }
  if (key.name === 'pageup') { scroll += Math.max(1, (process.stdout.rows || 24) - 3); render(); return; }
  if (key.name === 'pagedown') { scroll = Math.max(0, scroll - Math.max(1, (process.stdout.rows || 24) - 3)); render(); return; }
  if (key.name === 'home') { scroll = 1e9; render(); return; }
  if (key.name === 'end') { scroll = 0; render(); return; }

  if (key.name === 'up') { scroll += 1; render(); return; }
  if (key.name === 'down') { scroll = Math.max(0, scroll - 1); render(); return; }

  if (str === 'q' && input === '') { return quit(0); }
  if (str && !key.ctrl && !key.meta && str.length === 1 && str >= ' ') { input += str; slashSel = 0; histIdx = -1; render(); return; }
}

function run() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('urfael tui needs an interactive terminal (TTY). Use `urfael "..."` for one-shot questions.\n');
    process.exit(1);
  }
  baseEnv = (() => { let f = {}; try { f = require('./setup').readEnv() || {}; } catch {} return { ...f, ...process.env }; })();
  cfg = theme.readCfg(baseEnv, true);
  history = hist.load();

  process.stdout.write(ALT_ON + CUR_HIDE + MOUSE_ON + PASTE_ON);
  process.on('exit', cleanup);
  process.on('SIGINT', () => { if (inflight) abortTurn(); else quit(0); });
  process.on('SIGTERM', () => quit(0));
  process.on('SIGHUP', () => quit(0));
  process.on('uncaughtException', (e) => { cleanup(); try { process.stderr.write('urfael tui crashed: ' + (e && e.stack || e) + '\n'); } catch {} process.exit(1); });
  process.stdout.on('error', () => {});

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', (str, key) => { try { onKey(str, key); } catch {} });
  process.stdin.on('data', (d) => { try {                          // mouse wheel scrolls the transcript (SGR: 64 = up, 65 = down, + modifier bits)
    const m = /\x1b\[<(\d+);\d+;\d+[Mm]/.exec(d.toString());
    if (m && (+m[1] & 64)) { if (+m[1] & 1) scroll = Math.max(0, scroll - 3); else scroll += 3; render(); }
  } catch {} });
  process.stdout.on('resize', () => { rend.resetFrame(); render(); });

  add('sys', 'Urfael · type / for commands · scroll with the mouse wheel or ↑↓ PgUp (Home oldest, End newest) · Shift+Enter for a new line · ^P/^N walk your input history · Enter sends · Esc aborts · q quits · ^L clears');
  render();
  refreshVitals();
}

module.exports = { run, _internals: { buildPicker, buildMenu } };

if (require.main === module) run();
