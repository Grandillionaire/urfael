'use strict';
// Render `urfael why` as a sourced, paste-ready CITATION instead of a raw SHA dump — the trust moat made
// legible. Pure + dependency-free (no git, no daemon): cli.js runs the injection-safe git pickaxe and hands the
// rows here purely to format. Each colour fn is injected, so tests pass identity fns and assert on plain text.

// commit-subject prefix → the human name of the memory pass that authored a belief (subjects look like
// "memory: distilled 3 facts", "user-model: …", "forget: …"). Never throws on a malformed subject.
const PASS = { memory: 'distilled', 'user-model': 'user-model', learn: 'learned', forget: 'forgotten', skills: 'skill-curator', init: 'seeded', review: 'reviewed' };
function passName(subject) {
  const m = /^([a-z-]+):/.exec(String(subject || ''));
  return (m && PASS[m[1]]) || (m && m[1]) || 'memory';
}

// git %ci ("2026-06-10 19:22:16 +0200") → "10 June 2026". A pure reformat of the STORED commit date — it can't
// leak present-time knowledge (it only ever reads the value git already recorded). Falls back to the raw date.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function fullDate(ci) {
  const s = String(ci || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s.slice(0, 10);
  return parseInt(m[3], 10) + ' ' + (MONTHS[parseInt(m[2], 10) - 1] || m[2]) + ' ' + m[1];
}

// rows: [{ sha, ci, subject }] newest-first. style = { gold, dim }. Returns the full card body as one string.
function card(phrase, rows, style) {
  const g = style.gold || ((s) => s), d = style.dim || ((s) => s);
  const out = [g('Why I believe “' + phrase + '”') + d('   ·   ' + rows.length + ' source' + (rows.length === 1 ? '' : 's') + ', newest first'), ''];
  for (const r of rows) {
    out.push('  ' + d('• ') + passName(r.subject) + ' on ' + g(fullDate(r.ci)) + (r.subject ? d('   ' + r.subject) : ''));
    out.push('    ' + d('source ') + g(r.sha) + d('   ·   git show ' + r.sha));
  }
  return out.join('\n');
}

module.exports = { passName, fullDate, card };
