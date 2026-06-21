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

const SOCK = path.join(os.homedir(), '.claude', 'urfael', 'daemon.sock');

const RST = '\x1b[0m';
const ALT_ON = '\x1b[?1049h', ALT_OFF = '\x1b[?1049l';
const CUR_HIDE = '\x1b[?25l', CUR_SHOW = '\x1b[?25h';
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
let lastSent = '';         // for Up-arrow recall
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
  return left + '   ' + T.dim + 'Enter send · Esc abort · ^T theme · ^Y anim · q quit' + T.RST;
}
function workerLine(g, now) {
  if (!inflight) return null;
  const answerChars = (answerIdx >= 0 && lines[answerIdx] && lines[answerIdx].text || '').length;
  return anim.composeWorker(cfg, cfg.theme, { t0: turnT0, lastTool, answerChars, usageTokens }, g.cols, now);
}
function caretFor(g) { const markW = rend.visLen(promptMark()); const room = Math.max(1, g.cols - markW - 1); return markW + Math.min(input.length, room) + 1; }

function render() {
  if (!cfg) return;
  const g = geom(), T = cfg.theme;
  const all = rend.renderTranscript(lines, g.cols, T, { inflight, answerIdx });
  const L = rend.layout(g, cfg);
  const maxScroll = Math.max(0, all.length - L.paneH);
  if (scroll > maxScroll) scroll = maxScroll; if (scroll < 0) scroll = 0;
  const mark = promptMark(), markW = rend.visLen(mark), room = Math.max(1, g.cols - markW - 1);
  const buf = input.length > room ? input.slice(input.length - room) : input;
  const inputView = (!inflight && !input) ? T.dim + 'ask Liquid Intelligence anything…  (/ for commands)' + T.RST : buf;
  const sl = inflight ? { active: false } : slash.resolve(input, slashSel);
  const menu = sl.active ? buildMenu(sl, T) : null;
  const frame = rend.compose({ theme: T, cfg, vitals, lines: all, worker: workerLine(g, Date.now()), statusText: statusLine(), promptMark: mark, inputView, scroll, menu }, g);
  rend.flush(frame, caretFor(g), g, process.stdout);
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

// completeSlash(c) → fill the buffer with command c (Tab / a partial accept), leaving the caret at the argument.
function completeSlash(c) { input = slash.completion(c); slashSel = 0; render(); }

// acceptSlash(sl) → Enter inside the palette. Completes a command that still needs an argument; otherwise RUNS it.
// A /command is never sent to the brain, so typing `/clear` clears the screen instead of asking the model about it.
function acceptSlash(sl) {
  let cmd, arg;
  if (sl.mode === 'arg') {
    if (!sl.valid) { input = ''; slashSel = 0; add('sys', '╶ no such command — type / to see the list'); render(); return; }
    cmd = sl.cmd; arg = sl.arg.trim();
  } else {
    cmd = sl.exact || sl.items[sl.selected] || null;
    if (!cmd) { input = ''; slashSel = 0; add('sys', '╶ no such command — type / to see the list'); render(); return; }
    if (!sl.exact && (cmd.arg || cmd.needsArg)) return completeSlash(cmd);   // accept the highlighted name, type the arg next
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
  if (c.name === 'theme') { cfg = theme.withTheme(cfg, baseEnv, cfg.isTTY); rend.resetFrame(); render(); return; }
  if (c.name === 'anim') { cfg = theme.withAnim(cfg); render(); return; }
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
  const a = arg.toLowerCase();
  const body = (a === '' || a === 'status') ? null : (a === 'auto') ? { action: 'auto' }
    : (a === 'opus' || a === 'sonnet') ? { model: a } : 'bad';
  if (body === 'bad') { add('sys', '╶ /model takes opus · sonnet · auto · status'); render(); return; }
  const ix = pending('model…');
  (body ? req('POST', '/model', body) : req('GET', '/model'))
    .then((r) => settle(ix, 'model: ' + (r && (r.text || ('pinned ' + (r.pinned || 'auto') + ' · using ' + (r.model || '?'))))))
    .catch(() => settle(ix, 'model: daemon unreachable'));
}

function runPersona(arg) {
  const a = arg.toLowerCase().trim();
  const body = (a === '' || a === 'status') ? null : (a === 'reset' || a === 'urfael') ? { action: 'reset' }
    : (a === 'list') ? { action: 'list' } : { id: a };
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
      const d = (u && u.today) || {};
      const parts = [(d.turns || 0) + ' turns', (d.tokIn || 0) + ' in / ' + (d.tokOut || 0) + ' out tokens'];
      if (typeof d.costUsd === 'number') parts.push('~$' + d.costUsd.toFixed(3));
      settle(ix, 'today: ' + parts.join(' · '));
    })
    .catch(() => settle(ix, 'usage: daemon unreachable'));
}

