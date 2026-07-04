'use strict';
// Adversarial unit tests for the native engine's fail-closed toolset. This module IS the security boundary for
// the native engine (the CLI engine gets Claude Code's permissions.deny; the native engine gets THIS), so the
// tests attack it: path traversal, symlink escape out of the vault, credential deny-first even when a root is
// misconfigured to contain $HOME, write-target symlink smuggling, the null-byte trick, and — the headline
// differentiator — exec_shell being ABSENT (not merely erroring) unless explicitly enabled.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createToolset, isUnder } = require('../engine/tools');

// a throwaway sandbox: a vault dir + an OUTSIDE dir (the thing the model must never reach)
function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'urf-tools-'));
  const vault = path.join(base, 'vault'); fs.mkdirSync(vault);
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(vault, 'note.md'), 'hello');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOPSECRET');
  return { base, vault, outside, cleanup: () => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} } };
}

test('isUnder: boundary is path-segment aware (/vault-evil is NOT under /vault)', () => {
  assert.strictEqual(isUnder('/vault/a', '/vault'), true);
  assert.strictEqual(isUnder('/vault', '/vault'), true);
  assert.strictEqual(isUnder('/vault-evil/a', '/vault'), false);
});

test('read: an in-vault file works; a relative path resolves against the vault', async () => {
  const s = sandbox();
  const ts = createToolset({ vaultDir: s.vault });
  assert.strictEqual(await ts.dispatch('read_file', { path: 'note.md' }), 'hello');
  assert.strictEqual(await ts.dispatch('read_file', { path: path.join(s.vault, 'note.md') }), 'hello');
  s.cleanup();
});

test('read: ../ traversal to a sibling dir is DENIED (outside a root)', async () => {
  const s = sandbox();
  const ts = createToolset({ vaultDir: s.vault });
  const r = await ts.dispatch('read_file', { path: '../outside/secret.txt' });
  assert.match(r, /denied: outside/);
  assert.ok(!r.includes('TOPSECRET'));
  s.cleanup();
});

test('read: a SYMLINK inside the vault pointing OUT is denied (no symlink escape)', async () => {
  const s = sandbox();
  const link = path.join(s.vault, 'escape');
  try { fs.symlinkSync(s.outside, link); } catch { s.cleanup(); return; }   // skip if the FS forbids symlinks
  const ts = createToolset({ vaultDir: s.vault });
  const r = await ts.dispatch('read_file', { path: 'escape/secret.txt' });
  assert.match(r, /denied: outside/);
  assert.ok(!r.includes('TOPSECRET'));
  s.cleanup();
});

test('deny-first: even when a root IS $HOME, ~/.ssh and ~/.aws are refused', async () => {
  // the misconfiguration case: someone points a workspace root at $HOME. Allowlist alone would let the model read
  // ~/.ssh; deny-first must still refuse it.
  const ts = createToolset({ vaultDir: os.homedir() });
  for (const p of ['~/.ssh/id_rsa', '~/.aws/credentials', '~/.claude/urfael/api-keys.env', '~/.zshrc']) {
    const r = await ts.dispatch('read_file', { path: p });
    assert.match(r, /denied: protected path/, 'expected deny for ' + p + ', got: ' + r);
  }
});

test('write: an in-vault write is atomic and read-backable; an out-of-vault write is denied', async () => {
  const s = sandbox();
  const ts = createToolset({ vaultDir: s.vault });
  const ok = await ts.dispatch('write_file', { path: 'sub/new.md', content: 'fresh' });
  assert.match(ok, /wrote 5 bytes/);
  assert.strictEqual(fs.readFileSync(path.join(s.vault, 'sub/new.md'), 'utf8'), 'fresh');
  const bad = await ts.dispatch('write_file', { path: '../outside/pwned.sh', content: 'rm -rf /' });
  assert.match(bad, /denied: outside/);
  assert.ok(!fs.existsSync(path.join(s.outside, 'pwned.sh')));
  s.cleanup();
});

