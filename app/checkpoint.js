'use strict';
// app/checkpoint.js — PURE logic for repo checkpoints (the safety net under `urfael code`). A checkpoint is a snapshot
// of the working tree (tracked + untracked, the set `git add -A` stages; gitignored files are left out) stored as a
// commit on a private shadow ref, refs/urfael/checkpoints/<id>, made via a TEMP index so it never touches your branch,
// index, or working tree. Rewind restores your files to a snapshot, after first checkpointing the current state, so a
// rewind is itself undoable and never silently loses work.
// This module owns the ids, refs, commit-message encoding, and list parsing (all unit-tested); cli.js runs the git.

const crypto = require('crypto');

const REF_PREFIX = 'refs/urfael/checkpoints/';
const ref = (id) => REF_PREFIX + String(id || '').replace(/[^a-zA-Z0-9-]/g, '');   // alnum + hyphen only (git-ref safe; no `..`, no injection)

// newId(now, rand) -> a short, unique id that sorts by creation time at MILLISECOND precision (base36 ms + 4 hex).
// Millisecond precision matters: git commit dates are second-resolution, so two checkpoints made in the same second
// tie on creatordate; the id is the deterministic tiebreaker parseList falls back to, and only ms makes that correct.
// now/rand are injectable for tests. (base36(ms) is fixed-width from 1972 to 2059, so it is lexically time-sortable.)
function newId(now, rand) {
  const t = Number.isFinite(now) ? now : Date.now();
  const r = (rand != null ? String(rand) : crypto.randomBytes(2).toString('hex')).replace(/[^a-f0-9]/gi, '').slice(0, 4).padEnd(4, '0');
  return Math.floor(t).toString(36) + '-' + r;
}

// the commit subject encodes the id + a one-line task, so a single `git for-each-ref` recovers everything for a list.
function msgFor(id, task) { return 'urfael-cp ' + String(id || '') + ' :: ' + String(task == null ? '' : task).replace(/\s+/g, ' ').trim().slice(0, 200); }
function parseMsg(subject) { const m = String(subject == null ? '' : subject).match(/^urfael-cp (\S+) :: (.*)$/); return m ? { id: m[1], task: m[2] } : null; }

// the for-each-ref format the CLI uses, and the parser for its output (one checkpoint per line: date<TAB>subject).
const LIST_FORMAT = '%(creatordate:iso-strict)%09%(objectname:short)%09%(subject)';
function parseList(out) {
  const rows = [];
  for (const line of String(out == null ? '' : out).split('\n')) {
    if (!line.trim()) continue;
    const [date, sha, ...rest] = line.split('\t');
    const pm = parseMsg(rest.join('\t'));
    if (pm) rows.push({ id: pm.id, task: pm.task, sha: (sha || '').trim(), date: (date || '').trim() });
  }
  // newest first. creatordate is authoritative across seconds; within the same second (git's resolution) it ties, so
  // break the tie by id, which carries millisecond precision, keeping the order deterministic and truly newest-first.
  return rows.sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

module.exports = { REF_PREFIX, ref, newId, msgFor, parseMsg, LIST_FORMAT, parseList };