// showSlashHelp → list the whole palette in the transcript (plain text; the 'sys' style is applied by the renderer).
function showSlashHelp() {
  add('sys', 'slash commands — type / then a name · ↑↓ choose · Tab complete · Enter run · Esc cancel');
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
  lastSent = text;
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
  try { process.stdout.write(RST + CUR_SHOW + ALT_OFF); } catch {}
}
function quit(code) { cleanup(); process.exit(code || 0); }

// ---- key handling ----
function onKey(str, key) {
  key = key || {};
  if (key.ctrl && key.name === 'c') { if (inflight) { abortTurn(); return; } return quit(0); }
  if (key.ctrl && key.name === 'd') { return quit(0); }
  if (key.ctrl && key.name === 'l') { lines.length = 0; scroll = 0; rend.resetFrame(); render(); return; }
  if (key.ctrl && key.name === 't') { cfg = theme.withTheme(cfg, baseEnv, cfg.isTTY); rend.resetFrame(); render(); return; }   // cycle theme
  if (key.ctrl && key.name === 'y') { cfg = theme.withAnim(cfg); render(); return; }                                          // cycle animation

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
  if (key.name === 'return' || key.name === 'enter') { const text = input.trim(); if (!text) return; input = ''; sendTurn(text); return; }
  if (key.name === 'backspace') { input = input.slice(0, -1); slashSel = 0; render(); return; }

  if (key.name === 'up' && (key.shift || key.meta)) { scroll += 1; render(); return; }
  if (key.name === 'down' && (key.shift || key.meta)) { scroll = Math.max(0, scroll - 1); render(); return; }
  if (key.name === 'pageup') { scroll += Math.max(1, (process.stdout.rows || 24) - 3); render(); return; }
  if (key.name === 'pagedown') { scroll = Math.max(0, scroll - Math.max(1, (process.stdout.rows || 24) - 3)); render(); return; }
  if (key.name === 'home') { scroll = 1e9; render(); return; }
  if (key.name === 'end') { scroll = 0; render(); return; }

  if (key.name === 'up') { if (!input && lastSent) { input = lastSent; render(); } else { scroll += 1; render(); } return; }
  if (key.name === 'down') { scroll = Math.max(0, scroll - 1); render(); return; }

  if (str === 'q' && input === '') { return quit(0); }
  if (str && !key.ctrl && !key.meta && str.length === 1 && str >= ' ') { input += str; slashSel = 0; render(); return; }
}

function run() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('urfael tui needs an interactive terminal (TTY). Use `urfael "..."` for one-shot questions.\n');
    process.exit(1);
  }
  baseEnv = (() => { let f = {}; try { f = require('./setup').readEnv() || {}; } catch {} return { ...f, ...process.env }; })();
  cfg = theme.readCfg(baseEnv, true);

  process.stdout.write(ALT_ON + CUR_HIDE);
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
  process.stdout.on('resize', () => { rend.resetFrame(); render(); });

  add('sys', 'Urfael — type / for commands · Enter sends · Esc aborts · q quits · ^L clears · ^T theme · ^Y anim · Up recalls');
  render();
  refreshVitals();
}

module.exports = { run };

if (require.main === module) run();
