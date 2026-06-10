'use strict';
// urfael tui — a full-screen terminal cockpit for the brain. No deps: raw stdin + ANSI + readline
// keypress parsing, talking to the daemon's unix socket exactly like cli.js ask() (POST /ask, NDJSON
// thinking.delta / thinking.tool / done streamed live). The [SPOKEN] tag is stripped on screen.
//   Enter send · Esc abort the in-flight turn · Ctrl+C / q on an empty line quit · Ctrl+L clear · Up recall
// Discipline: ALWAYS restore the terminal (raw off, cursor shown, leave the alt buffer) on EVERY exit
// path through one cleanup() wired to exit/SIGINT/SIGTERM/uncaughtException; re-render on SIGWINCH.
const http = require('http');
const os = require('os');
const path = require('path');
const readline = require('readline');

const SOCK = path.join(os.homedir(), '.claude', 'urfael', 'daemon.sock');

const GOLD = '\x1b[33m', DIM = '\x1b[2m', RST = '\x1b[0m', BOLD = '\x1b[1m';
const ALT_ON = '\x1b[?1049h', ALT_OFF = '\x1b[?1049l';
const CUR_HIDE = '\x1b[?25l', CUR_SHOW = '\x1b[?25h';
const stripSpoken = (t) => (t || '').replace(/\[\/?SPOKEN\]/gi, '');
// drop ANSI/control bytes that would corrupt the layout, but keep tab→space; width = visible cols
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

// ---- transcript model: a flat list of {who, text} entries; 'sys' rows carry tool/notice lines ----
const lines = [];          // { who: 'you'|'urfael'|'tool'|'sys', text }
let scroll = 0;            // rows scrolled UP from the bottom (0 = pinned to newest)
let input = '';            // current input buffer
let lastSent = '';         // for Up-arrow recall
let inflight = false;      // a turn is streaming
let vitals = { model: '', turnsToday: 0, warm: [] };
let streamReq = null;      // the live POST /ask request, so a hard quit can tear it down

function add(who, text) { lines.push({ who, text: sanitize(text) }); }

// wrap one logical line to `width` cols, returning >=1 physical rows (preserves blank lines)
function wrap(s, width) {
  const out = [];
  for (const para of String(s).split('\n')) {
    if (para === '') { out.push(''); continue; }
    let cur = para;
    while (cur.length > width) { out.push(cur.slice(0, width)); cur = cur.slice(width); }
    out.push(cur);
  }
  return out.length ? out : [''];
}

// flatten the transcript into colored, wrapped physical rows for the current width
function renderRows(width) {
  const rows = [];
  for (const e of lines) {
    let prefix = '', color = '';
    if (e.who === 'you') { prefix = 'you  '; color = BOLD; }
    else if (e.who === 'urfael') { prefix = ''; color = GOLD; }
    else if (e.who === 'tool') { prefix = '  '; color = DIM; }
    else { color = DIM; } // sys
    const body = e.who === 'tool' ? '⟳ ' + e.text : (prefix + e.text);
    const wrapped = wrap(body, width);
    for (let i = 0; i < wrapped.length; i++) {
      // continuation rows of a 'you' line get a hanging indent so the speaker prefix reads cleanly
      const indent = (e.who === 'you' && i > 0) ? '     ' : '';
      rows.push(color + (indent + wrapped[i]).slice(0, width) + RST);
    }
  }
  return rows;
}

