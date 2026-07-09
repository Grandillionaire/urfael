'use strict';
// Static + stubbed-spawn tests over vault-template/_urfael/goal-loop.sh for the OPT-IN --verify gate. Proves:
//   • default byte-identical (flag-off worker prompt == baseline; the two candidate-done blocks are byte-unchanged);
//   • --verify without --criteria fails closed (non-zero exit);
//   • two-key ordering (a RED --check never spawns the verifier);
//   • exit-only-on-pass + feedback (refute → continue with the refutation fed into the next prompt; pass → DONE).
// The stub replaces `claude` + `timeout` with tiny fakes on PATH so one loop runs offline in milliseconds; the
// verifier verdict is driven by FAKE_VERDICT so the control flow is deterministic.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');            // the worktree root (holds app/, vault-template/)
const GOAL_LOOP = path.join(REPO_ROOT, 'vault-template', '_urfael', 'goal-loop.sh');
const SRC = fs.readFileSync(GOAL_LOOP, 'utf8');

// ── STATIC: the two existing candidate-done blocks are byte-for-byte intact ───────────────────────────────
test('the existing --check and marker candidate-done blocks are byte-for-byte unchanged', () => {
  // These are the two blocks that set `DONE=1; break`; the verify interception is a guarded PRE-step, never an
  // edit to these. If a careless change touches them, the default path is no longer byte-identical — fail loudly.
  const checkBlock = 'if run_check; then echo "✅ verify command passes — done."; DONE=1; break; fi';
  const markerBlock = '[ "$last" = "$MARKER" ] && { echo "✅ completion marker (no verify command given)."; DONE=1; break; }';
  assert.ok(SRC.includes(checkBlock), 'the --check candidate-done line must be unchanged');
  assert.ok(SRC.includes(markerBlock), 'the marker candidate-done line must be unchanged');
});

