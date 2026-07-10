'use strict';
// app/context-report.js — CONTEXT ATTRIBUTION: per-category accounting of what fills the model input for one turn.
// Given the pieces Urfael ASSEMBLES for a turn (the system/persona prompt, the MEMORY.md/USER.md/LESSONS.md/
// WORKFLOW.md memory files, the recalled-memory block, any @-file refs, and — on the native engine only — the
// running message history + tool outputs) this reports the BYTES each occupies, an explicitly-labelled TOKEN
// ESTIMATE per category (documented chars/4, never presented as exact), the share of the total, the biggest
// consumers, and a one-command TRIM for each so bloat is actionable (a fat recall block → `urfael forget` or turn
// active recall off; a fat memory file → `urfael forget`).
//
// PURE + Node-stdlib-only + NEVER THROWS. It only READS the strings it is handed and never mutates them, so it can
// be fed from the exact same assembly seam as the recalled-memory preamble (memctx) and from the native engine's
// toWire {system, messages} without perturbing a single byte of the turn — the shipped brain stays byte-identical.
//
// HONESTY, two ways:
//   - On the NATIVE engine Urfael owns the whole window, so every category here is MEASURED from the exact bytes it
//     builds (only the /token/ column is an estimate; the byte column is exact and sums to the wire payload).
//   - On the CLI (subscription) engine the `claude` CLI owns its own running window (see the note in consolidate.js:3),
//     so the parts Urfael cannot see are collected into ONE explicitly-labelled category, 'CLI-managed (not measured
//     here)' (bytes:null), rather than guessed at. We report what we assemble and we say what we cannot.
//
// idea studied from NousResearch/hermes-agent (MIT) — its per-category context popover is a heuristic estimate;
// this measures Urfael's own assembled bytes. Patterns only; no code copied.

// Documented rough estimate. English text runs ~4 chars/token for the common tokenizers; this is a SIGNPOST for
// "how much of the window is this", LABELLED an estimate everywhere it surfaces, never a billed or exact figure.
const CHARS_PER_TOKEN = 4;

const CLI_REMAINDER = 'CLI-managed (not measured here)';

function s(v) { return v == null ? '' : String(v); }
function bytesOf(v) { try { return Buffer.byteLength(s(v), 'utf8'); } catch { return 0; } }
function charsOf(v) { return s(v).length; }
function estTokens(chars) { const n = Number(chars); return Number.isFinite(n) && n > 0 ? Math.round(n / CHARS_PER_TOKEN) : 0; }

// The one-command trim per category — every hint is a REAL knob (an env flag or a shipped command), never a
// nice-to-have. Keyed by the stable category `key`.
const TRIMS = {
  system: 'edit the constitution (CLAUDE.md) or switch to a leaner persona',
  memory: 'urfael forget "<phrase>"   (drops the matching belief + leaves a git tombstone)',
  recall: 'urfael forget "<phrase>"   ·   URFAEL_ACTIVE_RECALL=0 to turn active recall off',
  refs: 'drop the @-file reference from your message, or reference a smaller slice',
  history: 'start a fresh session; the native window auto-compacts as it fills',
  cli: 'the claude CLI owns this running window; end the conversation to reset it',
};

// memoryFiles may arrive as an object {name:text} or an array [{name,text}] — normalize to [{name,text}], skipping
// empty/oddly-shaped entries so junk input can never throw or fabricate a category.
function normMemoryFiles(mf) {
  const out = [];
  if (!mf) return out;
  if (Array.isArray(mf)) {
    for (const e of mf) { if (e && typeof e.name === 'string' && e.name) out.push({ name: e.name, text: s(e.text) }); }
  } else if (typeof mf === 'object') {
    for (const name of Object.keys(mf)) { if (name) out.push({ name, text: s(mf[name]) }); }
  }
  return out;
}

