'use strict';
// md.js — lightweight, dependency-free Markdown → ANSI for the terminal, so streamed answers read like Claude
// Code's terminal (rendered headings / bold / lists / code) instead of raw ## and ** . Streaming-tolerant: an
// unclosed **/`/``` simply stays literal until its partner arrives (the next render resolves it). Inline styles
// use ATTRIBUTE on/off codes (\x1b[1m…\x1b[22m) and return colour spans to a caller-supplied `base`, so a gold
// answer stays gold with only the accents changing — never a full reset that drops the theme.

// SGR: bold on/off, italic on/off, underline on/off — these toggle ONE attribute and leave colour intact.
const B0 = '\x1b[1m', B1 = '\x1b[22m', I0 = '\x1b[3m', I1 = '\x1b[23m', U0 = '\x1b[4m', U1 = '\x1b[24m';
const CODE = '\x1b[38;5;215m';   // inline/code-fence tint (a light amber); returns to `base` (or default fg)

// inline(s, base, color): render the inline spans of ONE line. Inline code is protected first (no styling inside).
// Every span quantifier is BOUNDED (e.g. {1,400}) so a long run of one char can't make the global replace
// quadratic (a ReDoS on the streamed-render hot path); a pathological long line styles only its head, raw tail.
function inline(s, base, color) {
  if (s.length > 4000) return inline(s.slice(0, 4000), base, color) + (color ? (base || '') : '') + s.slice(4000);
  if (!color) return s.replace(/`([^`\n]{1,400})`/g, '$1').replace(/\*\*([^*\n]{1,300})\*\*/g, '$1').replace(/__([^_\n]{1,300})__/g, '$1')
    .replace(/(?<![\w*])\*([^*\n]{1,300})\*(?![\w*])/g, '$1').replace(/(?<![\w_])_([^_\n]{1,300})_(?![\w_])/g, '$1')
    .replace(/\[([^\]\n]{1,300})\]\(([^)\n]{1,600})\)/g, '$1');
  const ret = base || '\x1b[39m';
  const codes = [];
  s = s.replace(/`([^`\n]{1,400})`/g, (m, c) => { codes.push(c); return '\x00' + (codes.length - 1) + '\x01'; });   // stash code spans
  s = s.replace(/\*\*([^*\n]{1,300})\*\*/g, B0 + '$1' + B1)
       .replace(/__([^_\n]{1,300})__/g, B0 + '$1' + B1)
       .replace(/(?<![\w*])\*([^*\n]{1,300})\*(?![\w*])/g, I0 + '$1' + I1)
       .replace(/(?<![\w_])_([^_\n]{1,300})_(?![\w_])/g, I0 + '$1' + I1)
       .replace(/\[([^\]\n]{1,300})\]\(([^)\n]{1,600})\)/g, U0 + '$1' + U1);
  s = s.replace(/\x00(\d+)\x01/g, (m, i) => CODE + codes[+i] + ret);     // restore code spans, tinted, returning to base
  return s;
}

// toAnsi(text, { color=true, base='' }) → a \n-joined string of styled lines. `base` is an SGR the whole answer
// sits in (e.g. gold); every line is prefixed with it and colour spans return to it.
function toAnsi(text, opts) {
  opts = opts || {};
  const color = opts.color !== false;
  const base = color ? (opts.base || '') : '';
  const lead = (l) => base + l;
  const out = [];
  let inFence = false;
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }              // drop the fence markers themselves
    if (inFence) { out.push(color ? CODE + raw + (base || '\x1b[0m') : raw); continue; }   // code body: tinted, no inline parsing
    let m;
    if ((m = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(raw))) { out.push(lead(color ? B0 + inline(m[2], base, color) + B1 : m[2])); continue; }   // heading → bold (markers dropped)
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(raw)) { out.push(lead(color ? '\x1b[2m' + '─'.repeat(Math.min(48, opts.width || 48)) + (base || '\x1b[0m') : '----')); continue; }   // hr
    if ((m = /^(\s*)([-*+])\s+(.*)$/.exec(raw))) { out.push(lead(m[1] + '• ' + inline(m[3], base, color))); continue; }                 // bullet
    if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(raw))) { out.push(lead(m[1] + m[2] + '. ' + inline(m[3], base, color))); continue; }        // ordered
    if ((m = /^\s*>\s?(.*)$/.exec(raw))) { out.push(lead((color ? '\x1b[2m│ ' + (base || '') : '| ') + inline(m[1], base, color))); continue; }   // blockquote
    out.push(lead(inline(raw, base, color)));
  }
  return out.join('\n');
}

module.exports = { toAnsi, inline };
