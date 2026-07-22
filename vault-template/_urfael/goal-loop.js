'use strict';
// goal-loop.js — the native-Windows twin of goal-loop.sh: the same guardrailed autonomous coding loop,
// line-for-line in Node so it needs no bash, no `timeout` binary, and no POSIX shell. The runner picks THIS
// file on win32 and the shipped .sh everywhere else, with the SAME flags — see app/runner.js.
//
// SAFETY (identical bars to the .sh):
//   • requires a git repo (so you can `git reset --hard`)  • caps iterations AND wall-clock time
//   • a JS watchdog kills a hung turn (the .sh needs coreutils `timeout`; here WE are the watchdog)
//   • no-progress circuit breaker (git state unchanged N turns → abort)
//   • needs a real completion signal (URFAEL-GOAL-DONE marker + optional --check command)
//   • prints everything; logs to .urfael-goal.log; never auto-merges, never auto-pushes
//   • --verify + --criteria: the same fail-closed independent-refuter gate, via the same goal-verify.js
//
// v1 SCOPE (stated, fail-closed): --sandbox docker/docker-net/ssh are NOT supported in this twin — they
// need a POSIX host anyway (bind-mounted sockets, %q remote quoting). A sandbox flag here aborts with a
// clear message instead of quietly running unsandboxed. --check runs via PowerShell on Windows (it is the
// owner's own command, exactly as the .sh hands it to bash).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const MARKER = 'URFAEL-GOAL-DONE';
const STALE_LIMIT = 3;

function usage() {
  return 'Usage: goal-loop.js "<goal>" [--repo DIR] [--max-iters N] [--max-mins M] [--turn-timeout S] [--check "cmd"] [--model NAME] [--verify] [--criteria FILE]';
}

// parseArgs(argv, env) → options object or { error }. Pure; mirrors the .sh flag-for-flag (sandbox flags are
// recognized so the runner's argv contract holds, then rejected in main() with an honest message).
function parseArgs(argv, env) {
  const e = env || {};
  const o = { goal: '', repo: '', maxIters: 15, maxMins: 120, turnTimeout: 900, check: '', model: 'sonnet',
    sandbox: String(e.URFAEL_SANDBOX || ''), sshHost: String(e.URFAEL_SSH_HOST || ''), sshDir: String(e.URFAEL_SSH_DIR || ''),
    verify: e.URFAEL_GOAL_VERIFY === '1', criteria: String(e.URFAEL_GOAL_CRITERIA || '') };
  const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') o.repo = String(argv[++i] || '');
    else if (a === '--max-iters') o.maxIters = num(argv[++i], o.maxIters);
    else if (a === '--max-mins') o.maxMins = num(argv[++i], o.maxMins);
    else if (a === '--turn-timeout') o.turnTimeout = num(argv[++i], o.turnTimeout);
    else if (a === '--check') o.check = String(argv[++i] || '');
    else if (a === '--model') o.model = String(argv[++i] || 'sonnet');
    else if (a === '--sandbox') o.sandbox = String(argv[++i] || '');
    else if (a === '--ssh-host') o.sshHost = String(argv[++i] || '');
    else if (a === '--ssh-dir') o.sshDir = String(argv[++i] || '');
    else if (a === '--verify') o.verify = true;
    else if (a === '--criteria') o.criteria = String(argv[++i] || '');
    else if (a === '-h' || a === '--help') o.help = true;
    else if (!o.goal) o.goal = String(a);
    else return { error: 'unknown arg: ' + a };
  }
  return o;
}

// The exact prompt the .sh builds (byte-identical text, so worker behavior can't drift between OSes).
function buildPrompt(goal, check) {
  return 'Work toward this goal in this repo: ' + goal + '\n' +
    'Make concrete, committed progress this turn. When the goal is fully achieved and verified' +
    (check ? " (so '" + check + "' passes)" : '') +
    ', end your reply with a line containing only: ' + MARKER + '. If you are blocked or it is unsafe to proceed, explain why and stop.';
}

// Where the Urfael app lives (for goal-verify.js / ledger-log.js / notify.js) — same lookup as the .sh.
function appDir() {
  try { return path.join(String(fs.readFileSync(path.join(os.homedir(), '.claude', 'urfael', 'repo'), 'utf8')).trim(), 'app'); }
  catch { return path.join(os.homedir(), 'urfael-src', 'app'); }
}