function draw() {
  const cols = Math.max(20, process.stdout.columns || 80);
  const rowsTotal = Math.max(6, process.stdout.rows || 24);
  const width = cols;                         // transcript wraps to full width
  const paneH = rowsTotal - 2;                // last two rows: input line + status bar
  const all = renderRows(width);

  // clamp scroll so it can never run past the top or below the newest row
  const maxScroll = Math.max(0, all.length - paneH);
  if (scroll > maxScroll) scroll = maxScroll;
  if (scroll < 0) scroll = 0;
  const end = all.length - scroll;            // exclusive index of the last visible row + 1
  const start = Math.max(0, end - paneH);
  const view = all.slice(start, end);

  let out = '\x1b[H\x1b[2J';                   // home + clear
  for (let i = 0; i < paneH; i++) out += (view[i] || '') + '\x1b[K\r\n';

  // status bar (row rowsTotal-1)
  const status = ` ${GOLD}Urfael${RST}${DIM} · ${vitals.model || '…'} · ${vitals.turnsToday || 0} turns today${inflight ? ' · streaming' + (scroll ? ' · scrolled' : '') : (scroll ? ' · scrolled (End to pin)' : '')}${RST}`;
  out += DIM + '─'.repeat(cols) + RST + '\x1b[K\r\n';
  out += status + '\x1b[K\r\n';

  // input line (last row) — render with a visible caret, clipped to width
  const promptMark = inflight ? DIM + '… ' + RST : GOLD + '> ' + RST;
  const shown = input.length > cols - 4 ? input.slice(input.length - (cols - 4)) : input;
  out += '\x1b[' + rowsTotal + ';1H' + promptMark + shown + '\x1b[K';

  process.stdout.write(out);
}

// ---- streaming a turn: mirror cli.js ask() — POST /ask NDJSON, render delta/tool/done live ----
function sendTurn(text) {
  if (inflight) return;
  lastSent = text;
  add('you', text);
  scroll = 0;
  inflight = true;
  // start a fresh urfael line we append deltas into; index it so we can grow it in place
  add('urfael', '');
  const idx = lines.length - 1;
  draw();

  let buf = '', lastTool = '', sawDelta = false;
  const finish = (suffix) => {
    if (!inflight) return;
    inflight = false; streamReq = null;
    if (suffix) lines[idx].text = sanitize(lines[idx].text + suffix);
    if (!lines[idx].text) lines[idx].text = '(no reply)';
    draw();
  };

  const r = http.request({ socketPath: SOCK, method: 'POST', path: '/ask', headers: { 'Content-Type': 'application/json' }, timeout: 300000 }, (res) => {
    res.on('data', (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!ln) continue;
        let e; try { e = JSON.parse(ln); } catch { continue; }
        if (e.kind === 'thinking' && e.tool && e.tool !== lastTool) {
          lastTool = e.tool; add('tool', e.tool); draw();
        } else if (e.kind === 'thinking' && e.delta) {
          sawDelta = true; lines[idx].text = sanitize(lines[idx].text + stripSpoken(e.delta)); draw();
        } else if (e.kind === 'done') {
          // the 'done' carries the full final text; prefer it over accumulated deltas (e.g. when no deltas streamed)
          const finalText = stripSpoken(e.text || '');
          if (!sawDelta && finalText) lines[idx].text = sanitize(finalText);
          inflight = false; streamReq = null;
          if (!lines[idx].text) lines[idx].text = e.aborted ? '(stopped)' : '(no reply)';
          add('sys', e.aborted ? '— stopped' : '— ' + (e.model || '') + (e.ms ? ' · ' + (e.ms / 1000).toFixed(1) + 's' : ''));
          draw();
          refreshVitals();
        }
      }
    });
    res.on('end', () => finish(''));
  });
  streamReq = r;
  r.on('error', () => finish(lines[idx].text ? '' : ' (brain unreachable)'));
  r.on('timeout', () => { try { r.destroy(); } catch {} finish(' (timed out)'); });
  r.end(JSON.stringify({ text }));
}

function abortTurn() {
  if (!inflight) return;
  add('sys', '— aborting…'); draw();
  req('POST', '/abort').catch(() => {});
  // the daemon emits a {done, aborted} which closes the stream and flips inflight; nothing else to do here
}

function refreshVitals() {
  req('GET', '/vitals').then((v) => { if (v && typeof v === 'object') { vitals = v; draw(); } }).catch(() => {});
}

