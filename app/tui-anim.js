'use strict';
// tui-anim.js — the worker / thinking animation. Default = RUNIC CYCLE: the six-rune wordmark
// ᚢᚱᚠᚨᛖᛚ lighting one bright accent rune at a time, so the brand spells itself while Urfael thinks.
// Smoothness is by CONSTRUCTION: every index is a pure function of wall-clock elapsed, so a dropped
// timer tick SKIPS a frame (never stutters) with zero accumulated drift. Tokens are an HONEST ~Nk
// estimate (chars/4) while in flight — the daemon streams no live usage — that snaps to the
// authoritative done.usage.output_tokens and drops the '~' once the turn finishes.

const WORD = ['ᚢ', 'ᚱ', 'ᚠ', 'ᚨ', 'ᛖ', 'ᛚ'];        // U R F A E L (matches cli.js banner)

const ANIM = {
  rune:    [0, 1, 2, 3, 4, 5],                       // index space; rendered per-rune by runeRow()
  ember:   ['·', '•', '●', '●', '•', '·'],            // a breathing hearth-ember
  braille: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],  // the buttery classic, tinted accent
  scry:    ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '▆', '▅', '▄', '▃', '▂'],  // a divining bar rising/falling
  shimmer: ['▪▫▫', '▫▪▫', '▫▫▪', '▫▪▫'],              // a bright cell sweeping left↔right
};

// The THINKING pool — like Claude Code cycles words ("wrangling", "composing", "building"), Urfael cycles a
// changing RUNE paired with a dry thinking-word. The rune is the star (it changes); the word names it. Advanced
// on its OWN ~1.4s clock so it reads calmly while a fast micro-tick keeps the line alive.
const THINKING = [
  { r: 'ᛞ', w: 'divining' }, { r: 'ᛗ', w: 'recalling' }, { r: 'ᚲ', w: 'composing' }, { r: 'ᛟ', w: 'wrangling' },
  { r: 'ᛒ', w: 'building' }, { r: 'ᚦ', w: 'pondering' }, { r: 'ᛉ', w: 'weighing' }, { r: 'ᚹ', w: 'weaving' },
  { r: 'ᛚ', w: 'consulting the ledger' }, { r: 'ᚱ', w: 'reasoning' }, { r: 'ᛊ', w: 'discerning' }, { r: 'ᛖ', w: 'construing' },
  { r: 'ᚷ', w: 'reckoning' }, { r: 'ᛏ', w: 'forging' }, { r: 'ᚾ', w: 'untangling' }, { r: 'ᛜ', w: 'turning it over' },
  { r: 'ᚠ', w: 'considering' }, { r: 'ᛇ', w: 'attending' },
];
const VERBS = THINKING.map((x) => x.w);                     // the plain word pool (non-oracle styles + tests)
const ORACLE_MS = 1400;                                     // how long each rune+word holds

// tool-OVERRIDDEN verbs + runes — the voice + glyph stay honest about the ACTUAL tool in hand.
const TOOL_VERB = {
  search_memory: 'recalling', recall: 'recalling', memory: 'recalling', grep: 'recalling', glob: 'recalling',
  bash: 'setting hands to it', shell: 'setting hands to it', script: 'setting hands to it',
  web: 'scrying afar', web_search: 'scrying afar', websearch: 'scrying afar', webfetch: 'scrying afar', fetch: 'scrying afar',
  read: 'consulting the ledger', write: 'committing it', edit: 'committing it',
};
const TOOL_RUNE = {
  search_memory: 'ᛗ', recall: 'ᛗ', memory: 'ᛗ', grep: 'ᛗ', glob: 'ᛗ',
  bash: 'ᛏ', shell: 'ᛏ', script: 'ᛏ', web: 'ᚱ', web_search: 'ᚱ', websearch: 'ᚱ', webfetch: 'ᚱ', fetch: 'ᚱ',
  read: 'ᛚ', write: 'ᚲ', edit: 'ᚲ',
};
const verbFor = (tool) => tool ? (TOOL_VERB[String(tool).toLowerCase()] || ('working: ' + tool)) : null;
const runeForTool = (tool) => (tool && TOOL_RUNE[String(tool).toLowerCase()]) || 'ᛟ';
const VERB_MS = 2000;

// runeRow(theme, idx, wide): the runic-cycle cluster. NARROW = one rune lit; WIDE (cols≥90) = a sweep
// (runes up to idx lit). Pure — returns a coloured string.
function runeRow(theme, idx, wide) {
  const lit = ((idx % 6) + 6) % 6;
  let s = '';
  for (let i = 0; i < 6; i++) {
    const on = wide ? (i <= lit) : (i === lit);
    s += (on ? theme.accent : theme.dim) + WORD[i] + theme.RST;
  }
  return s;
}

