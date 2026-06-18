'use strict';
// Tests for the TUI's pure modules: theme resolution, the wall-clock animation, token honesty, the
// flicker-free differential writer, the speaker chrome, and the layout. No real TTY required.
const { test } = require('node:test');
const assert = require('node:assert');
const themer = require('../tui-theme');
const anim = require('../tui-anim');
const rend = require('../tui-render');

const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
const TH = themer.resolveTheme({ URFAEL_TUI_THEME: 'gold', TERM: 'xterm-256color' }, true);
const CFG = (over) => Object.assign({ theme: TH, anim: 'braille', frameMs: 80, reduceMotion: false, compact: false }, over);

// ── theme resolution ──────────────────────────────────────────────────────────────────────────
test('resolveTheme: URFAEL_TUI_THEME wins, falls back to URFAEL_THEME, then gold', () => {
  assert.equal(themer.resolveTheme({ URFAEL_TUI_THEME: 'ember', TERM: 'xterm-256color' }, true).accent, '\x1b[38;5;208m');
  assert.equal(themer.resolveTheme({ URFAEL_THEME: 'ember', TERM: 'xterm-256color' }, true).accent, '\x1b[38;5;208m'); // fallback
  assert.equal(themer.resolveTheme({ TERM: 'xterm-256color' }, true).accent, '\x1b[38;5;214m');                        // default gold
});

test('resolveTheme: degrades to 16-colour without 256, to plain without a TTY, honours NO_COLOR', () => {
  assert.doesNotMatch(themer.resolveTheme({ URFAEL_TUI_THEME: 'gold', TERM: 'vt100' }, true).accent, /38;5;/);
  assert.doesNotMatch(themer.resolveTheme({ NO_COLOR: '1', TERM: 'xterm-256color' }, true).accent, /38;5;/);
  assert.equal(themer.resolveTheme({ TERM: 'xterm-256color' }, false).accent, '');   // piped → no codes
});

test('readCfg: reduce-motion auto-on under NO_COLOR / dumb / non-256; fps clamps; anim validates', () => {
  assert.equal(themer.readCfg({ NO_COLOR: '1', TERM: 'xterm-256color' }, true).reduceMotion, true);
  assert.equal(themer.readCfg({ TERM: 'dumb' }, true).reduceMotion, true);
  assert.equal(themer.readCfg({ TERM: 'xterm-256color', URFAEL_TUI_REDUCE_MOTION: 'off' }, true).reduceMotion, false);
  assert.equal(themer.readCfg({ TERM: 'xterm-256color', URFAEL_TUI_FPS: '999' }, true).fps, 20);
  assert.equal(themer.readCfg({ TERM: 'xterm-256color', URFAEL_TUI_FPS: '1' }, true).fps, 4);
  assert.equal(themer.readCfg({ TERM: 'xterm-256color', URFAEL_TUI_ANIM: 'bogus' }, true).anim, 'oracle');
});

test('withTheme / withAnim cycle to the next option without mutating the original cfg', () => {
  const c0 = themer.readCfg({ TERM: 'xterm-256color' }, true);
  const c1 = themer.withAnim(c0);
  assert.notEqual(c1.anim, c0.anim);
  assert.equal(c0.anim, 'oracle');               // original untouched (oracle is the default)
  const t1 = themer.withTheme(c0, { TERM: 'xterm-256color' }, true);
  assert.equal(t1.themeName, 'ember');           // gold → ember
});

// ── the wall-clock animation (the smoothness guarantee) ─────────────────────────────────────────
test('spinnerGlyph: index is a pure function of wall-clock — advances, wraps, a dropped tick is no-op', () => {
  const cfg = CFG();
  const g = (now) => strip(anim.spinnerGlyph(cfg, TH, 0, now, 80));
  assert.notEqual(g(0), g(80));                  // one frame later (80ms) changes
  assert.equal(g(0), g(800));                    // 10 frames later (braille len 10) = full wrap
  assert.equal(g(40), g(0));                     // a dropped tick WITHIN a frame = no visible change (no stutter)
});

