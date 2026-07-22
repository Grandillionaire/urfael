'use strict';
// council-view.js — the live, watchable "round table": you see the orchestrator decompose the task, dispatch the
// exact subtask prompt to each worker, watch each worker stream + use tools, then watch the synthesis. Reuses the
// flicker-free differential renderer (tui-render flush/clipPad/visLen/wrapAnsi) and the gold/runic theme. The
// reduce(state,e) reducer + composeCouncil(state,geom,theme) are PURE (unit-testable without a TTY); run() wires
// the unix socket + the alt buffer with the same one-cleanup discipline as the TUI.
const http = require('http');
const os = require('os');
const path = require('path');
const rend = require('./tui-render');
const themer = require('./tui-theme');
const md = require('./md');

const ipc = require('./ipc');
const SOCK = ipc.daemonSock();   // 0600 unix socket on POSIX; per-user named pipe + token on native Windows (see app/ipc.js)
const ALT_ON = '\x1b[?1049h', ALT_OFF = '\x1b[?1049l', CUR_HIDE = '\x1b[?25l', CUR_SHOW = '\x1b[?25h', RST = '\x1b[0m';

function newState() { return { task: '', head: { plan: '', text: '', phase: 'planning' }, workers: [], answer: '', status: '', ms: 0, tokens: 0 }; }
const lastLine = (s) => String(s || '').trim().split('\n').filter(Boolean).pop() || '';

// reduce(state, e): apply ONE protocol event. Pure — returns the same state object, mutated.
function reduce(state, e) {
  const w = (id) => state.workers.find((x) => x.id === id);
  switch (e && e.ev) {
    case 'council.start': state.task = e.task || ''; state.head.phase = 'planning'; break;
    case 'orchestrator.delta': state.head.text = (state.head.text || '') + (e.delta || ''); break;
    case 'orchestrator.plan': state.head.plan = e.plan || ''; state.head.phase = 'dispatching';
      state.workers = (e.subtasks || []).map((s) => ({ id: s.id, title: s.title || '', status: 'idle', verb: '', tail: '', tokens: 0, dispatch: '', tools: [] })); break;
    case 'orchestrator.dispatch': { const x = w(e.to); if (x) { x.status = 'thinking'; x.dispatch = e.prompt || ''; x.tools = e.tools || []; } break; }
    case 'agent.delta': { const x = w(e.id); if (x) x.tail = (x.tail + (e.delta || '')).replace(/\s+/g, ' ').slice(-240); break; }
    case 'agent.tool': { const x = w(e.id); if (x) { x.status = 'tool'; x.verb = e.tool || ''; } break; }
    case 'agent.done': { const x = w(e.id); if (x) { x.status = e.ok ? 'done' : 'failed'; x.tokens = e.tokens || 0; x.tail = lastLine(e.result); x.verb = ''; } break; }
    case 'synthesis.start': state.head.phase = 'synthesizing'; break;
    case 'synthesis.delta': state.answer = (state.answer || '') + (e.delta || ''); break;
    case 'council.done': state.head.phase = 'done'; if (e.answer) state.answer = e.answer; state.ms = e.ms || state.ms; state.tokens = e.tokens || state.tokens; break;
    case 'council.error': state.status = 'error: ' + (e.msg || e.reason || ''); state.head.phase = 'done'; break;
    case 'council.aborted': state.status = 'aborted'; state.head.phase = 'done'; break;
  }
  return state;
}

const PHASE = { planning: 'convening', dispatching: 'in session', synthesizing: 'synthesizing', done: 'adjourned' };
function seatGlyph(wk, t) {
  if (wk.status === 'done') return t.gold + '✓' + t.RST;
  if (wk.status === 'failed') return '\x1b[31m✗' + t.RST;
  if (wk.status === 'tool') return t.accent + '⟳' + t.RST;
  if (wk.status === 'thinking') return t.accent + 'ᚢ' + t.RST;
  return t.dim + '·' + t.RST;
}

