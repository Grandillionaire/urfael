'use strict';
// tui-render.js — the flicker-free differential renderer + a PURE row composer (replaces draw()).
//   compose(state, geom) → EXACTLY geom.rows strings, each pre-clipped+padded to geom.cols (a shorter
//                          new row overwrites a longer old one with no stray tail). PURE — unit-testable.
//   flush(frame, …)      → diffs vs the previous frame, writes ONLY changed rows. \x1b[2J is emitted
//                          ONLY on the first paint and after a resize (when prevFrame is reset/stale).
//   renderWorkerOnly(…)  → the cheap animation tick: rewrites just the worker row, restores the caret.

const md = require('./md');
// shared with cli.js: measure TRUE printed width (strip SGR + zero-width combining marks).
const visLen = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/[̀-ͯ]/g, '').length;

// clipPad(s, cols, RST): clip a coloured string to `cols` VISIBLE cells, pad to exactly `cols`, and
// always close with RST so no SGR leaks into the next row. Walks runes; SGR sequences are zero-width.
function clipPad(s, cols, RST) {
  RST = RST || '';
  s = String(s);
  let out = '', vis = 0, i = 0;
  while (i < s.length && vis < cols) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[ -\/]*[@-~]/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const ch = s[i];
    if (/[̀-ͯ]/.test(ch)) { out += ch; i++; continue; }   // zero-width combining mark
    out += ch; vis++; i++;
  }
  if (vis < cols) out += ' '.repeat(cols - vis);
  return out + RST;
}

// layout(geom, cfg): the row assignment, recomputed every render so resize stays correct.
//   row 0 = title; row 1 = spacer (unless compact); pane; rows-3 = worker/divider; rows-2 = status; rows-1 = input.
function layout(geom, cfg, inputH) {
  const rows = geom.rows;
  // input grows UPWARD for multi-line; always leave the title + at least one pane row + worker + status.
  const ih = Math.max(1, Math.min(inputH || 1, Math.max(1, rows - 4)));
  const inputTop = rows - ih, statusRow = inputTop - 1, workerRow = statusRow - 1;
  const spacerRow = cfg && cfg.compact ? -1 : 1;
  const paneTop = spacerRow < 0 ? 1 : 2;
  return { titleRow: 0, spacerRow, paneTop, paneBot: workerRow, paneH: Math.max(1, workerRow - paneTop), workerRow, statusRow, inputTop, inputRow: rows - 1, inputH: ih };
}

// buildTitle: a rounded ╭─ … ─╮ rule with the rune wordmark + model + mode glyph + 7-day sparkline.
function buildTitle(theme, v, cols) {
  let spark = '';
  try { spark = require('./lib').sparkline((v && v.days7) || []); } catch { spark = ''; }
  const mode = (v && v.mode) === 'full' ? theme.accent + 'FULL' + theme.RST : theme.gold + 'ᚦ fortress' + theme.RST;
  const dot = theme.dim + ' · ' + theme.RST;
  let head = theme.frame + '╭─ ' + theme.RST + theme.accent + 'ᚢ urfael' + theme.RST;
  if (v && v.persona) head += dot + theme.accent + v.persona.glyph + ' ' + theme.RST + theme.gold + v.persona.name + theme.RST;   // a chip AFTER the wordmark (never replacing it), only off-anchor
  head += dot + theme.gold + ((v && v.model) || '…') + theme.RST + dot + mode;
  if (spark) head += dot + theme.accent + spark + theme.RST;
  head += ' ';
  const fill = Math.max(1, cols - visLen(head) - 1);
  return head + theme.frame + '─'.repeat(fill) + '╮' + theme.RST;
}

// compose(state, geom): THE pure composer. Returns geom.rows fully-clipped strings.
//   state = { theme, cfg, vitals, lines (all wrapped+coloured rows), worker|null, statusText, promptMark, inputView, scroll }
function compose(state, geom) {
  const theme = state.theme, RST = theme.RST, cols = geom.cols, rows = geom.rows;
  const inputLines = state.inputLines || [ (state.promptMark || '') + (state.inputView || '') ];   // multi-line input block, or back-compat single row
  const L = layout(geom, state.cfg || {}, inputLines.length);
  const out = new Array(rows);

  out[L.titleRow] = clipPad(buildTitle(theme, state.vitals, cols), cols, RST);
  if (L.spacerRow >= 0) out[L.spacerRow] = clipPad('', cols, RST);

  // transcript window (bottom-pinned, scroll = rows up from newest)
  const all = state.lines || [];
  const maxScroll = Math.max(0, all.length - L.paneH);
  const sc = Math.min(Math.max(0, state.scroll || 0), maxScroll);
  const end = all.length - sc;
  const start = Math.max(0, end - L.paneH);
  const shown = all.slice(start, end);
  for (let i = 0; i < L.paneH; i++) out[L.paneTop + i] = clipPad(shown[i] || '', cols, RST);

  // the slash-command typeahead floats on the BOTTOM rows of the pane (directly above the prompt), so it overlays
  // the transcript without changing the frame height the differential writer expects. Clamped to the pane height.
  if (Array.isArray(state.menu) && state.menu.length) {
    const m = state.menu.slice(-L.paneH);
    for (let i = 0; i < m.length; i++) out[L.paneTop + L.paneH - m.length + i] = clipPad(m[i], cols, RST);
  }

  out[L.workerRow] = clipPad(state.worker != null ? state.worker : theme.dim + '─'.repeat(cols) + RST, cols, RST);
  out[L.statusRow] = clipPad(state.statusText || '', cols, RST);
  for (let i = 0; i < L.inputH; i++) out[L.inputTop + i] = clipPad(inputLines[i] || '', cols, RST);

  for (let i = 0; i < rows; i++) if (out[i] == null) out[i] = clipPad('', cols, RST);
  return out;
}

