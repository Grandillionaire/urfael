'use strict';
// Generates docs/llms.txt (a curated, machine-readable index of the manual, per the llms.txt convention) and
// docs/llms-full.txt (every manual page concatenated) from docs/manual/_sidebar.md, so both stay in step with the
// site. Run: `node docs/manual/reference/generate-llms.js`. No deps.
const fs = require('fs');
const path = require('path');

const MANUAL = path.join(__dirname, '..');
const DOCS = path.join(MANUAL, '..');
const RAW = 'https://raw.githubusercontent.com/Grandillionaire/urfael/main/docs/manual/';
const SITE = 'https://urfael.vercel.app/manual/#/';

// parse the sidebar into sections of { title, links: [{title, file}] }
const sidebar = fs.readFileSync(path.join(MANUAL, '_sidebar.md'), 'utf8').split('\n');
const sections = [];
let cur = null;
for (const line of sidebar) {
  const sec = line.match(/^- (.+)$/);                       // top-level bullet, no link → a section heading
  const lnk = line.match(/^\s+- \[([^\]]+)\]\(([^)]+)\)/);  // indented link → a page
  if (lnk) { if (cur) cur.links.push({ title: lnk[1], file: lnk[2] }); }
  else if (sec && !/\[/.test(sec[1])) { cur = { title: sec[1].trim(), links: [] }; sections.push(cur); }
}

// first real paragraph of a page (after the H1) → its one-line description
function describe(file) {
  const p = path.join(MANUAL, file === '/' ? 'README.md' : file);
  let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch { return ''; }
  const lines = txt.split('\n');
  let seenH1 = false;
  for (const ln of lines) {
    const t = ln.trim();
    if (!seenH1) { if (t.startsWith('# ')) seenH1 = true; continue; }
    if (!t || t.startsWith('#') || t.startsWith('>') || t.startsWith('|') || t.startsWith('-') || t.startsWith('```')) continue;
    return t.replace(/\*\*/g, '').replace(/`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').slice(0, 160);
  }
  return '';
}

// ── llms.txt: the curated index ──
const idx = [];
idx.push('# Urfael');
idx.push('');
idx.push('> A personal, voice-capable AI you run on your own machine, on the flat-rate Claude subscription you already pay for. No inbound network port, no per-token meter. Security-first: the brain listens only on a 0600 unix socket, remote messages are allowlisted before the brain and sandboxed read-only, and the security-critical paths ship with adversarial regression tests.');
idx.push('');
idx.push('This is the documentation index. The human-readable manual is at ' + SITE + '. Each link below is the raw markdown.');
idx.push('');
for (const s of sections) {
  idx.push('## ' + s.title);
  for (const l of s.links) {
    const url = RAW + (l.file === '/' ? 'README.md' : l.file);
    const d = describe(l.file);
    idx.push('- [' + l.title + '](' + url + ')' + (d ? ': ' + d : ''));
  }
  idx.push('');
}
fs.writeFileSync(path.join(DOCS, 'llms.txt'), idx.join('\n'));

// ── llms-full.txt: every page, concatenated ──
const full = [];
full.push('# Urfael — full documentation');
full.push('');
full.push('Every page of the Urfael manual, concatenated for machine reading. Source: https://github.com/Grandillionaire/urfael');
full.push('');
const order = [];
for (const s of sections) for (const l of s.links) order.push(l.file === '/' ? 'README.md' : l.file);
for (const f of order) {
  let txt; try { txt = fs.readFileSync(path.join(MANUAL, f), 'utf8'); } catch { continue; }
  full.push('\n\n' + '='.repeat(80) + '\n# FILE: docs/manual/' + f + '\n' + '='.repeat(80) + '\n');
  full.push(txt.replace(/^<!--[\s\S]*?-->\n?/, '').trim());
}
fs.writeFileSync(path.join(DOCS, 'llms-full.txt'), full.join('\n') + '\n');

process.stdout.write('wrote docs/llms.txt (' + sections.reduce((n, s) => n + s.links.length, 0) + ' entries) and docs/llms-full.txt (' + order.length + ' pages)\n');
