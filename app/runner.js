'use strict';
// Detached job runner. Spawns the work in its OWN process group (so it survives the daemon and so cancel
// is a real kill switch), streams output to the job log, and on exit records state + pushes a phone notify.
//   kind 'goal'      -> the guard-railed vault-template/_urfael/goal-loop.sh (isolated --repo, never pushes)
//   kind 'ask'/'research' -> a sandboxed one-shot claude (no bypass, no computer-use) that writes a vault note
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./jobstore');
const { delegateScope, scopedEnv } = require('./lib');

const VAULT = path.join(os.homedir(), process.env.URFAEL_VAULT_DIR || 'Urfael');
const CLAUDE_BIN = process.env.URFAEL_CLAUDE_BIN || ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude']
  .find((p) => { try { fs.accessSync(p); return true; } catch { return false; } }) || 'claude';
const NOTIFY = path.join(__dirname, 'bridge', 'notify.js'); // best-effort; a no-op if no bridge.env

// one-way phone push for "job done / needs you". Single-destination by construction (see the bridge).
function notify(text) {
  try { const p = spawn(process.execPath, [NOTIFY, text], { detached: true, stdio: 'ignore', env: process.env }); p.unref(); } catch {}
}

// Per-principal re-entry attribution: a background child's output is UNREVIEWED, so every result note + notify carries
// who spawned it, over which channel, at which inherited scope, plus an explicit honesty caveat — a delegated result
// is never presented as owner-verified. Pure string build from the job spec.
function attribution(s) {
  const principal = String((s && s.principal) || 'owner');
  const role = String((s && s.role) || 'owner');
  const channel = String((s && s.channel) || 'local');
  const scope = delegateScope(s && s.scope).scope;             // single-sourced; fail-closed to 'untrusted'
  return { principal, role, channel, scope,
    header: 'Delegated by ' + principal + '/' + role + ' over ' + channel + ', scope=' + scope + '.',
    caveat: 'This ran as a background child under the spawning turn\'s scope; results are unreviewed.' };
}

function argvFor(job) {
  const s = job.spec || {};
  if (job.kind === 'goal') {
    const args = ['bash', path.join(VAULT, '_urfael', 'goal-loop.sh'), String(s.goal || '')];
    if (s.repo) args.push('--repo', String(s.repo));
    if (s.maxIters) args.push('--max-iters', String(s.maxIters));
    if (s.maxMins) args.push('--max-mins', String(s.maxMins));
    if (s.turnTimeout) args.push('--turn-timeout', String(s.turnTimeout));
    if (s.check) args.push('--check', String(s.check));
    if (s.model) args.push('--model', String(s.model));
    // Optional throwaway-container isolation. Whitelist server-side; goal-loop.sh re-validates + needs docker.
    if (s.sandbox === 'docker' || s.sandbox === 'docker-net') args.push('--sandbox', s.sandbox);
    // Optional remote SSH backend: turns run on a remote host. Validate the host server-side against the SAME safe
    // pattern goal-loop.sh enforces ([A-Za-z0-9._@-]+, no leading '-') — a bad/missing host is DROPPED, not passed,
    // so we never splice an attacker-shaped string onto an ssh command line. --ssh-dir is a path, passed verbatim
    // (goal-loop.sh %q-escapes it). Only enable ssh mode when the host validates.
    else if (s.sandbox === 'ssh') {
      const host = String(s.sshHost || '');
      if (/^[A-Za-z0-9._@-]+$/.test(host) && host[0] !== '-') {
        args.push('--sandbox', 'ssh', '--ssh-host', host);
        if (s.sshDir) args.push('--ssh-dir', String(s.sshDir));
      }
      // else: host invalid/missing -> drop ssh entirely; the loop runs on the host (default), never with a bad host.
    }
    return args;
  }
  // ask / research: sandboxed one-shot — no bypass, no computer-use, write a result note into the vault. The toolset
  // is DERIVED from the spawning turn's trust scope (delegateScope), never hardcoded: an untrusted-scoped child is
  // structurally no-egress (Read/Grep/Glob), an owner 'local' job keeps the full floor. The daemon stamps spec.scope
  // ('local' for the owner socket); an absent/garbage scope here fails CLOSED to 'untrusted' (no egress).
  const a = attribution(s);
  const prompt = a.header + '\n' + a.caveat + '\n\n' + String(s.prompt || s.goal || '') +
    '\n\nWhen done, write your findings to a logo-headed note in 03_Resources/ of this vault and open it.';
  const allowed = delegateScope(s.scope).allowedTools.join(',');
  return [CLAUDE_BIN, '-p', prompt, '--model', String(s.model || 'sonnet'), '--permission-mode', 'acceptEdits',
    '--allowedTools', allowed, '--strict-mcp-config']; // scope-derived allowlist, never a shell
}

// The background child crosses the SAME scopedEnv() boundary every other spawn uses (cron, hook, watch, remote,
// askScoped): PATH/HOME + model knobs + the backend routing/access vars, and NOTHING else — so the daemon's
// unrelated secrets (bridge.env, other providers' keys, anything ambient in its environment) never reach an
// UNREVIEWED background job. This was the LONE spawn path still handing the child the full process env. The
// goal-loop's operational selectors (isolation backend + yolo, the documented env-equivalents of its --sandbox
// / --ssh-* / bypass flags) are forwarded so a normal owner-local job behaves identically; nothing else is.
const JOB_ENV_KEYS = ['URFAEL_YOLO', 'URFAEL_SANDBOX', 'URFAEL_SANDBOX_IMAGE', 'URFAEL_SSH_HOST', 'URFAEL_SSH_DIR'];
function jobEnv() { return scopedEnv(process.env, JOB_ENV_KEYS); }

function run(job) {
  const id = job.id;
  let fd;
  try { fd = fs.openSync(store.logFile(id), 'a'); } catch { fd = 'ignore'; }
  let proc;
  try {
    const [cmd, ...args] = argvFor(job);
    proc = spawn(cmd, args, { cwd: VAULT, env: jobEnv(),
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
    const a = attribution(job.spec || {});
    notify('Urfael job ' + id + ' (' + job.kind + ') ' + state + '. ' + a.header + ' ' + a.caveat);
  });
  proc.unref();
  return proc.pid;
}

// Cancel = signal the whole process GROUP (detached gives the child its own pgid), TERM then KILL after grace.
function cancel(id) {
  const j = store.get(id);
  if (!j || !j.pid || !store.isAlive(j.pid)) return false;
  store.update(id, { state: 'cancelling' });
  const pid = j.pid;
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
  // re-check liveness before the hard kill so a reaped+reused pid isn't signalled by mistake
  setTimeout(() => { if (store.isAlive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch {} } }, 8000);
  return true;
}

module.exports = { run, cancel, argvFor, attribution, jobEnv };