// composeCouncil(state, geom, theme): EXACTLY geom.rows clipped strings. Content builds top→down; the last
// (rows-1) lines are shown (so streaming synthesis stays in view), with the status pinned at the bottom.
function composeCouncil(state, geom, theme) {
  const cols = geom.cols, rows = geom.rows, RST2 = theme.RST, g = theme.gold, d = theme.dim, a = theme.accent, f = theme.frame;
  const color = RST2 !== '';
  const out = [];
  const phase = PHASE[state.head.phase] || state.head.phase;
  const titleLabel = 'ᚢ council · ' + phase;
  out.push(f + '╭─ ' + a + titleLabel + RST2 + ' ' + f + '─'.repeat(Math.max(1, cols - rend.visLen(titleLabel) - 5)) + '╮' + RST2);
  out.push('');
  // orchestrator plan (or its live "decomposing…" text)
  const planTxt = state.head.plan || state.head.text || (state.head.phase === 'planning' ? 'decomposing the task…' : '');
  if (planTxt) for (const ln of rend.wrap(planTxt, Math.max(8, cols - 4))) out.push('  ' + g + 'orchestrator' + RST2 + d + '  ' + ln + RST2);
  out.push('');
  // the seats
  for (const wk of state.workers) {
    const head = '  ' + seatGlyph(wk, theme) + ' ' + g + wk.id + RST2 + ' ' + (wk.title || '');
    const meta = d + '  · ' + (wk.verb || wk.status) + (wk.tokens ? ' · ' + wk.tokens + 't' : '') + RST2;
    const room = cols - rend.visLen(head) - rend.visLen(meta) - 4;
    const tail = wk.tail && room > 6 ? '  ' + d + wk.tail.slice(0, room) + RST2 : '';
    out.push(head + meta + tail);
  }
  // synthesis pane (grows once it starts)
  if (state.head.phase === 'synthesizing' || state.answer) {
    out.push('');
    out.push('  ' + a + 'ᚢ' + RST2 + ' ' + g + 'synthesis' + RST2);
    const ans = md.toAnsi(state.answer || '…', { color, base: color ? g : '' });
    for (const ln of rend.wrapAnsi(ans, Math.max(8, cols - 4))) out.push('  ' + ln);
  }
  if (state.status) out.push('  \x1b[31m' + state.status + RST2);
  // fit: keep the last (rows-1) content lines, status pinned at the bottom.
  const status = ' ' + g + 'council' + RST2 + d + ' · ' + state.workers.length + ' agents' + (state.ms ? ' · ' + (state.ms / 1000).toFixed(1) + 's' : '') + (state.tokens ? ' · ' + state.tokens + 't' : '') + '   Ctrl+C abort · q quit' + RST2;
  const bodyH = Math.max(1, rows - 1);
  const shown = out.slice(Math.max(0, out.length - bodyH));
  const frame = [];
  for (let i = 0; i < bodyH; i++) frame.push(rend.clipPad(shown[i] || '', cols, RST2));
  frame.push(rend.clipPad(status, cols, RST2));
  return frame;
}

// humanize one event for the non-TTY (piped/CI) line-log degrade.
function humanize(e) {
  switch (e && e.ev) {
    case 'council.start': return '· council convened on: ' + (e.task || '').slice(0, 80);
    case 'orchestrator.plan': return '· plan: ' + (e.plan || '') + '  [' + (e.subtasks || []).map((s) => s.id).join(', ') + ']';
    case 'orchestrator.dispatch': return '  → ' + e.to + ' ' + (e.title || '') + '  tools=' + (e.tools || []).join('/');
    case 'agent.tool': return '    ' + e.id + ' ⟳ ' + e.tool;
    case 'agent.done': return '  ✓ ' + e.id + ' done (' + (e.tokens || 0) + 't)';
    case 'synthesis.start': return '· synthesizing…';
    case 'council.done': return '· council adjourned (' + Math.round((e.ms || 0) / 100) / 10 + 's, ' + (e.tokens || 0) + 't)\n\n' + (e.answer || '');
    case 'council.error': return '✗ ' + (e.msg || e.reason);
    case 'council.aborted': return '✗ aborted';
    default: return '';
  }
}

