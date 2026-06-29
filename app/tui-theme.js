'use strict';
// tui-theme.js — the TUI's theme + config, read ONCE at run() into a frozen object. Zero deps, no disk
// on require. Mirrors cli.js's palette (38;5;179 frame / 38;5;214 accent / 33 gold / 2 dim). The knob
// URFAEL_TUI_THEME falls back to URFAEL_THEME (the orb's theme) so the orb and cockpit share one setting.

const RST = '\x1b[0m';

// Four named themes. Each maps the five semantic roles the cockpit paints with:
//   frame  = box glyphs / rules        accent = live rune / caret / "you" pill / mode glyph
//   gold   = speaker text + headings   dim    = tool rows, footers, status chrome   bold = your echo
// fg(c): a foreground ANSI code from EITHER a 256-colour index (0-255) OR a '#rrggbb' hex (truecolor). 256-index is
// the safe default (works on Terminal.app + every 256 term); hex emits 24-bit for truecolor terminals (iTerm/kitty/
// wezterm/ghostty/alacritty). Invalid input -> '' (no code), so a bad value never corrupts the line.
function fg(c) {
  if (typeof c === 'number' && c >= 0 && c <= 255) return '\x1b[38;5;' + (c | 0) + 'm';
  const s = String(c == null ? '' : c).trim();
  if (/^\d{1,3}$/.test(s)) { const n = Math.min(255, parseInt(s, 10)); return '\x1b[38;5;' + n + 'm'; }
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
  if (m) return '\x1b[38;2;' + parseInt(m[1], 16) + ';' + parseInt(m[2], 16) + ';' + parseInt(m[3], 16) + 'm';
  return '';
}
const DIM = '\x1b[2m', BOLD = '\x1b[1m';
// Ten named themes (the original four byte-identical; six new, 256-colour so they render everywhere incl. Terminal.app).
// Each maps the five roles: frame (rules/boxes) · accent (rune/caret/you-pill) · gold (speaker text/headings) · dim · bold.
const THEMES = Object.freeze({
  gold:   { frame: '\x1b[38;5;179m', accent: '\x1b[38;5;214m', gold: '\x1b[33m',      dim: DIM, bold: BOLD },
  ember:  { frame: '\x1b[38;5;130m', accent: '\x1b[38;5;208m', gold: '\x1b[38;5;215m', dim: DIM, bold: BOLD },
  mono:   { frame: DIM,              accent: BOLD,             gold: BOLD,             dim: DIM, bold: BOLD },
  nord:   { frame: fg(67),  accent: fg(81),  gold: fg(110), dim: DIM, bold: BOLD },   // cool arctic blue
  matrix: { frame: fg(22),  accent: fg(46),  gold: fg(40),  dim: DIM, bold: BOLD },   // green-on-black
  rose:   { frame: fg(132), accent: fg(211), gold: fg(218), dim: DIM, bold: BOLD },   // warm pink
  violet: { frame: fg(97),  accent: fg(141), gold: fg(183), dim: DIM, bold: BOLD },   // royal purple
  ocean:  { frame: fg(31),  accent: fg(44),  gold: fg(80),  dim: DIM, bold: BOLD },   // teal / cyan
  sand:   { frame: fg(94),  accent: fg(130), gold: fg(136), dim: DIM, bold: BOLD },   // muted earth, reads on a LIGHT background
  custom: { frame: '\x1b[38;5;179m', accent: '\x1b[38;5;214m', gold: '\x1b[33m',     dim: DIM, bold: BOLD },  // user-paintable; see resolveTheme
});
// 16-colour fallback: same roles on the 8 base colours, so structure survives a vt100-ish terminal.
const THEME_16 = Object.freeze({ frame: '\x1b[33m', accent: '\x1b[1m\x1b[33m', gold: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m' });
const THEME_PLAIN = Object.freeze({ frame: '', accent: '', gold: '', dim: '', bold: '' });

const THEME_NAMES = ['gold', 'ember', 'mono', 'nord', 'matrix', 'rose', 'violet', 'ocean', 'sand', 'custom'];
const ANIM_NAMES = ['oracle', 'rune', 'ember', 'braille', 'scry', 'shimmer'];   // oracle (changing rune+word) is the default

// supports256(env): cheap, honest probe — COLORTERM=truecolor or a 256-capable TERM.
function supports256(env) {
  env = env || process.env;
  if (env.NO_COLOR != null && env.NO_COLOR !== '') return false;
  const t = env.TERM || '';
  return /256color|kitty|alacritty|wezterm|ghostty/i.test(t) || /truecolor|24bit/i.test(env.COLORTERM || '');
}

// resolveTheme(env, isTTY): a frozen palette {frame,accent,gold,dim,bold,RST}.
//   precedence: URFAEL_TUI_THEME > URFAEL_THEME > 'gold'; custom accent via URFAEL_TUI_ACCENT (0-255).
//   not a TTY → plain (no codes); has colour but not 256 → THEME_16; NO_COLOR → THEME_16 roles strip to dim/bold.
function resolveTheme(env, isTTY) {
  env = env || {};
  if (!isTTY) return Object.freeze({ ...THEME_PLAIN, RST: '' });
  const name = String(env.URFAEL_TUI_THEME || env.URFAEL_THEME || 'gold').toLowerCase();
  if (!supports256(env)) return Object.freeze({ ...THEME_16, RST });
  const base = THEMES[name] || THEMES.gold;
  const pal = { ...base, RST };
  // CUSTOM theme: paint each role from your own colour — a 256 index (0-255) OR a #rrggbb hex (truecolor). Set any of
  // URFAEL_TUI_FRAME / URFAEL_TUI_ACCENT / URFAEL_TUI_GOLD; unset roles keep the gold base. This is the terminal
  // equivalent of Hermes's user/imported themes: define your own full palette, not just one accent.
  if (name === 'custom') {
    const f = fg(env.URFAEL_TUI_FRAME || ''); if (f) pal.frame = f;
    const a = fg(env.URFAEL_TUI_ACCENT || ''); if (a) pal.accent = a;
    const g = fg(env.URFAEL_TUI_GOLD || ''); if (g) pal.gold = g;
  }
  return Object.freeze(pal);
}

// readCfg(env, isTTY): the ONE config read. Layers ~/.claude/urfael/.env (via setup.readEnv) under
// process.env, then resolves every knob into a frozen object. Pure given its args (env injectable for tests).
function readCfg(env, isTTY) {
  if (env === undefined) {
    let fileEnv = {};
    try { fileEnv = require('./setup').readEnv() || {}; } catch { fileEnv = {}; }
    env = { ...fileEnv, ...process.env };
  }
  if (isTTY === undefined) isTTY = !!(process.stdout && process.stdout.isTTY);
  // Presentation prefs (~/.claude/urfael/ui-prefs.json) are the persisted default — an explicit env var still wins.
  // Gated on the file EXISTING, so with no prefs file this is byte-identical to before (URFAEL_THEME fallback kept).
  try {
    const up = require('./ui-palette');
    const pp = up.defaultPrefsPath();
    if (require('fs').existsSync(pp)) {
      const prefs = up.loadPrefs(pp);
      if (!env.URFAEL_TUI_THEME && prefs.theme) env = { ...env, URFAEL_TUI_THEME: prefs.theme };
      if (!env.URFAEL_TUI_ANIM && prefs.animation) env = { ...env, URFAEL_TUI_ANIM: prefs.animation };
    }
  } catch {}
  const theme = resolveTheme(env, isTTY);

  const rm = String(env.URFAEL_TUI_REDUCE_MOTION || '').toLowerCase();
  const reduceMotion =
    /^(1|on|true)$/.test(rm) ? true :
    /^(0|off|false)$/.test(rm) ? false :
    (!isTTY || (env.NO_COLOR != null && env.NO_COLOR !== '') || /^(dumb|linux)$/.test(env.TERM || '') || !supports256(env) || !!env.CI);

  let anim = String(env.URFAEL_TUI_ANIM || 'oracle').toLowerCase();
  if (!ANIM_NAMES.includes(anim)) anim = 'oracle';
  let fps = parseInt(env.URFAEL_TUI_FPS || '12', 10);
  if (!Number.isFinite(fps) || fps < 4) fps = 4; if (fps > 20) fps = 20;
  const themeName = THEME_NAMES.includes(String(env.URFAEL_TUI_THEME || env.URFAEL_THEME || 'gold').toLowerCase())
    ? String(env.URFAEL_TUI_THEME || env.URFAEL_THEME || 'gold').toLowerCase() : 'gold';

  return Object.freeze({
    theme, themeName, anim,
    fps, frameMs: Math.round(1000 / fps),
    reduceMotion,
    compact: /^(1|on|true)$/i.test(env.URFAEL_TUI_COMPACT || ''),
    timestamps: /^(1|on|true)$/i.test(env.URFAEL_TUI_TIMESTAMPS || ''),
    isTTY,
  });
}

// withTheme/withAnim: return a NEW frozen cfg with the next theme/anim (for live ^T/^Y cycling — memory only).
function withTheme(cfg, env, isTTY) {
  const i = THEME_NAMES.indexOf(cfg.themeName);
  const name = THEME_NAMES[(i + 1) % THEME_NAMES.length];
  const e = { ...(env || {}), URFAEL_TUI_THEME: name };
  return Object.freeze({ ...cfg, themeName: name, theme: resolveTheme(e, isTTY == null ? cfg.isTTY : isTTY) });
}
function withAnim(cfg) {
  const i = ANIM_NAMES.indexOf(cfg.anim);
  return Object.freeze({ ...cfg, anim: ANIM_NAMES[(i + 1) % ANIM_NAMES.length] });
}

// setTheme/setAnim: like withTheme/withAnim but to a SPECIFIC name (for the /theme + /anim pickers' live preview).
// An unknown name is a no-op (fail-soft to the current cfg), so a picker can preview freely without ever throwing.
function setTheme(cfg, name, env, isTTY) {
  const n = String(name || '').toLowerCase();
  if (!THEME_NAMES.includes(n)) return cfg;
  const e = { ...(env || {}), URFAEL_TUI_THEME: n };
  return Object.freeze({ ...cfg, themeName: n, theme: resolveTheme(e, isTTY == null ? cfg.isTTY : isTTY) });
}
function setAnim(cfg, name) {
  const n = String(name || '').toLowerCase();
  return ANIM_NAMES.includes(n) ? Object.freeze({ ...cfg, anim: n }) : cfg;
}

module.exports = { THEMES, THEME_16, THEME_NAMES, ANIM_NAMES, RST, supports256, resolveTheme, readCfg, withTheme, withAnim, setTheme, setAnim };