test('runeRow: narrow lights exactly one rune; wide sweep lights up to idx', () => {
  assert.equal((anim.runeRow(TH, 2, false).match(/38;5;214m/g) || []).length, 1);   // one bright
  assert.equal((anim.runeRow(TH, 5, true).match(/38;5;214m/g) || []).length, 6);    // all six by idx 5
  assert.ok(strip(anim.runeRow(TH, 0, false)).startsWith('ᚢ'));                       // the wordmark, in order
});

test('verbFor: a tool overrides the rotating verb pool; the voice stays honest about the work', () => {
  assert.equal(anim.verbFor('search_memory'), 'recalling');
  assert.equal(anim.verbFor('Bash'), 'setting hands to it');
  assert.equal(anim.verbFor('WebSearch'), 'scrying afar');
  assert.equal(anim.verbFor(''), null);
  assert.ok(anim.VERBS.includes(anim.workerVerb(0, 0, '')));   // no tool → a member of the pool
});

test('composeWorker token honesty: ~estimate in flight, snaps to authoritative on done (no ~)', () => {
  const inFlight = strip(anim.composeWorker(CFG(), TH, { t0: 0, lastTool: '', answerChars: 4400, usageTokens: null }, 80, 1000));
  assert.match(inFlight, /~1\.1k woven/);                       // chars/4 estimate, always prefixed ~
  const done = strip(anim.composeWorker(CFG(), TH, { t0: 0, lastTool: '', answerChars: 4400, usageTokens: 1203 }, 80, 1000));
  assert.match(done, /1\.2k tok/);
  assert.doesNotMatch(done, /~/);                              // authoritative — the ~ is gone
});

test('composeWorker reduce-motion: a static, screen-reader-friendly line (no glyph cycling)', () => {
  const s = strip(anim.composeWorker(CFG({ reduceMotion: true }), TH, { t0: 0, lastTool: 'Bash', answerChars: 0, usageTokens: null }, 80, 3200));
  assert.match(s, /urfael is setting hands to it · 3\.2s/);
});

// ── the flicker-free differential writer ────────────────────────────────────────────────────────
test('flush: \\x1b[2J only on first paint + resize; otherwise just the changed rows', () => {
  const sink = { buf: '', write(s) { this.buf += s; } };
  rend.resetFrame();
  rend.flush(['AAA', 'BBB'], 1, { cols: 3, rows: 2 }, sink);
  assert.ok(sink.buf.includes('\x1b[2J'));                     // first paint clears once
  sink.buf = '';
  rend.flush(['AAA', 'CCC'], 1, { cols: 3, rows: 2 }, sink);
  assert.ok(!sink.buf.includes('\x1b[2J'));                    // same size → no clear
  assert.ok(sink.buf.includes('\x1b[2;1H'));                   // the changed row IS rewritten
  assert.ok(!sink.buf.includes('\x1b[1;1H'));                  // the unchanged row is NOT
  sink.buf = '';
  rend.flush(['A', 'B', 'C'], 1, { cols: 1, rows: 3 }, sink);
  assert.ok(sink.buf.includes('\x1b[2J'));                     // length changed (resize) → clear once
});

test('renderWorkerOnly: writes one row and no 2J; no-ops when the row is unchanged', () => {
  const sink = { buf: '', write(s) { this.buf += s; } };
  rend.resetFrame();
  rend.flush(['t', 'p', 'w', 's', 'i'], 1, { cols: 1, rows: 5 }, sink);
  sink.buf = '';
  rend.renderWorkerOnly('X', 2, 1, sink);
  assert.ok(sink.buf.includes('\x1b[3;1HX'));                  // worker row (index 2 → line 3)
  assert.ok(!sink.buf.includes('\x1b[2J'));
  sink.buf = '';
  rend.renderWorkerOnly('X', 2, 1, sink);
  assert.equal(sink.buf, '');                                  // identical → zero bytes written
});

