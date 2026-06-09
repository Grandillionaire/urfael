'use strict';
// Tiny durable job store — one JSON file + one .log per job under ~/.claude/jarvis/jobs/. No DB.
// Jobs outlive the daemon (they run detached), so state is reconciled on daemon start.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const JOBS_DIR = path.join(os.homedir(), '.claude', 'jarvis', 'jobs');
const ID_RE = /^[a-z0-9-]{4,64}$/i; // opaque ids only — never interpolate an unvalidated id into a path/shell

function ensure() { try { fs.mkdirSync(JOBS_DIR, { recursive: true }); } catch {} }
function safeId(id) { return typeof id === 'string' && ID_RE.test(id); }
function jobFile(id) { return path.join(JOBS_DIR, id + '.json'); }
function logFile(id) { return path.join(JOBS_DIR, id + '.log'); }
function newId() { return Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex'); }
function isAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }

function create(spec) {
  ensure();
  const id = newId();
  const job = { id, kind: spec.kind, state: 'queued', spec, pid: null,
    createdAt: new Date().toISOString(), startedAt: null, endedAt: null, exitCode: null, result: null };
  fs.writeFileSync(jobFile(id), JSON.stringify(job, null, 2));
  return job;
}
function get(id) { if (!safeId(id)) return null; try { return JSON.parse(fs.readFileSync(jobFile(id), 'utf8')); } catch { return null; } }
function update(id, patch) { const j = get(id); if (!j) return null; Object.assign(j, patch); try { fs.writeFileSync(jobFile(id), JSON.stringify(j, null, 2)); } catch {} return j; }
function list() {
  ensure();
  try {
    return fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  } catch { return []; }
}
function appendLog(id, line) { if (!safeId(id)) return; try { fs.appendFileSync(logFile(id), line.endsWith('\n') ? line : line + '\n'); } catch {} }
function tailLog(id, n = 40) { if (!safeId(id)) return ''; try { return fs.readFileSync(logFile(id), 'utf8').trim().split('\n').slice(-n).join('\n'); } catch { return ''; } }

// On daemon start: a job marked 'running' whose process is gone (daemon restarted under it, or it crashed)
// is reconciled to 'interrupted'. Live jobs are left running — they are durable by design.
function reconcile() {
  for (const j of list()) if (j.state === 'running' && !isAlive(j.pid)) update(j.id, { state: 'interrupted', endedAt: new Date().toISOString() });
}

module.exports = { create, get, update, list, appendLog, tailLog, reconcile, isAlive, safeId, logFile, JOBS_DIR };
