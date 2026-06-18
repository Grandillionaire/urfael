'use strict';
// tui-theme.js — the TUI's theme + config, read ONCE at run() into a frozen object. Zero deps, no disk
// on require. Mirrors cli.js's palette (38;5;179 frame / 38;5;214 accent / 33 gold / 2 dim). The knob
// URFAEL_TUI_THEME falls back to URFAEL_THEME (the orb's theme) so the orb and cockpit share one setting.

const RST = '\x1b[0m';

// Four named themes. Each maps the five semantic roles the cockpit paints with:
//   frame  = box glyphs / rules        accent = live rune / caret / "you" pill / mode glyph
//   gold   = speaker text + headings   dim    = tool rows, footers, status chrome   bold = your echo
const THEMES = Object.freeze({
  gold:  { frame: '\x1b[38;5;179m', accent: '\x1b[38;5;214m', gold: '\x1b[33m',      dim: '\x1b[2m', bold: '\x1b[1m' },
  ember: { frame: '\x1b[38;5;130m', accent: '\x1b[38;5;208m', gold: '\x1b[38;5;215m', dim: '\x1b[2m', bold: '\x1b[1m' },
  mono:  { frame: '\x1b[2m',        accent: '\x1b[1m',         gold: '\x1b[1m',        dim: '\x1b[2m', bold: '\x1b[1m' },
  custom:{ frame: '\x1b[38;5;179m', accent: '\x1b[38;5;214m', gold: '\x1b[33m',      dim: '\x1b[2m', bold: '\x1b[1m' },
});
// 16-colour fallback: same roles on the 8 base colours, so structure survives a vt100-ish terminal.
const THEME_16 = Object.freeze({ frame: '\x1b[33m', accent: '\x1b[1m\x1b[33m', gold: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m' });
const THEME_PLAIN = Object.freeze({ frame: '', accent: '', gold: '', dim: '', bold: '' });

const THEME_NAMES = ['gold', 'ember', 'mono', 'custom'];
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
  if (name === 'custom' && /^\d{1,3}$/.test(env.URFAEL_TUI_ACCENT || '')) {
    pal.accent = `\x1b[38;5;${Math.min(255, parseInt(env.URFAEL_TUI_ACCENT, 10))}m`;
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

module.exports = { THEMES, THEME_16, THEME_NAMES, ANIM_NAMES, RST, supports256, resolveTheme, readCfg, withTheme, withAnim };