test('the pre-flight already-satisfied early-exit is suppressed under --verify (carries the [ -z "$VERIFY" ] guard)', () => {
  assert.match(SRC, /if \[ -z "\$VERIFY" \] && \[ -n "\$CHECK" \] && run_check; then echo "✅ goal already satisfied/);
});

test('the verifier spawn is the read-only floor with NO --resume / bypass (grep-gated, mirrors goal-verify.js)', () => {
  // the VFLAGS line grants only Read/Grep/Glob and never resumes a session or escalates permissions
  assert.match(SRC, /VFLAGS=\(--permission-mode acceptEdits --strict-mcp-config --allowedTools Read,Grep,Glob --output-format json --model "\$MODEL"\)/);
  const vflagsLine = SRC.split('\n').find((l) => l.includes('VFLAGS=('));
  assert.ok(vflagsLine && !/--resume|bypassPermissions|dangerously-skip/.test(vflagsLine), 'verifier flags carry no resume/bypass');
});

test('every verify-specific helper call sits inside a `[ -n "$VERIFY" ]` guarded region (default path untouched)', () => {
  // Walk the script tracking `[ -n "$VERIFY" ]` ... matching `fi` depth. Assert the verify-only tokens only ever
  // appear while inside such a guard (the pre-flight uses the `[ -z "$VERIFY" ]` twin, also a verify guard).
  const TOKENS = ['goal-verify.js', 'ledger-log.js', 'VPROMPT', 'CONTRACT_TEXT', 'REFUTATION=', 'CRIT_DIGEST', 'goal_contract', 'goal_verify'];
  const lines = SRC.split('\n');
  let depth = 0;              // how many `[ -n "$VERIFY" ]` if-blocks we are currently inside
  const stack = [];          // per-`if` : was it a VERIFY-guard?
  for (const raw of lines) {
    const line = raw.trim();
    const isIf = /^if .*; then$|^if .*$/.test(line) && /^if\b/.test(line);
    if (/^if\b/.test(line)) {
      const isVerifyGuard = /\[ -n "\$VERIFY" \]/.test(line) || /\[ -z "\$VERIFY" \]/.test(line);
      stack.push(isVerifyGuard);
      if (isVerifyGuard) depth++;
    }
    // the tokens must only appear when depth>0, OR on a line that is itself the guard, OR in the arg-parse defaults.
    // Strip inline comments first (a comment MENTIONING a helper is not an ungated ACTION — those have no ` #`).
    const code = line.replace(/\s#.*$/, '');
    if (depth === 0) {
      for (const t of TOKENS) {
        if (code.includes(t)) {
          // allowed exceptions: a comment, or a pure variable-INITIALIZATION line at the top (empty defaults are
          // harmless in the default path). A real ungated verify ACTION (a node call / prompt build) is the failure
          // we hunt — and those all start with `node`/a substitution, never a bare `VAR=` init.
          const benign = /^#/.test(line) || /^(GOAL_ID|CRIT_DIGEST|VERIFY_UNVERIFIABLE|CRITERIA|REFUTATION)=/.test(line);
          assert.ok(benign, 'verify token "' + t + '" appears OUTSIDE a [ -n "$VERIFY" ] guard: ' + line);
        }
      }
    }
    if (line === 'fi' || /; fi$/.test(line)) {
      const wasVerify = stack.pop();
      if (wasVerify && depth > 0) depth--;
    }
  }
});

// ── FUNCTIONAL harness ────────────────────────────────────────────────────────────────────────────────────
function makeStub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-goalloop-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const claudeLog = path.join(dir, 'claude-prompts.log');
  // fake `timeout`: drop `-k <n>` and the duration, exec the rest.
  fs.writeFileSync(path.join(bin, 'timeout'),
    '#!/usr/bin/env bash\nwhile [ "$1" = "-k" ]; do shift 2; done\nshift\nexec "$@"\n', { mode: 0o755 });
  // fake `claude`: capture the -p prompt; a verifier turn (its prompt says "Independent completion review") returns
  // a verdict driven by FAKE_VERDICT; a worker turn claims done with the marker.
  fs.writeFileSync(path.join(bin, 'claude'),
    '#!/usr/bin/env bash\n' +
    'prompt=""; args=("$@")\n' +
    'for ((k=0;k<${#args[@]};k++)); do [ "${args[$k]}" = "-p" ] && prompt="${args[$((k+1))]}"; done\n' +
    'printf "===PROMPT===\\n%s\\n" "$prompt" >> "' + claudeLog + '"\n' +
    'if printf "%s" "$prompt" | grep -q "Independent completion review"; then\n' +
    '  if [ "${FAKE_VERDICT:-pass}" = "pass" ]; then\n' +
    '    printf "%s" \'{"result":"{\\"verdict\\":\\"pass\\",\\"met\\":[{\\"id\\":\\"c1\\",\\"evidence\\":\\"found in a.js\\"}],\\"reason\\":\\"ok\\"}","is_error":false,"session_id":"v1"}\'\n' +
    '  else\n' +
    '    printf "%s" \'{"result":"{\\"verdict\\":\\"refute\\",\\"reason\\":\\"criterion one is unmet\\"}","is_error":false,"session_id":"v1"}\'\n' +
    '  fi\n' +
    'else\n' +
    '  printf "%s" \'{"result":"did work\\nURFAEL-GOAL-DONE","is_error":false,"session_id":"w1"}\'\n' +
    'fi\n', { mode: 0o755 });
  // a git repo for the loop to operate on
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  cp.execFileSync('git', ['init', '-q'], { cwd: repo });
  cp.execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  cp.execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed');
  cp.execFileSync('git', ['add', '-A'], { cwd: repo });
  cp.execFileSync('git', ['commit', '-qm', 'seed'], { cwd: repo });
  // a fake HOME so goal-loop resolves APP → THIS worktree's app/ (not the user's real ~/urfael-src)
  const home = path.join(dir, 'home'); fs.mkdirSync(path.join(home, '.claude', 'urfael'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'urfael', 'repo'), REPO_ROOT);
  const crit = path.join(dir, 'criteria.txt'); fs.writeFileSync(crit, '# the bar\ncriterion one must be implemented\n');
  return { dir, bin, claudeLog, repo, home, crit };
}

function runLoop(stub, extraArgs, extraEnv) {
  const env = Object.assign({}, process.env, {
    HOME: stub.home,
    PATH: stub.bin + ':' + process.env.PATH,
  }, extraEnv || {});
  const args = [GOAL_LOOP, 'do the thing', '--repo', stub.repo, '--max-iters', '2', '--turn-timeout', '30', '--model', 'sonnet', ...extraArgs];
  const r = cp.spawnSync('bash', args, { env, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), prompts: (() => { try { return fs.readFileSync(stub.claudeLog, 'utf8'); } catch { return ''; } })() };
}

test('MANDATORY CONTRACT: --verify without --criteria exits non-zero (fail-closed)', () => {
  const stub = makeStub();
  try {
    const r = runLoop(stub, ['--verify']);   // no --criteria
    assert.notEqual(r.code, 0, 'must exit non-zero');
    assert.match(r.out, /--verify requires --criteria/);
  } finally { fs.rmSync(stub.dir, { recursive: true, force: true }); }
});

test('DEFAULT BYTE-IDENTICAL: flag-off worker prompt is the baseline (no COMPLETION CONTRACT injected)', () => {
  const stub = makeStub();
  try {
    const r = runLoop(stub, ['--max-iters', '1']);   // no --verify
    assert.ok(r.prompts.includes('Work toward this goal in this repo'), 'baseline prompt present');
    assert.ok(!r.prompts.includes('COMPLETION CONTRACT'), 'no contract text is injected when the gate is off');
    assert.ok(!r.prompts.includes('Independent completion review'), 'no verifier is ever spawned when the gate is off');
  } finally { fs.rmSync(stub.dir, { recursive: true, force: true }); }
});

test('CONTRACT INJECTED under --verify: the worker prompt carries the up-front bar', () => {
  const stub = makeStub();
  try {
    const r = runLoop(stub, ['--verify', '--criteria', stub.crit, '--max-iters', '1'], { FAKE_VERDICT: 'refute' });
    assert.ok(r.prompts.includes('COMPLETION CONTRACT'), 'the contract bar is prepended to the worker turn');
    assert.ok(r.prompts.includes('criterion one must be implemented'), 'the criteria are shown to the worker');
  } finally { fs.rmSync(stub.dir, { recursive: true, force: true }); }
});

test('EXIT ON PASS: a pass verdict falls through to DONE (independently verified)', () => {
  const stub = makeStub();
  try {
    const r = runLoop(stub, ['--verify', '--criteria', stub.crit], { FAKE_VERDICT: 'pass' });
    assert.ok(r.prompts.includes('Independent completion review'), 'the verifier WAS spawned at candidate-done');
    assert.match(r.out, /Result: COMPLETED/);
    assert.match(r.out, /independently verified/);
  } finally { fs.rmSync(stub.dir, { recursive: true, force: true }); }
});

test('REFUTE → continue + FEEDBACK: a refute never DONEs and feeds the reason into the next prompt', () => {
  const stub = makeStub();
  try {
    const r = runLoop(stub, ['--verify', '--criteria', stub.crit], { FAKE_VERDICT: 'refute' });
    assert.ok(!/Result: COMPLETED/.test(r.out), 'a refuted candidate is never COMPLETED');
    assert.match(r.out, /not independently verified/);
    // the refutation reason is injected into a later worker turn's prompt
    assert.ok(r.prompts.includes('a prior INDEPENDENT read-only review REFUTED completion'), 'the refutation is fed back');
    assert.ok(r.prompts.includes('criterion one is unmet'), 'the specific reason is carried into the next turn');
  } finally { fs.rmSync(stub.dir, { recursive: true, force: true }); }
});

test('TWO-KEY ORDERING: a RED --check never spawns the verifier (Layer 1 gates Layer 2)', () => {
  const stub = makeStub();
  try {
    // --check "false" never passes → candidate-done is never reached → the verifier is never spawned.
    const r = runLoop(stub, ['--verify', '--criteria', stub.crit, '--check', 'false'], { FAKE_VERDICT: 'pass' });
    assert.ok(!r.prompts.includes('Independent completion review'), 'a red check must never spawn the independent verifier');
    assert.ok(!/Result: COMPLETED/.test(r.out), 'a red check can never reach DONE');
  } finally { fs.rmSync(stub.dir, { recursive: true, force: true }); }
});