function run(task, agents, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const tty = !!(process.stdout.isTTY && process.stdin.isTTY);
    const cfg = themer.readCfg(undefined, tty);
    const theme = cfg.theme;
    const geom = () => ({ cols: Math.max(20, process.stdout.columns || 80), rows: Math.max(8, process.stdout.rows || 24) });
    let state = newState();

    // non-TTY: a plain NDJSON line-log (so `urfael council "…" | tee` and CI work).
    if (!tty) {
      const onEvent = (e) => { const l = humanize(e); if (l) process.stdout.write(l + '\n'); };
      streamCouncil(task, agents, opts, onEvent, () => resolve());
      return;
    }

    // TTY: the live alt-buffer round table.
    let cleaned = false;
    const cleanup = () => { if (cleaned) return; cleaned = true; try { process.stdin.setRawMode && process.stdin.isTTY && process.stdin.setRawMode(false); } catch {} try { process.stdin.pause(); } catch {} try { process.stdout.write(RST + CUR_SHOW + ALT_OFF); } catch {} };
    const quit = () => { cleanup(); resolve(); };
    process.stdout.write(ALT_ON + CUR_HIDE);
    process.on('exit', cleanup);
    const onSig = () => { req('POST', '/council/abort').catch(() => {}); setTimeout(quit, 300); };
    process.on('SIGINT', onSig); process.on('SIGTERM', quit); process.on('SIGHUP', quit);
    process.on('uncaughtException', () => { cleanup(); process.exit(1); });
    process.stdout.on('error', () => {});
    rend.resetFrame();
    const render = () => { try { rend.flush(composeCouncil(state, geom(), theme), 1, geom(), process.stdout); } catch {} };
    process.stdout.on('resize', () => { rend.resetFrame(); render(); });
    // a key reader: q / Ctrl+C quit (abort first if still running)
    try { process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', (b) => { const s = b.toString(); if (s === 'q' || s === '\x03') onSig(); }); } catch {}

    render();
    streamCouncil(task, agents, opts, (e) => { reduce(state, e); render(); }, () => {
      // leave the final frame up briefly so the synthesized answer is readable, then restore.
      setTimeout(() => { quit(); if (state.answer) process.stdout.write(md.toAnsi(state.answer, { color: theme.RST !== '', base: theme.RST !== '' ? theme.gold : '' }) + (theme.RST ? RST : '') + '\n'); }, 200);
    });
  });
}

// streamCouncil: open POST /council (or GET /council/:id/replay), parse NDJSON, call onEvent per line, onEnd at close.
function streamCouncil(task, agents, opts, onEvent, onEnd) {
  const replay = opts && opts.replay;
  const reqOpts = { socketPath: SOCK, method: replay ? 'GET' : 'POST', path: replay ? '/council/' + replay + '/replay' : '/council', headers: { 'Content-Type': 'application/json' }, timeout: 1800000 };
  const r = http.request(reqOpts, (res) => {
    let buf = '';
    res.on('data', (d) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!ln) continue; let e; try { e = JSON.parse(ln); } catch { continue; } onEvent(e); } });
    res.on('end', () => onEnd());
  });
  r.on('error', () => { onEvent({ ev: 'council.error', msg: 'the brain is unreachable — run `urfael doctor`' }); onEnd(); });
  r.on('timeout', () => { r.destroy(); onEnd(); });
  r.end(replay ? undefined : JSON.stringify({ task, agents: agents ? Number(agents) : undefined }));
}

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath: SOCK, method, path: p, headers: { 'Content-Type': 'application/json', ...ipc.authHeaders() }, timeout: 4000 }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } }); });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body) r.write(JSON.stringify(body)); r.end();
  });
}

module.exports = { run, reduce, composeCouncil, humanize, newState };