function gitState(repo) {
  const run = (args) => { try { return execFileSync('git', ['-C', repo].concat(args), { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString(); } catch { return ''; } };
  const head = run(['rev-parse', 'HEAD']).trim();
  const porcelain = run(['status', '--porcelain']);
  return head + crypto.createHash('sha1').update(porcelain).digest('hex');
}

// One bounded child run: resolves { rc, out, timedOut }. rc 124 on timeout (the .sh's `timeout` convention,
// so the loop's error handling stays identical). Kill: taskkill /T on win32, SIGKILL elsewhere.
function boundedRun(cmd, args, opts, timeoutSec, stdinText) {
  return new Promise((resolve) => {
    let out = '', done = false, timedOut = false;
    let p;
    try { p = spawn(cmd, args, { ...opts, windowsHide: true }); }
    catch (e) { return resolve({ rc: 127, out: String((e && e.message) || e), timedOut: false }); }
    const finish = (rc) => { if (done) return; done = true; resolve({ rc: timedOut ? 124 : rc, out, timedOut }); };
    const killTree = () => {
      timedOut = true;
      if (process.platform === 'win32') { try { require('child_process').execFile('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch {} }
      try { p.kill('SIGKILL'); } catch {}
    };
    const timer = setTimeout(killTree, timeoutSec * 1000);
    if (p.stdout) p.stdout.on('data', (d) => { out += d; });
    if (p.stderr && opts && opts.errTo) p.stderr.on('data', (d) => { try { fs.appendFileSync(opts.errTo, d); } catch {} });
    p.on('exit', (code) => { clearTimeout(timer); finish(code == null ? 1 : code); });
    p.on('error', (e) => { clearTimeout(timer); out += String((e && e.message) || e); finish(127); });
    if (stdinText != null && p.stdin) { try { p.stdin.write(stdinText); p.stdin.end(); } catch {} }
  });
}

async function main(argv) {
  const o = parseArgs(argv, process.env);
  const say = (s) => process.stdout.write(s + '\n');
  if (o.error) { say(o.error); say(usage()); return 1; }
  if (o.help) { say(usage()); return 0; }
  if (!o.goal) { say('✗ no goal given.'); say(usage()); return 1; }
  if (!o.repo) { say('✗ no --repo given. Point this at an ISOLATED git worktree/container, not your live checkout.'); say(usage()); return 1; }
  if (!fs.existsSync(path.join(o.repo, '.git'))) { say('✗ ' + o.repo + ' is not a git repo (need one so you can reset). Aborting.'); return 1; }
  if (o.sandbox) { say('✗ --sandbox ' + o.sandbox + ' is not supported by the native-Windows goal loop (v1) — run host mode here, or use WSL for docker/ssh sandboxes. Aborting rather than silently running unsandboxed.'); return 1; }
  if (o.verify) {
    if (!o.criteria) { say('✗ --verify requires --criteria <file> (env URFAEL_GOAL_CRITERIA): the machine-checkable completion bar must be stated up front. Aborting.'); return 1; }
    if (!fs.existsSync(o.criteria)) { say('✗ --criteria file not found: ' + o.criteria + '. Aborting.'); return 1; }
  }
  // the same resolver the daemon uses (claude.exe / npm cli.js / bare fallback) — never a shell
  const CB = require(path.join(appDir(), 'claude-bin')).resolve();
  const claudeArgv = (args) => [CB.bin, CB.pre.concat(args)];
  const APP = appDir();
  const LOG = path.join(o.repo, '.urfael-goal.log');
  try { fs.writeFileSync(LOG, ''); } catch {}
  const logAppend = (s) => { try { fs.appendFileSync(LOG, s); } catch {} };

  const PERM = process.env.URFAEL_YOLO ? 'bypassPermissions' : 'acceptEdits';
  say('── Urfael goal-loop ──────────────────────────────────');
  say('  goal:       ' + o.goal);
  say('  repo:       ' + o.repo);
  say('  caps:       ' + o.maxIters + ' iters · ' + o.maxMins + 'm wall · ' + o.turnTimeout + 's/turn · stop after ' + STALE_LIMIT + ' stale');
  say('  completion: GOAL_COMPLETE marker' + (o.check ? ' + check: ' + o.check : ''));
  say('  model:      ' + o.model + '   (perm mode: ' + PERM + ' — supervise; isolated worktree/container)');
  say('  sandbox:    host (no container) — native Windows twin');
  say('──────────────────────────────────────────────────────');
  if (o.verify) say('  verify:     ON (experimental) — a candidate-done is adjudicated by a fresh INDEPENDENT read-only refuter against ' + o.criteria);

  const START = Date.now();
  const DIFF_SENTINEL = '-----URFAEL-DIFF-STAT-----';
  let goalId = '', critDigest = '';
  const nodeRun = (script, args, stdinText) => boundedRun(process.execPath, [script].concat(args), { cwd: o.repo, errTo: LOG }, 120, stdinText);
  const ledger = async (obj) => { try { await nodeRun(path.join(APP, 'bridge', 'ledger-log.js'), [JSON.stringify(obj)]); } catch {} };
  if (o.verify) {
    goalId = 'goal_' + Math.floor(START / 1000) + '_' + process.pid;
    critDigest = (await nodeRun(path.join(APP, 'goal-verify.js'), ['digest', '--criteria', o.criteria])).out.trim();
    const caps = o.maxIters + ' iters, ' + o.maxMins + 'm, ' + o.turnTimeout + 's/turn, stop after ' + STALE_LIMIT + ' stale';
    let crit = ''; try { crit = fs.readFileSync(o.criteria, 'utf8'); } catch {}
    await ledger({ ev: 'goal_contract', goalId, goal: o.goal.slice(0, 2000), criteria: crit.slice(0, 8000), criteriaDigest: critDigest, check: o.check.slice(0, 1000), caps });
  }

  // --check runs where the work lands, via the OWNER's shell for their OWN command (bash on POSIX in the .sh;
  // PowerShell here — same trust statement: the check text is authored by the person who owns the machine).
  const runCheck = async () => {
    const r = process.platform === 'win32'
      ? await boundedRun('powershell.exe', ['-NoProfile', '-Command', o.check], { cwd: o.repo, errTo: LOG }, o.turnTimeout)
      : await boundedRun('bash', ['-c', o.check], { cwd: o.repo, errTo: LOG }, o.turnTimeout);
    logAppend(r.out);
    return r.rc === 0;
  };
  if (!o.verify && o.check && (await runCheck())) { say('✅ goal already satisfied (verify passes).'); return 0; }

  let prev = '', stale = 0, errs = 0, sid = '', doneFlag = false, refutation = '', i = 0;
  for (i = 1; i <= o.maxIters; i++) {
    const mins = Math.floor((Date.now() - START) / 60000);
    if (mins >= o.maxMins) { say('⏰ wall-clock cap (' + o.maxMins + 'm) hit. Stopping.'); break; }
    say('── iteration ' + i + '/' + o.maxIters + ' · ' + mins + 'm elapsed ──');
    let prompt = buildPrompt(o.goal, o.check);
    if (o.verify) {
      const c = await nodeRun(path.join(APP, 'goal-verify.js'), ['contract', '--goal', o.goal, '--criteria', o.criteria]);
      prompt = c.out + '\n\n' + prompt;
      if (refutation) prompt += '\n\nNOTE: a prior INDEPENDENT read-only review REFUTED completion; unmet: ' + refutation + '; fix these, do not claim done.';
    }
    const flags = ['--model', o.model, '--permission-mode', PERM, '--output-format', 'json'];
    if (sid) flags.push('--resume', sid);   // pin OUR session so a stray claude in this dir can't be hijacked
    const [tc, ta] = claudeArgv(['-p', prompt].concat(flags));
    const r = await boundedRun(tc, ta, { cwd: o.repo, errTo: LOG }, o.turnTimeout);
    if (r.rc === 124) { say('⏰ turn ' + i + ' exceeded ' + o.turnTimeout + 's — killed. Continuing.'); errs = 0; }
    else if (r.rc !== 0) {
      errs += 1; say('⚠️ claude exited ' + r.rc + ' (error ' + errs + '/2).');
      if (errs >= 2) { say('🛑 claude failing repeatedly — stopping (check ' + LOG + ': API key / quota / crash).'); break; }
      continue;
    } else errs = 0;

    let parsed = {}; try { parsed = JSON.parse(r.out); } catch {}
    const text = String(parsed.result || '');
    if (!sid) sid = String(parsed.session_id || '');
    logAppend('\n===== iter ' + i + ' =====\n' + text + '\n');
    const lines = text.split('\n').filter((l) => l.trim());
    for (const l of lines.slice(-4)) say(l);

    if (o.verify) {
      let candidate = false, checkPassed = false;
      if (o.check) { if (await runCheck()) { candidate = true; checkPassed = true; } }
      else if ((lines[lines.length - 1] || '') === MARKER) candidate = true;
      if (candidate) {
        let verdict = 'error', reason = 'not independently verified';
        const diffStat = (() => { try { return execFileSync('git', ['-C', o.repo, 'diff', '--stat'], { windowsHide: true }).toString(); } catch { return ''; } })();
        const vp = await nodeRun(path.join(APP, 'goal-verify.js'), ['prompt', '--goal', o.goal, '--criteria', o.criteria], text + '\n' + DIFF_SENTINEL + '\n' + diffStat);
        say('🔎 candidate-done — spawning an INDEPENDENT read-only refuter (fresh session, Read/Grep/Glob only)…');
        const vflags = ['--permission-mode', 'acceptEdits', '--strict-mcp-config', '--allowedTools', 'Read,Grep,Glob', '--output-format', 'json', '--model', o.model];
        const [vc, va] = claudeArgv(['-p', vp.out].concat(vflags));
        const vr = await boundedRun(vc, va, { cwd: o.repo, errTo: LOG }, o.turnTimeout);
        if (vr.rc !== 0) { verdict = 'error'; reason = 'verifier spawn failed/timeout (rc=' + vr.rc + ') — fail-closed, not independently verified'; }
        else {
          const pr = await nodeRun(path.join(APP, 'goal-verify.js'), ['parse', '--criteria', o.criteria], vr.out);
          const tab = pr.out.indexOf('\t');
          if (pr.out.slice(0, tab < 0 ? undefined : tab).trim() === 'PASS') { verdict = 'pass'; reason = 'independently verified'; }
          else { verdict = 'refute'; reason = tab < 0 ? pr.out.trim() : pr.out.slice(tab + 1).trim(); }
        }
        await ledger({ ev: 'goal_verify', goalId, iter: i, verdict, reason: reason.slice(0, 480), criteriaDigest: critDigest, checkPassed });
        if (verdict === 'pass') { say('✅ independent read-only verifier could NOT refute completion — falling through to done.'); refutation = ''; }
        else {
          refutation = reason;
          say('↩︎ NOT independently verified (verdict=' + verdict + '): ' + reason + ' — feeding it back, continuing.');
          const st = gitState(o.repo); if (st === prev) stale += 1; else stale = 0; prev = st;
          if (stale >= STALE_LIMIT) { say('🛑 no git progress for ' + STALE_LIMIT + ' turns — circuit breaker. Stopping.'); break; }
          continue;
        }
      }
    }

    // Completion: the verify command is the source of truth; the marker only counts (as last line) if no check given.
    if (o.check) { if (await runCheck()) { say('✅ verify command passes — done.'); doneFlag = true; break; } }
    else if ((lines[lines.length - 1] || '') === MARKER) { say('✅ completion marker (no verify command given).'); doneFlag = true; break; }

    const st = gitState(o.repo);
    if (st === prev) stale += 1; else stale = 0;
    prev = st;
    if (stale >= STALE_LIMIT) { say('🛑 no git progress for ' + STALE_LIMIT + ' turns — circuit breaker. Stopping.'); break; }
  }

  say('──────────────────────────────────────────────────────');
  let outcome;
  if (doneFlag) { say('Result: COMPLETED after ' + i + ' iters. Review:  git -C "' + o.repo + '" diff'); outcome = 'completed ✅'; }
  else { say('Result: STOPPED (not confirmed complete) after ' + i + ' iters. Review ' + LOG + ' and:  git -C "' + o.repo + '" diff'); outcome = 'stopped (needs you) ⚠️'; }
  if (o.verify) say(doneFlag
    ? '  ↳ independently verified: a fresh read-only refuter could not refute completion against the stated criteria.'
    : '  ↳ stopped, not independently verified: the adversarial refuter never passed within the caps.');
  say("Nothing was pushed or merged — that's yours to do.");
  const notify = path.join(APP, 'bridge', 'notify.js');
  if (fs.existsSync(notify)) { try { await nodeRun(notify, ['Goal ' + outcome + ' after ' + i + ' iters: ' + o.goal]); } catch {} }
  return doneFlag ? 0 : 0;
}

module.exports = { parseArgs, buildPrompt, usage, gitState, MARKER, STALE_LIMIT };
if (require.main === module) { main(process.argv.slice(2)).then((c) => process.exit(c)); }
