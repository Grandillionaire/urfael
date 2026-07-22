'use strict';
// Integration test for `urfael code` / checkpoints / rewind against a REAL throwaway git repo. Proves the git surgery
// is safe: a checkpoint captures the whole working tree, a rewind restores tracked files to the snapshot, and files
// created AFTER the snapshot are kept (never silently deleted). Fully isolated via a temp HOME so it touches no real
// vault or memory. Uses --no-run (skip the claude brain) and --yes (skip the confirm prompt).

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli.js');
let GIT = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { GIT = false; }

test('urfael code: checkpoint captures the tree, rewind restores tracked files and keeps new ones', { skip: GIT ? false : 'git not installed' }, () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'urfael-code-it-'));
  const home = path.join(rootDir, 'home'); fs.mkdirSync(home);
  const repo = path.join(rootDir, 'repo'); fs.mkdirSync(repo);
  const env = { ...process.env, HOME: home, USERPROFILE: home, URFAEL_MEMORY_DIR: 'Urfael-memory' };   // USERPROFILE: os.homedir() reads it on win32
  delete env.ELECTRON_RUN_AS_NODE;
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: ['ignore', 'pipe', 'ignore'], env }).toString();
  const cli = (...a) => execFileSync('node', [CLI, ...a], { stdio: ['ignore', 'pipe', 'ignore'], env, timeout: 30000 }).toString();
  const cpIdFrom = (out) => { const m = out.match(/checkpoint (\S+)/); return m ? m[1] : ''; };

  try {
    // a repo with one commit: a.txt = v0
    git('init', '-q');
    git('config', 'core.autocrlf', 'false');   // pin: the test asserts byte round-trips; the machine's autocrlf (true on windows CI) must not rewrite them
    git('config', 'user.email', 'test@urfael.local'); git('config', 'user.name', 'Urfael Test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'v0\n');
    git('add', '-A'); git('commit', '-q', '-m', 'init');

    // first coding turn (no brain): modify a.txt (uncommitted) -> checkpoint cp1 at a=v1, no b.txt
    fs.writeFileSync(path.join(repo, 'a.txt'), 'v1\n');
    const cp1 = cpIdFrom(cli('code', 'first task', '--no-run', '--dir', repo));
    assert.match(cp1, /^[a-z0-9]+-[0-9a-f]{4}$/, 'code printed a checkpoint id');

    // change a.txt and add a brand-new untracked file, then a second checkpoint
    fs.writeFileSync(path.join(repo, 'a.txt'), 'v2\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'new file\n');
    const cp2 = cpIdFrom(cli('code', 'second task', '--no-run', '--dir', repo));
    assert.ok(cp2 && cp2 !== cp1, 'second checkpoint is distinct');

    // checkpoints lists both, newest first — deterministic even though both were made within the same second
    const list = cli('checkpoints', '--dir', repo);
    assert.match(list, new RegExp(cp1)); assert.match(list, new RegExp(cp2));
    assert.ok(list.indexOf(cp2) < list.indexOf(cp1), 'newest checkpoint listed first (ms-precision tiebreak)');

    // diverge further, then rewind to cp1
    fs.writeFileSync(path.join(repo, 'a.txt'), 'v3\n');
    const rw = cli('rewind', cp1, '--yes', '--dir', repo);

    // a.txt restored to the cp1 snapshot (v1); b.txt (created after cp1) was KEPT, not deleted, AND reported
    assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'v1\n', 'tracked file restored to snapshot');
    assert.ok(fs.existsSync(path.join(repo, 'b.txt')), 'file created after the snapshot is kept');
    assert.match(rw, /b\.txt/, 'the kept file is actually listed in the rewind output');

    // the index is NOT left staged after a rewind (restored a.txt=v1 differs from HEAD a.txt=v0, but stays unstaged)
    assert.equal(git('diff', '--cached', '--name-only').trim(), '', 'rewind left nothing staged in the index');
    assert.match(git('diff', '--name-only').trim(), /a\.txt/, 'the restore shows as an ordinary working-tree change');

    // the rewind was itself checkpointed (so it is undoable) -> at least 3 checkpoints now
    const after = git('for-each-ref', 'refs/urfael/checkpoints/').split('\n').filter(Boolean);
    assert.ok(after.length >= 3, 'rewind created a reversible back-checkpoint');

    // the user's real branch was never touched by checkpointing (HEAD still the single init commit)
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1', 'shadow refs never polluted the branch history');

    // per-project memory was created under the isolated HOME (a CONVENTIONS.md seed)
    const mem = path.join(home, 'Urfael-memory', 'projects');
    assert.ok(fs.existsSync(mem) && fs.readdirSync(mem).length >= 1, 'per-project memory dir was created');
  } finally {
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch {}
  }
});