// refs may arrive as ['<text>', ...] or [{name,text}, ...] — collapse to one combined blob + a count, since the
// window only cares about the total the references add (per-ref detail would just be noise in a per-turn readout).
function refsBlob(refs) {
  if (!Array.isArray(refs)) return { text: '', count: 0 };
  let text = '', count = 0;
  for (const r of refs) {
    if (r == null) continue;
    const t = typeof r === 'string' ? r : s(r && r.text);
    if (!t) continue;
    text += t; count++;
  }
  return { text, count };
}

// history (native only) may arrive as a string (already concatenated) or an array of engine-neutral messages
// ({role, content, toolCalls}) / Anthropic content blocks — flatten to the plain text the window will hold. Tool
// results and tool_use inputs are included because they DO consume the window. Never throws on odd shapes.
function historyText(history) {
  if (history == null) return '';
  if (typeof history === 'string') return history;
  if (!Array.isArray(history)) return '';
  let out = '';
  for (const m of history) {
    if (m == null) continue;
    if (typeof m === 'string') { out += m; continue; }
    const c = m.content;
    if (typeof c === 'string') out += c;
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b == null) continue;
        if (typeof b === 'string') { out += b; continue; }
        if (typeof b.text === 'string') out += b.text;
        else if (typeof b.content === 'string') out += b.content;       // tool_result content
        else if (b.input && typeof b.input === 'object') { try { out += JSON.stringify(b.input); } catch {} }   // tool_use args
      }
    }
    if (Array.isArray(m.toolCalls)) for (const tc of m.toolCalls) { if (tc && typeof tc.args === 'string') out += tc.args; }
  }
  return out;
}

function mkCat(key, category, text, trimKey) {
  const bytes = bytesOf(text), chars = charsOf(text);
  return { key, category, bytes, estTokens: estTokens(chars), share: 0, measured: true, biggest: false, trim: TRIMS[trimKey || key] || '' };
}

// attribute(inputs) -> [{ category, key, bytes, estTokens, share, measured, biggest, trim }]
//   systemPrompt : the system/persona prompt (constitution + active persona overlay)
//   memoryFiles  : the always-injected memory files, {name:text} or [{name,text}] (CLI path); [] on native
//   recallBlock  : the memctx recalled-memory block for THIS turn ('' when nothing was recalled)
//   refs         : @-file references, [] when none
//   history      : NATIVE ONLY — the running message history + tool outputs (string or messages[]); omit on CLI
//   engine       : 'native' | 'cli'; defaults to 'native' when history is supplied, else 'cli'
// A category is emitted only for a NON-EMPTY input. On the CLI path a final unmeasured 'CLI-managed (not measured
// here)' row is appended (bytes/estTokens/share = null) so the readout never pretends to see the CLI's own window.
// Shares are over the MEASURED total and (barring rounding) sum to 1. Sorted biggest-measured-first; the CLI
// remainder stays last. Never throws — any bad input yields a safe (possibly empty) array.
function attribute(input) {
  const inp = input && typeof input === 'object' ? input : {};
  const engine = inp.engine === 'native' ? 'native'
    : inp.engine === 'cli' ? 'cli'
    : (inp.history != null ? 'native' : 'cli');

  const cats = [];
  if (charsOf(inp.systemPrompt)) cats.push(mkCat('system', 'System / persona prompt', inp.systemPrompt));
  for (const f of normMemoryFiles(inp.memoryFiles)) {
    if (!charsOf(f.text)) continue;
    cats.push(mkCat('memory:' + f.name, f.name, f.text, 'memory'));
  }
  if (charsOf(inp.recallBlock)) cats.push(mkCat('recall', 'Recalled-memory block', inp.recallBlock));
  const rb = refsBlob(inp.refs);
  if (charsOf(rb.text)) cats.push(mkCat('refs', '@-refs (' + rb.count + ')', rb.text, 'refs'));
  const hist = historyText(inp.history);
  if (charsOf(hist)) cats.push(mkCat('history', 'Running message history + tool outputs', hist, 'history'));

  // measured total + shares (guard divide-by-zero); flag the single biggest measured consumer.
  const totalBytes = cats.reduce((n, c) => n + c.bytes, 0);
  for (const c of cats) c.share = totalBytes > 0 ? c.bytes / totalBytes : 0;
  cats.sort((a, b) => b.bytes - a.bytes);
  if (cats.length) cats[0].biggest = true;

  if (engine !== 'native') {
    // the claude CLI's self-managed running window is the one part Urfael cannot see — name it honestly, never guess.
    cats.push({ key: 'cli', category: CLI_REMAINDER, bytes: null, estTokens: null, share: null, measured: false, biggest: false, trim: TRIMS.cli });
  }
  return cats;
}

