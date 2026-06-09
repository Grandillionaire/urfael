'use strict';
// Detached job runner. Spawns the work in its OWN process group (so it survives the daemon and so cancel
// is a real kill switch), streams output to the job log, and on exit records state + pushes a phone notify.
//   kind 'goal'      -> the guard-railed vault-template/_jarvis/goal-loop.sh (isolated --repo, never pushes)
//   kind 'ask'/'research' -> a sandboxed one-shot claude (no bypass, no computer-use) that writes a vault note
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./jobstore');

const VAULT = path.join(os.homedir(), process.env.JARVIS_VAULT_DIR || 'Jarvis');
const CLAUDE_BIN = process.env.JARVIS_CLAUDE_BIN || ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude']
  .find((p) => { try { fs.accessSync(p); return true; } catch { return false; } }) || 'claude';
const NOTIFY = path.join(__dirname, 'bridge', 'telegram-bridge.js'); // best-effort; a no-op if no bridge.env

// one-way phone push for "job done / needs you". Single-destination by construction (see the bridge).
function notify(text) {
  try { const p = spawn(process.execPath, [NOTIFY, '--notify', text], { detached: true, stdio: 'ignore', env: process.env }); p.unref(); } catch {}
}

function argvFor(job) {
  const s = job.spec || {};
  if (job.kind === 'goal') {
    const args = ['bash', path.join(VAULT, '_jarvis', 'goal-loop.sh'), String(s.goal || '')];
    if (s.repo) args.push('--repo', String(s.repo));
    if (s.maxIters) args.push('--max-iters', String(s.maxIters));
    if (s.maxMins) args.push('--max-mins', String(s.maxMins));
    if (s.turnTimeout) args.push('--turn-timeout', String(s.turnTimeout));
    if (s.check) args.push('--check', String(s.check));
    if (s.model) args.push('--model', String(s.model));
    return args;
  }
  // ask / research: sandboxed one-shot — no bypass, no computer-use, write a result note into the vault.
  const prompt = String(s.prompt || s.goal || '') +
    '\n\nWhen done, write your findings to a logo-headed note in 03_Resources/ of this vault and open it.';
  return [CLAUDE_BIN, '-p', prompt, '--model', String(s.model || 'sonnet'), '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read,Grep,Glob,WebFetch,WebSearch,Write,Edit,Bash(git:*)', '--strict-mcp-config'];
}

function run(job) {
  const id = job.id;
  let fd;
  try { fd = fs.openSync(store.logFile(id), 'a'); } catch { fd = 'ignore'; }
  let proc;
  try {
    const [cmd, ...args] = argvFor(job);
    proc = spawn(cmd, args, { cwd: VAULT, env: { ...process.env, JARVIS_OVERLAY: '1' },
      stdio: ['ignore', fd, fd], detached: true });
  } catch (e) {
    store.update(id, { state: 'error', endedAt: new Date().toISOString(), result: String((e && e.message) || e) });
    if (typeof fd === 'number') try { fs.closeSync(fd); } catch {}
    return null;
  }
  store.update(id, { state: 'running', pid: proc.pid, startedAt: new Date().toISOString() });
  proc.on('exit', (code, signal) => {
    if (typeof fd === 'number') try { fs.closeSync(fd); } catch {}
    const state = signal ? 'cancelled' : (code === 0 ? 'done' : 'failed');
    store.update(id, { state, pid: null, endedAt: new Date().toISOString(), exitCode: code });
    notify('Jarvis job ' + id + ' (' + job.kind + ') ' + state + '.');
  });
  proc.unref();
  return proc.pid;
}

// Cancel = signal the whole process GROUP (detached gives the child its own pgid), TERM then KILL after grace.
function cancel(id) {
  const j = store.get(id);
  if (!j || !j.pid || !store.isAlive(j.pid)) return false;
  store.update(id, { state: 'cancelling' });
  try { process.kill(-j.pid, 'SIGTERM'); } catch { try { process.kill(j.pid, 'SIGTERM'); } catch {} }
  const pid = j.pid;
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} }, 8000);
  return true;
}

module.exports = { run, cancel };