// spinnerGlyph(cfg, theme, t0, now, cols): the active glyph for the current style. Index is wall-clock.
function spinnerGlyph(cfg, theme, t0, now, cols) {
  const frames = Math.floor((now - t0) / cfg.frameMs);
  if (cfg.anim === 'rune') return runeRow(theme, frames, (cols || 80) >= 90);
  const seq = ANIM[cfg.anim] || ANIM.braille;
  return theme.accent + seq[((frames % seq.length) + seq.length) % seq.length] + theme.RST;
}

const estTokens = (chars) => Math.round((chars || 0) / 4);
function fmtTok(n) { n = n | 0; return n >= 1000 ? (Math.round(n / 100) / 10) + 'k' : String(n); }

// workerVerb(t0, now, lastTool): the dry verb; the current tool overrides the rotating pool.
function workerVerb(t0, now, lastTool) {
  const t = verbFor(lastTool);
  if (t) return t;
  return VERBS[Math.floor((now - t0) / VERB_MS) % VERBS.length];
}

// composeWorker(cfg, theme, st, cols, now): the ONE worker line, PURE, fully coloured, NOT clipped.
//   st = { t0, lastTool, answerChars, usageTokens|null }
//   reduce-motion → a static, screen-reader-friendly line (no glyph cycling).
function composeWorker(cfg, theme, st, cols, now) {
  const secs = ((now - st.t0) / 1000).toFixed(1) + 's';
  const woven = st.usageTokens != null ? fmtTok(st.usageTokens) + ' tok' : '~' + fmtTok(estTokens(st.answerChars)) + ' woven';
  if (cfg.reduceMotion) {
    const verb = st.lastTool ? verbFor(st.lastTool) : 'thinking…';
    return theme.dim + 'ᚢ urfael is ' + verb + ' · ' + secs + theme.RST;
  }
  // ORACLE (default): a fast braille micro-tick for liveness + a CHANGING rune and its thinking-word (~1.4s each).
  if (cfg.anim === 'oracle') {
    const pair = THINKING[Math.floor((now - st.t0) / ORACLE_MS) % THINKING.length];
    const tick = ANIM.braille[Math.floor((now - st.t0) / cfg.frameMs) % ANIM.braille.length];
    const rune = st.lastTool ? runeForTool(st.lastTool) : pair.r;
    const word = st.lastTool ? verbFor(st.lastTool) : pair.w;
    const tool = st.lastTool ? theme.dim + ' · ⟳ ' + st.lastTool + theme.RST : '';
    return theme.accent + tick + ' ' + rune + theme.RST + '  ' + theme.gold + word + theme.dim + ' · ' + secs + ' · ' + woven + theme.RST + tool;
  }
  const glyph = spinnerGlyph(cfg, theme, st.t0, now, cols);
  const verb = workerVerb(st.t0, now, st.lastTool);
  const tool = st.lastTool ? theme.dim + ' · ⟳ ' + st.lastTool + theme.RST : '';
  return glyph + '  ' + theme.gold + verb + theme.dim + ' · ' + secs + ' · ' + woven + theme.RST + tool;
}

// the tick: a single unref'd interval that asks the caller to repaint ONLY the worker row. In
// reduce-motion mode it's a slow 1s clock just to advance the elapsed seconds (no fps spin).
function startWorker(cfg, repaintWorker) {
  const t = setInterval(repaintWorker, cfg.reduceMotion ? 1000 : cfg.frameMs);
  if (t.unref) t.unref();
  return t;
}
function stopWorker(timer) { if (timer) clearInterval(timer); return null; }

// previewGlyph(name, theme, t0, now): a LIVE-animating sample of one animation style, for the picker preview so the
// owner sees exactly what each one looks like while choosing (not just a static blurb). Pure; wall-clock index, so
// it animates as the caller repaints. Reuses the real renderers, so the preview matches the actual worker row.
function previewGlyph(name, theme, t0, now) {
  if (name === 'oracle') {
    const pair = THINKING[Math.floor((now - t0) / ORACLE_MS) % THINKING.length];
    const tick = ANIM.braille[Math.floor((now - t0) / 90) % ANIM.braille.length];
    return theme.accent + tick + ' ' + theme.gold + pair.r + ' ' + pair.w + theme.RST;
  }
  if (name === 'rune') return runeRow(theme, Math.floor((now - t0) / 220), true);
  return spinnerGlyph({ anim: name, frameMs: 90 }, theme, t0, now, 80);   // ember / braille / scry / shimmer
}

module.exports = { WORD, ANIM, THINKING, VERBS, TOOL_VERB, TOOL_RUNE, VERB_MS, ORACLE_MS, verbFor, runeForTool, runeRow, spinnerGlyph,
                   estTokens, fmtTok, workerVerb, composeWorker, startWorker, stopWorker, previewGlyph };