// report(inputs) -> { engine, categories, totalBytes, totalEstTokens, note } — attribute() plus the measured totals
// and the estimate disclosure, the shape the daemon endpoint returns and lines() renders. Totals are summed FROM the
// categories so they are consistent-by-construction with the rows.
function report(input) {
  const inp = input && typeof input === 'object' ? input : {};
  const categories = attribute(inp);
  const measured = categories.filter((c) => c.measured);
  const totalBytes = measured.reduce((n, c) => n + c.bytes, 0);
  const totalEstTokens = measured.reduce((n, c) => n + c.estTokens, 0);
  const engine = categories.some((c) => c.key === 'cli') ? 'cli' : 'native';
  return {
    engine, categories, totalBytes, totalEstTokens,
    note: 'token counts are an ESTIMATE (~' + CHARS_PER_TOKEN + ' chars/token), not a billed or exact figure; byte counts are exact'
      + (engine === 'cli' ? '. The claude CLI owns its running window, so that part is not measured here.' : '.'),
  };
}

function humanBytes(n) {
  if (n == null) return '-';
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}
function humanTok(n) { if (n == null) return '-'; const t = Number(n) || 0; return t >= 1000 ? '~' + Math.round(t / 1000) + 'k' : '~' + t; }
function pct(share) { return share == null ? '    -' : (share * 100).toFixed(share < 0.1 ? 1 : 0).padStart(4) + '%'; }
function bar(share, width) { if (share == null) return ''; const w = Math.max(0, Math.round(share * (width || 12))); return '█'.repeat(w); }

// lines(rep, id) -> string[]: a plain, colour-tagged readout shared by `urfael context` and the TUI `/context`.
// id is an identity/colour map { gold, dim, bold }; pass no-op fns for a raw string. Pure; never throws.
function lines(rep, id) {
  const R = rep && typeof rep === 'object' ? rep : { categories: [], totalBytes: 0, totalEstTokens: 0, engine: 'cli', note: '' };
  const gold = (id && id.gold) || ((x) => x), dim = (id && id.dim) || ((x) => x), bold = (id && id.bold) || gold;
  const cats = Array.isArray(R.categories) ? R.categories : [];
  const out = [];
  out.push(bold('Context breakdown') + dim('  ·  engine: ' + (R.engine || 'cli') + '  ·  measured total ' + humanBytes(R.totalBytes) + ' / ' + humanTok(R.totalEstTokens) + ' tok (est)'));
  if (!cats.length) { out.push(dim('  (nothing to attribute yet)')); return out; }
  const nameW = Math.min(38, Math.max(...cats.map((c) => c.category.length)));
  for (const c of cats) {
    const flag = c.biggest ? gold(' ◄ biggest') : '';
    const size = c.measured ? (humanBytes(c.bytes) + ' · ' + humanTok(c.estTokens) + ' tok') : dim('not visible to Urfael');
    out.push('  ' + gold(c.category.slice(0, nameW).padEnd(nameW)) + '  ' + pct(c.share) + ' ' + dim(bar(c.share, 10).padEnd(10)) + '  ' + size + flag);
    if (c.trim) out.push(dim('      trim: ' + c.trim));
  }
  if (R.note) out.push(dim('  ' + R.note));
  return out;
}

module.exports = { attribute, report, lines, CHARS_PER_TOKEN, CLI_REMAINDER, estTokens, humanBytes, humanTok };