// ---- terminal lifecycle: ONE cleanup, wired to every exit path ----
let cleaned = false;
function cleanup() {
  if (cleaned) return; cleaned = true;
  try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
  try { process.stdin.pause(); } catch {}
  // leave alt buffer, show cursor, reset attributes — order matters: restore the main screen last
  try { process.stdout.write(RST + CUR_SHOW + ALT_OFF); } catch {}
}

function quit(code) { cleanup(); process.exit(code || 0); }

// ---- key handling ----
function onKey(str, key) {
  key = key || {};
  // Ctrl+C: abort an in-flight turn if any, else quit
  if (key.ctrl && key.name === 'c') { if (inflight) { abortTurn(); return; } return quit(0); }
  if (key.ctrl && key.name === 'd') { return quit(0); }
  if (key.ctrl && key.name === 'l') { lines.length = 0; scroll = 0; draw(); return; }

  if (key.name === 'escape') { if (inflight) abortTurn(); return; }

  if (key.name === 'return' || key.name === 'enter') {
    const text = input.trim();
    if (!text) return;            // Enter on empty line: ignore (q quits, not blank Enter)
    input = '';
    sendTurn(text);
    return;
  }

  if (key.name === 'backspace') { input = input.slice(0, -1); draw(); return; }

  // scrolling the transcript
  if (key.name === 'up' && (key.shift || key.meta)) { scroll += 1; draw(); return; }
  if (key.name === 'down' && (key.shift || key.meta)) { scroll = Math.max(0, scroll - 1); draw(); return; }
  if (key.name === 'pageup') { scroll += Math.max(1, (process.stdout.rows || 24) - 3); draw(); return; }
  if (key.name === 'pagedown') { scroll = Math.max(0, scroll - Math.max(1, (process.stdout.rows || 24) - 3)); draw(); return; }
  if (key.name === 'home') { scroll = 1e9; draw(); return; }   // clamped in draw()
  if (key.name === 'end') { scroll = 0; draw(); return; }

  // Up-arrow recalls the last sent line (only useful at an empty prompt; otherwise scrolls)
  if (key.name === 'up') { if (!input && lastSent) { input = lastSent; draw(); } else { scroll += 1; draw(); } return; }
  if (key.name === 'down') { scroll = Math.max(0, scroll - 1); draw(); return; }

  // 'q' on an empty line quits; otherwise it's just a character
  if (str === 'q' && input === '') { return quit(0); }

  // printable text: append (ignore other control keys)
  if (str && !key.ctrl && !key.meta && str.length === 1 && str >= ' ') { input += str; draw(); return; }
}

function run() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('urfael tui needs an interactive terminal (TTY). Use `urfael "..."` for one-shot questions.\n');
    process.exit(1);
  }

  // enter alt buffer + hide cursor BEFORE wiring cleanup so even an immediate failure restores cleanly
  process.stdout.write(ALT_ON + CUR_HIDE);
  process.on('exit', cleanup);
  process.on('SIGINT', () => { if (inflight) abortTurn(); else quit(0); });
  process.on('SIGTERM', () => quit(0));
  process.on('SIGHUP', () => quit(0));
  process.on('uncaughtException', (e) => { cleanup(); try { process.stderr.write('urfael tui crashed: ' + (e && e.stack || e) + '\n'); } catch {} process.exit(1); });
  process.stdout.on('error', () => {}); // EPIPE if the pane is torn out from under us

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', (str, key) => { try { onKey(str, key); } catch {} });

  process.stdout.on('resize', () => draw());     // SIGWINCH → re-render to new cols/rows

  add('sys', 'Urfael — Enter sends · Esc aborts · q or Ctrl+C quits · Ctrl+L clears · Up recalls');
  draw();
  refreshVitals();
}

module.exports = { run };

if (require.main === module) run();
