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
  const inputView = (!inflight && !input) ? T.dim + 'ask Liquid Intelligence anything…' + T.RST : buf;
  const frame = rend.compose({ theme: T, cfg, vitals, lines: all, worker: workerLine(g, Date.now()), statusText: statusLine(), promptMark: mark, inputView, scroll }, g);
  rend.flush(frame, caretFor(g), g, process.stdout);
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

  if (key.name === 'escape') { if (inflight) abortTurn(); return; }
  if (key.name === 'return' || key.name === 'enter') { const text = input.trim(); if (!text) return; input = ''; sendTurn(text); return; }
  if (key.name === 'backspace') { input = input.slice(0, -1); render(); return; }

  if (key.name === 'up' && (key.shift || key.meta)) { scroll += 1; render(); return; }
  if (key.name === 'down' && (key.shift || key.meta)) { scroll = Math.max(0, scroll - 1); render(); return; }
  if (key.name === 'pageup') { scroll += Math.max(1, (process.stdout.rows || 24) - 3); render(); return; }
  if (key.name === 'pagedown') { scroll = Math.max(0, scroll - Math.max(1, (process.stdout.rows || 24) - 3)); render(); return; }
  if (key.name === 'home') { scroll = 1e9; render(); return; }
  if (key.name === 'end') { scroll = 0; render(); return; }

  if (key.name === 'up') { if (!input && lastSent) { input = lastSent; render(); } else { scroll += 1; render(); } return; }
  if (key.name === 'down') { scroll = Math.max(0, scroll - 1); render(); return; }

  if (str === 'q' && input === '') { return quit(0); }
  if (str && !key.ctrl && !key.meta && str.length === 1 && str >= ' ') { input += str; render(); return; }
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

  add('sys', 'Urfael — Enter sends · Esc aborts · q quits · ^L clears · ^T theme · ^Y anim · Up recalls');
  render();
  refreshVitals();
}

module.exports = { run };

if (require.main === module) run();
