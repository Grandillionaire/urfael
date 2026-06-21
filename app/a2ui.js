'use strict';
// app/a2ui.js — A2UI: a SAFE protocol for the agent to emit interactive UI (a "canvas"). The brain writes a fenced
// ```a2ui {json}``` block; this PURE module extracts it, validates against an ALLOWLISTED block schema, and SANITIZES
// it into a normalized structure a surface (dashboard / Console) renders. The security stance is the whole point: a
// renderer NEVER sees agent HTML or scripts, only allowlisted block types with type-checked, length-bounded props,
// hrefs forced to https, and button actions reduced to a bare command id (never a URL or JS). So a generative UI can
// not become an XSS or a click-to-exec vector, which is exactly how an agent "canvas" that renders raw HTML fails.
// Unit-tested + ReDoS-bounded + never throws. The renderer's contract: render every value as TEXT (textContent), not
// HTML; only follow https hrefs; treat a button action as an opaque command id to confirm with the owner.

const MAX_BLOCKS = 40, MAX_TEXT = 2000, MAX_ROWS = 50, MAX_COLS = 8, MAX_ITEMS = 50, MAX_ACTION = 120;
const TYPES = new Set(['heading', 'text', 'list', 'table', 'keyvalue', 'button', 'input', 'link', 'badge', 'progress', 'divider', 'card']);

// strip control chars + bound length. NOT HTML-escaped on purpose: the renderer must use textContent, so "<script>"
// is shown literally, never executed. Stripping control chars also defuses terminal-escape injection on a TUI render.
const text = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, n || MAX_TEXT);
const safeHref = (v) => { const s = String(v == null ? '' : v).trim(); return /^https:\/\/[^\s]{1,500}$/i.test(s) ? s : ''; };   // https ONLY: no javascript:/data:/file:/http
const ident = (v) => String(v == null ? '' : v).replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, MAX_ACTION);                          // a command id, never a url or code

// extract the a2ui payload(s) from agent text. Fenced ```a2ui …``` (preferred) or [A2UI]…[/A2UI]. Bounded scan (the
// {0,20000} cap keeps the regex linear, no catastrophic backtracking), at most 8 blocks.
function extract(s) {
  const str = String(s == null ? '' : s);
  const out = [];
  const fence = /```a2ui\s*([\s\S]{0,20000}?)```/gi; let m;
  while (out.length < 8 && (m = fence.exec(str))) out.push(m[1]);
  const tag = /\[A2UI\]([\s\S]{0,20000}?)\[\/A2UI\]/gi;
  while (out.length < 8 && (m = tag.exec(str))) out.push(m[1]);
  return out;
}

function sanitizeBlock(b, depth) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const t = String(b.type || '').toLowerCase();
  if (!TYPES.has(t)) return null;                                       // unknown type → dropped (no `script`, `html`, `iframe`, …)
  switch (t) {
    case 'heading': return { type: t, text: text(b.text, 200) };
    case 'text': return { type: t, text: text(b.text) };
    case 'badge': return { type: t, text: text(b.text, 60), tone: ['info', 'ok', 'warn', 'danger'].includes(b.tone) ? b.tone : 'info' };
    case 'divider': return { type: t };
    case 'progress': { const v = Number(b.value); return { type: t, value: Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0, label: text(b.label, 80) }; }
    case 'link': { const href = safeHref(b.href); return href ? { type: t, text: text(b.text, 120) || href, href } : null; }   // a non-https href drops the whole link
    case 'list': return { type: t, items: (Array.isArray(b.items) ? b.items : []).slice(0, MAX_ITEMS).map((x) => text(x, 200)) };
    case 'keyvalue': return { type: t, rows: (Array.isArray(b.rows) ? b.rows : []).slice(0, MAX_ITEMS).map((r) => ({ k: text(r && r.k, 80), v: text(r && r.v, 200) })) };
    case 'table': return { type: t, headers: (Array.isArray(b.headers) ? b.headers : []).slice(0, MAX_COLS).map((h) => text(h, 60)), rows: (Array.isArray(b.rows) ? b.rows : []).slice(0, MAX_ROWS).map((row) => (Array.isArray(row) ? row : []).slice(0, MAX_COLS).map((c) => text(c, 120))) };
    case 'button': return { type: t, label: text(b.label, 60), action: ident(b.action) };   // action = a bare command id; the surface confirms it with the owner
    case 'input': return { type: t, name: ident(b.name), label: text(b.label, 80), placeholder: text(b.placeholder, 120) };
    case 'card': {
      if ((depth || 0) >= 2) return null;                               // bounded nesting (no unbounded recursion)
      const children = (Array.isArray(b.children) ? b.children : []).slice(0, 12).map((c) => sanitizeBlock(c, (depth || 0) + 1)).filter(Boolean);
      return { type: t, title: text(b.title, 120), children };
    }
    default: return null;
  }
}

// parse(text) → { blocks, errors }. blocks is the SAFE normalized array; errors counts dropped/invalid blocks. Total.
function parse(s) {
  const blocks = []; let errors = 0;
  for (const chunk of extract(s)) {
    let j; try { j = JSON.parse(chunk); } catch { errors++; continue; }
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.blocks) ? j.blocks : [j]);
    for (const b of arr.slice(0, MAX_BLOCKS)) { const sb = sanitizeBlock(b, 0); if (sb) blocks.push(sb); else errors++; if (blocks.length >= MAX_BLOCKS) break; }
    if (blocks.length >= MAX_BLOCKS) break;
  }
  return { blocks, errors };
}
function has(s) { return extract(s).length > 0; }

module.exports = { parse, has, extract, sanitizeBlock, TYPES };
