'use strict';
// app/project.js — per-repo identity + memory for `urfael code`. Claude Code forgets each repo between sessions;
// this gives Urfael a stable per-repo memory (conventions, decisions, gotchas, a history of what changed) kept under
// the private memory repo and auto-loaded when the brain works in that repo. PURE: path + content logic only, no I/O.

const path = require('path');
const crypto = require('crypto');

function slug(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'repo'; }

// idFor(repoPath, remoteUrl) -> a stable, filesystem-safe project id. Prefer the git remote (so the same repo cloned
// to two paths shares one memory); else the directory name plus a short hash of the absolute path (so two repos with
// the same basename never collide).
function idFor(repoPath, remoteUrl) {
  if (remoteUrl) {
    const m = String(remoteUrl).replace(/\.git$/i, '').match(/[:/]([^/:]+)\/([^/:]+)$/);   // owner/repo
    if (m) return slug(m[1] + '-' + m[2]);
  }
  const rp = String(repoPath || '');
  const h = crypto.createHash('sha1').update(rp).digest('hex').slice(0, 6);
  return slug(path.basename(rp)) + '-' + h;
}

function memDir(memoryRoot, id) { return path.join(String(memoryRoot || ''), 'projects', slug(id)); }

const CONVENTIONS = 'CONVENTIONS.md', HISTORY = 'HISTORY.md';

// the seed CONVENTIONS.md for a repo the first time `urfael code` runs there. The user edits it; it is the memory.
function conventionsTemplate(id) {
  return '# Conventions for ' + id + '\n\n'
    + 'What Urfael should remember about this repo. Edit freely; it is loaded as context every time `urfael code` runs here.\n\n'
    + '## Stack and layout\n\n- \n\n## Conventions\n\n- \n\n## Gotchas (what broke before)\n\n- \n';
}

// one appended HISTORY.md entry per coding turn: when, the checkpoint to rewind to, and the task.
function historyEntry(task, summary, checkpointId, isoDate) {
  const when = String(isoDate || '').slice(0, 16).replace('T', ' ');
  let out = '\n## ' + when + (checkpointId ? '  (rewind: `urfael rewind ' + checkpointId + '`)' : '') + '\n\n';
  out += '**Task:** ' + String(task == null ? '' : task).replace(/\s+/g, ' ').trim().slice(0, 300) + '\n';
  const s = String(summary == null ? '' : summary).replace(/\s+/g, ' ').trim();
  if (s) out += '\n' + s.slice(0, 600) + '\n';
  return out;
}

// the context block injected before the task so the brain picks up the repo's conventions (never the full history).
function contextBlock(conventionsText) {
  const c = String(conventionsText == null ? '' : conventionsText).trim();
  if (!c) return '';
  return '[PROJECT MEMORY for this repo, what you learned working here before. Apply it; it is not a task.]\n'
    + c.slice(0, 4000) + '\n[END PROJECT MEMORY]';
}

module.exports = { slug, idFor, memDir, conventionsTemplate, historyEntry, contextBlock, CONVENTIONS, HISTORY };