// ── pure composer invariants ────────────────────────────────────────────────────────────────────
const STATE = (over) => Object.assign({
  theme: TH, cfg: CFG(), vitals: { model: 'claude-sonnet-4', mode: 'fortress', turnsToday: 3, days7: [1, 2, 3, 4, 5, 6, 7] },
  lines: rend.renderTranscript([{ who: 'you', text: 'hello there' }, { who: 'urfael', text: 'At your service, sir.' }], 80, TH, {}),
  worker: null, statusText: ' status', promptMark: '\x1b[33m> \x1b[0m', inputView: '', scroll: 0,
}, over);

test('compose: returns EXACTLY rows strings, each EXACTLY cols visible cells (no stray tail, no short row)', () => {
  for (const [cols, rows] of [[80, 24], [120, 40], [40, 10], [20, 8]]) {
    const frame = rend.compose(STATE(), { cols, rows });
    assert.equal(frame.length, rows, cols + 'x' + rows + ' row count');
    for (const r of frame) assert.equal(rend.visLen(r), cols, cols + 'x' + rows + ' row width');
  }
});

test('layout: the worker row is always rows-3 across geometries (resize math cannot drift)', () => {
  for (const [cols, rows] of [[80, 24], [120, 40], [40, 10], [20, 8]]) {
    const L = rend.layout({ cols, rows }, CFG());
    assert.equal(L.workerRow, rows - 3);
    assert.equal(L.inputRow, rows - 1);
    assert.equal(L.statusRow, rows - 2);
  }
});

test('clipPad: clips to cols visible cells (SGR is zero-width), pads short rows, always ends in RST', () => {
  assert.equal(strip(rend.clipPad('\x1b[33mhello\x1b[0m world!!!', 8, '\x1b[0m')), 'hello wo');
  assert.equal(rend.visLen(rend.clipPad('x', 5, '\x1b[0m')), 5);
  assert.ok(rend.clipPad('x', 5, '\x1b[0m').endsWith('\x1b[0m'));
});

// ── the speaker chrome ──────────────────────────────────────────────────────────────────────────
test('renderTranscript: you-pill, urfael-sigil, collapsed tool row with a tally, streaming caret', () => {
  const rows = rend.renderTranscript([
    { who: 'you', text: 'do the thing' },
    { who: 'tool', text: 'search_memory · bash · web_search' },
    { who: 'urfael', text: 'Working on it' },
  ], 80, TH, { inflight: true, answerIdx: 2 });
  const plain = rows.map(strip);
  assert.ok(plain.some((r) => r.includes('┤you├')), 'you pill');
  assert.ok(plain.some((r) => r.startsWith('ᚢ urfael')), 'urfael sigil column');
  assert.ok(plain.some((r) => r.startsWith('⟳ search_memory · bash · web_search') && r.trimEnd().endsWith('3 tools')), 'collapsed tools + tally');
  assert.ok(plain.some((r) => r.includes('Working on it▌')), 'streaming caret on the live answer');
});

test('renderTranscript: a done-footer "╶ …" extends its rule to the width', () => {
  const rows = rend.renderTranscript([{ who: 'sys', text: '╶ claude-sonnet-4 · 2.4s · 1.2k tok' }], 60, TH, {});
  assert.equal(rend.visLen(rows[0]), 60);
  assert.ok(strip(rows[0]).endsWith('─'));
});

test('buildTitle: the ᚢ urfael wordmark is always present; a persona is a CHIP after it, only off-anchor', () => {
  const anchor = strip(rend.buildTitle(TH, { model: 'sonnet', mode: 'fortress', persona: null }, 80));
  assert.ok(anchor.startsWith('╭─ ᚢ urfael'), 'wordmark present on the anchor');
  assert.ok(!/The Architect/.test(anchor), 'no persona chip on the anchor');
  const chipped = strip(rend.buildTitle(TH, { model: 'sonnet', mode: 'fortress', persona: { glyph: 'ᚨ', name: 'The Architect' } }, 80));
  assert.ok(chipped.includes('ᚢ urfael'), 'wordmark NOT replaced by the persona');
  assert.ok(chipped.includes('The Architect'), 'persona chip added after the wordmark');
});