// ── the differential WRITER (the only mutable render state outside the model) ──
let prevFrame = null;

// flush(frame, caretCol, geom, out): write only rows that changed. Full-clear ONLY on first paint /
// resize. Leaves the hardware cursor parked at the input caret so typing is visible.
function flush(frame, caretCol, geom, out) {
  out = out || process.stdout;
  const sizeChanged = !prevFrame || prevFrame.length !== frame.length;
  let s = '';
  if (sizeChanged) s += '\x1b[2J';
  for (let i = 0; i < frame.length; i++) {
    if (sizeChanged || prevFrame[i] !== frame[i]) s += '\x1b[' + (i + 1) + ';1H' + frame[i] + '\x1b[K';
  }
  s += '\x1b[' + frame.length + ';' + Math.max(1, caretCol || 1) + 'H';
  out.write(s);
  prevFrame = frame;
}

// renderWorkerOnly(clipped, rowIndex, caretCol, out): the cheap tick. Touch ONE row, keep the cached
// frame correct, restore the caret. Never a 2J. No-ops when the row is byte-identical (0 bandwidth idle).
function renderWorkerOnly(clipped, rowIndex, caretCol, out) {
  out = out || process.stdout;
  if (!prevFrame || prevFrame[rowIndex] === clipped) return;
  prevFrame[rowIndex] = clipped;
  out.write('\x1b[' + (rowIndex + 1) + ';1H' + clipped + '\x1b[K' + '\x1b[' + prevFrame.length + ';' + Math.max(1, caretCol || 1) + 'H');
}

function resetFrame() { prevFrame = null; }

// wrap one logical line to `width` cols, returning >=1 physical rows (preserves blank lines).
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

// ANSI-aware wrap: break a styled line into rows ≤ width VISIBLE cells, never splitting an SGR sequence, and
// carrying the active SGR across each break so colour/bold survive a wrap (markdown answers stay styled).
function wrapAnsi(s, width) {
  const out = [];
  for (const para of String(s).split('\n')) {
    if (para === '') { out.push(''); continue; }
    let row = '', active = '', vis = 0, i = 0;
    while (i < para.length) {
      if (para[i] === '\x1b') {
        const m = /^\x1b\[[0-9;?]*[ -\/]*[@-~]/.exec(para.slice(i));
        if (m) { const c = m[0]; row += c; if (/^\x1b\[0?m$/.test(c)) active = ''; else active += c; i += c.length; continue; }
      }
      if (/[̀-ͯ]/.test(para[i])) { row += para[i]; i++; continue; }       // zero-width combining mark
      row += para[i]; vis++; i++;
      if (vis >= width) { out.push(row + (active ? '\x1b[0m' : '')); row = active; vis = 0; }
    }
    out.push(row + (active ? '\x1b[0m' : ''));
  }
  return out.length ? out : [''];
}

// renderTranscript(lines, width, T, opts): the themed speaker chrome → wrapped physical rows. PURE.
//   you    → a gold "┤you├" pill        urfael → a "ᚢ urfael" sigil column (caret on the live tail)
//   tool   → one collapsed dim row "⟳ a · b · c     N tools"
//   sys    → dim; a done-footer ("╶ …") gets its trailing rule extended to the edge
function renderTranscript(lines, width, T, opts) {
  opts = opts || {};
  const inflight = !!opts.inflight, answerIdx = opts.answerIdx == null ? -1 : opts.answerIdx;
  const rows = [];
  for (let ei = 0; ei < lines.length; ei++) {
    const e = lines[ei];
    if (e.who === 'tool') {
      const names = e.text || '', n = names ? names.split(' · ').length : 0;
      const left = '⟳ ' + names, right = n + (n === 1 ? ' tool' : ' tools');
      const pad = Math.max(1, width - left.length - right.length);
      rows.push(T.dim + (left + ' '.repeat(pad) + right) + T.RST);
      continue;
    }
    if (e.who === 'sys') {
      let txt = e.text || '';
      if (txt.startsWith('╶')) { const base = txt.replace(/[─\s]+$/, ''); txt = base + ' ' + '─'.repeat(Math.max(0, width - base.length - 1)); }
      for (const w of wrap(txt, width)) rows.push(T.dim + w + T.RST);
      continue;
    }
    const color = T.RST !== '';
    if (e.who === 'you') {
      const label = T.accent + '┤' + T.gold + 'you' + T.accent + '├' + T.RST + '  ', labelW = 7, indent = ' '.repeat(labelW);
      const wrapped = wrap(e.text, Math.max(8, width - labelW));
      for (let i = 0; i < wrapped.length; i++) rows.push((i === 0 ? label : indent) + T.bold + wrapped[i] + T.RST);
    } else {
      // urfael: render Markdown → ANSI (headings/bold/lists/code, not raw ## / **), gold-based, then ANSI-aware wrap.
      const label = T.accent + 'ᚢ' + T.RST + ' ' + T.gold + 'urfael' + T.RST + '  ', labelW = 10, indent = ' '.repeat(labelW);
      const styled = md.toAnsi(e.text, { color, base: color ? T.gold : '' });
      const wrapped = wrapAnsi(styled, Math.max(8, width - labelW));
      for (let i = 0; i < wrapped.length; i++) {
        let body = wrapped[i];
        if (inflight && ei === answerIdx && i === wrapped.length - 1) body += T.accent + '▌' + T.RST;
        rows.push((i === 0 ? label : indent) + body);
      }
    }
  }
  return rows;
}

module.exports = { visLen, clipPad, layout, wrap, wrapAnsi, renderTranscript, buildTitle, compose, flush, renderWorkerOnly, resetFrame, _peekPrev: () => prevFrame };