test('write: a symlink at the TARGET does not let a write escape the vault', async () => {
  const s = sandbox();
  const target = path.join(s.vault, 'passthru');
  try { fs.symlinkSync(path.join(s.outside, 'secret.txt'), target); } catch { s.cleanup(); return; }
  const ts = createToolset({ vaultDir: s.vault });
  const r = await ts.dispatch('write_file', { path: 'passthru', content: 'OVERWRITE' });
  assert.match(r, /denied: outside/);
  assert.strictEqual(fs.readFileSync(path.join(s.outside, 'secret.txt'), 'utf8'), 'TOPSECRET');   // untouched
  s.cleanup();
});

test('write: the deny-list protects the vault settings that hold the deny-list (no self-strip)', async () => {
  const ts = createToolset({ vaultDir: os.homedir() });
  const r = await ts.dispatch('write_file', { path: '~/.claude/settings.json', content: '{}' });
  assert.match(r, /denied: protected path/);
});

test('edit: requires a UNIQUE find; refuses a multi-match without changing the file', async () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.vault, 'dup.md'), 'x x x');
  const ts = createToolset({ vaultDir: s.vault });
  const multi = await ts.dispatch('edit_file', { path: 'dup.md', find: 'x', replace: 'y' });
  assert.match(multi, /more than once/);
  assert.strictEqual(fs.readFileSync(path.join(s.vault, 'dup.md'), 'utf8'), 'x x x');   // unchanged
  const one = await ts.dispatch('edit_file', { path: 'note.md', find: 'hello', replace: 'world' });
  assert.match(one, /edited/);
  assert.strictEqual(fs.readFileSync(path.join(s.vault, 'note.md'), 'utf8'), 'world');
  s.cleanup();
});

test('null byte in a path is refused', async () => {
  const s = sandbox();
  const ts = createToolset({ vaultDir: s.vault });
  const r = await ts.dispatch('read_file', { path: 'note.md\0.png' });
  assert.match(r, /null byte/);
  s.cleanup();
});

test('no root configured ⇒ every file op fails closed', async () => {
  const ts = createToolset({});
  assert.match(await ts.dispatch('read_file', { path: '/etc/passwd' }), /no file root/);
  assert.match(await ts.dispatch('write_file', { path: 'x', content: 'y' }), /no file root/);
});

test('SHELL is OFF by default: the tool is not even advertised, and calling it is denied', async () => {
  const s = sandbox();
  const ts = createToolset({ vaultDir: s.vault });
  assert.ok(!ts.defs.some((d) => d.name === 'exec_shell'), 'exec_shell must not appear in tool defs');
  assert.strictEqual(ts._shellOn, false);
  const r = await ts.dispatch('exec_shell', { command: 'id' });
  assert.match(r, /denied: shell is disabled/);
  s.cleanup();
});

test('SHELL requires BOTH allowShell AND an injected runShell (fail-closed if either is missing)', async () => {
  const s = sandbox();
  // allowShell true but no runShell → still off
  const noRun = createToolset({ vaultDir: s.vault, allowShell: true });
  assert.strictEqual(noRun._shellOn, false);
  // runShell present but allowShell false → still off
  const noFlag = createToolset({ vaultDir: s.vault, runShell: async () => ({ exitCode: 0, out: 'x' }) });
  assert.strictEqual(noFlag._shellOn, false);
  // both → on, and it routes through the injected runShell
  let ran = null;
  const on = createToolset({ vaultDir: s.vault, allowShell: true, runShell: async (cmd) => { ran = cmd; return { exitCode: 0, out: 'done' }; } });
  assert.ok(on.defs.some((d) => d.name === 'exec_shell'));
  const r = await on.dispatch('exec_shell', { command: 'echo hi' });
  assert.strictEqual(ran, 'echo hi');
  assert.match(r, /exit 0[\s\S]*done/);
  s.cleanup();
});

test('recall/remember appear only when injected, and route to the injected fns', async () => {
  const s = sandbox();
  const bare = createToolset({ vaultDir: s.vault });
  assert.ok(!bare.defs.some((d) => d.name === 'recall'));
  let remembered = null;
  const wired = createToolset({ vaultDir: s.vault, recall: async (q) => 'hit:' + q, appendMemory: async (n) => { remembered = n; } });
  assert.strictEqual(await wired.dispatch('recall', { query: 'kube' }), 'hit:kube');
  await wired.dispatch('remember', { note: 'likes\ndark mode' });
  assert.strictEqual(remembered, 'likes dark mode');   // CR/LF stripped (no ledger injection)
  s.cleanup();
});

test('grep: finds a regex across vault files with path:line output, respects a glob filter', async () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.vault, 'a.md'), 'alpha\nTODO: fix this\nbeta');
  fs.mkdirSync(path.join(s.vault, 'sub'));
  fs.writeFileSync(path.join(s.vault, 'sub', 'b.txt'), 'TODO: other\ngamma');
  const ts = createToolset({ vaultDir: s.vault });
  const all = await ts.dispatch('grep', { pattern: 'TODO' });
  assert.match(all, /a\.md:2: TODO: fix this/);
  assert.match(all, /b\.txt:1: TODO: other/);
  const mdOnly = await ts.dispatch('grep', { pattern: 'TODO', glob: '*.md' });
  assert.match(mdOnly, /a\.md/);
  assert.ok(!mdOnly.includes('b.txt'));                 // glob filtered out the .txt
  assert.strictEqual(await ts.dispatch('grep', { pattern: 'nomatchhere' }), 'no matches');
  s.cleanup();
});

test('grep: a bad regex is refused, not thrown; empty pattern refused', async () => {
  const s = sandbox();
  const ts = createToolset({ vaultDir: s.vault });
  assert.match(await ts.dispatch('grep', { pattern: '(' }), /bad regex/);
  assert.match(await ts.dispatch('grep', { pattern: '' }), /empty pattern/);
  s.cleanup();
});

test('grep/find_files: the walk never escapes the vault via a symlinked directory', async () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.outside, 'leak.md'), 'SECRETMARKER');
  try { fs.symlinkSync(s.outside, path.join(s.vault, 'out')); } catch { s.cleanup(); return; }
  const ts = createToolset({ vaultDir: s.vault });
  const g = await ts.dispatch('grep', { pattern: 'SECRETMARKER' });
  assert.ok(!g.includes('SECRETMARKER'));               // the symlinked dir is never descended into
  const f = await ts.dispatch('find_files', { pattern: '**/leak.md' });
  assert.ok(!f.includes('leak.md'));
  s.cleanup();
});

test('find_files: matches a **/*.ext glob and lists relative paths', async () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.vault, 'notes'));
  fs.writeFileSync(path.join(s.vault, 'notes', 'x.md'), '1');
  fs.writeFileSync(path.join(s.vault, 'y.md'), '2');
  fs.writeFileSync(path.join(s.vault, 'z.txt'), '3');
  const ts = createToolset({ vaultDir: s.vault });
  const r = await ts.dispatch('find_files', { pattern: '**/*.md' });
  assert.match(r, /notes\/x\.md/);
  assert.match(r, /y\.md/);
  assert.ok(!r.includes('z.txt'));
  s.cleanup();
});

test('grep + find_files fail closed with no configured root', async () => {
  const ts = createToolset({});
  assert.match(await ts.dispatch('grep', { pattern: 'x' }), /no file root/);
  assert.match(await ts.dispatch('find_files', { pattern: '*' }), /no file root/);
});

test('dispatch never throws on an unknown tool or a throwing impl', async () => {
  const s = sandbox();
  const ts = createToolset({ vaultDir: s.vault, recall: async () => { throw new Error('boom'); } });
  assert.strictEqual(await ts.dispatch('nope', {}), 'unknown tool: nope');
  assert.match(await ts.dispatch('recall', { query: 'x' }), /recall error: boom/);
  s.cleanup();
});
