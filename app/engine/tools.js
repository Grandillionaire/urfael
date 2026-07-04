'use strict';
// app/engine/tools.js — the native engine's fail-closed toolset.
//
// WHY THIS EXISTS (read before touching): when Urfael runs a turn through the `claude` CLI (app/session.js),
// the vault's `permissions.deny` list is a HARD boundary that Claude Code enforces in-process — it blocks the
// model's file tools from reading ~/.ssh, writing ~/.zshrc, or overwriting the deny rules themselves. The NATIVE
// engine does not go through Claude Code. These tools ARE the boundary. If this module is sloppy, the native
// engine is strictly less safe than the CLI one, and Urfael's "fail-closed by default" claim is false for anyone
// who switches engines. So every guarantee the vault deny-list gives the CLI path is re-established here, in code:
//
//   1. ALLOWLIST ROOTS, deny-everything-else. A path is reachable only if its REAL (symlink-resolved) location is
//      inside the vault or an explicitly configured workspace/memory root. No root ⇒ no file access.
//   2. DENY-FIRST defense-in-depth. Even inside a root, a credential/RC/persistence deny-glob is refused first —
//      so a misconfigured root that accidentally contains $HOME still can't read ~/.aws or write a LaunchAgent.
//   3. NO SYMLINK ESCAPE. We realpath the deepest existing ancestor (the file itself for reads; its parent for a
//      not-yet-existing write target) and re-check containment on the resolved path, so a symlink inside the vault
//      pointing at /etc can't smuggle a read/write out.
//   4. SHELL IS OFF BY DEFAULT. exec_shell is only present when the caller passes an explicit runShell AND the
//      owner opted in (allowShell). Absent either, the tool does not exist — the model can't even call it. This is
//      the whole point vs. Hermes, whose default terminal backend runs LLM commands directly on the host.
//   5. NEVER THROW. Every dispatch resolves { ok, content } (content is the tool_result text the loop feeds back).
//      A guard failure is a normal, visible tool_result ("denied: ...") the model can react to — never a crash.
//
// Pure-ish + injectable: no module-level I/O, no daemon import. createToolset(cfg) returns { defs, dispatch }.
// cfg = { vaultDir, memoryDir?, workspaceDir?, allowShell?, runShell?, recall?, appendMemory?, now?, maxBytes? }

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_MAX_BYTES = 256 * 1024;    // per read/write payload cap — a tool_result is not a file transfer
const MAX_LIST = 400;                     // directory-listing entry cap

// The credential / RC / persistence deny-globs — the code mirror of vault-template/_urfael/settings.json. These
// are checked FIRST, before any allow-root, so they hold even if a root is misconfigured. Home-anchored.
function defaultDenyGlobs() {
  const home = os.homedir();
  // If HOME is unset/relative (getpwuid failure), home-anchored globs would `path.resolve` against process.cwd()
  // and protect the WRONG location. Fail safe: emit no home globs and rely on the allowlist-root boundary, which
  // is the primary containment anyway. (A caller can always pass an explicit denyGlobs.)
  if (!home || !path.isAbsolute(home)) return [];
  const H = (p) => path.join(home, p);
  return [
    H('.claude'), H('.ssh'), H('.aws'), H('.gnupg'), H('.config/gcloud'),
    H('.netrc'), H('.npmrc'), H('.git-credentials'),
    H('.zshrc'), H('.zprofile'), H('.bashrc'), H('.bash_profile'), H('.profile'), H('.zshenv'),
    H('.config'), H('Library/LaunchAgents'), H('Library/LaunchDaemons'),
    H('bin'), H('.local/bin'),
    // Urfael's own runtime secrets live here — the native tools must never read them either.
    H('.claude/urfael'),
  ].map((p) => path.resolve(p));
}

// isUnder(child, parent) — true iff `child` is `parent` or strictly inside it. Both must be absolute + normalized.
// Uses a path-segment boundary (parent + sep) so /vault-evil is NOT considered under /vault.
function isUnder(child, parent) {
  if (child === parent) return true;
  const p = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(p);
}

// realDeepest(abs) — realpath the deepest EXISTING ancestor of abs, then re-append the non-existent tail. Lets us
// resolve symlinks for a write target that doesn't exist yet, without following a final symlink we shouldn't.
// FAILS CLOSED: returns null if the ancestor walk can't resolve within the (generous) budget, so a pathologically
// deep target can't skip the symlink-resolution and pass the allowlist on its unresolved-but-textually-inside path.
const REALDEEPEST_BUDGET = 4096;   // far beyond any real path depth; only a hostile >4k-component path exhausts it
function realDeepest(abs) {
  let tail = [];
  let cur = abs;
  for (let i = 0; i < REALDEEPEST_BUDGET; i++) {
    try { const real = fs.realpathSync(cur); return tail.length ? path.join(real, ...tail) : real; }
    catch { const base = path.basename(cur); const parent = path.dirname(cur); if (parent === cur) return null; tail.unshift(base); cur = parent; }
  }
  return null;   // budget exhausted (a >4096-deep non-existent path) OR the walk hit root without resolving — fail closed
}

// globToRe — translate a shell glob to an anchored RegExp. `**` crosses path separators, `*` does not, `?` is one
// non-separator char; every other regex metachar is escaped. Pure; used by find_files and grep's optional filter.
function globToRe(glob) {
  let re = '';
  const g = String(glob || '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') { if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}

// walkFiles — a bounded, symlink-non-following file walk under `root`. Yields absolute file paths only. Skips
// symlinked entries (so it can't leave the root) and any `.git`/node_modules dir. Caps total entries visited so a
// huge tree can't wedge a tool call. NOT recursive-descent into a symlinked directory — that is the escape guard.
function* walkFiles(root, maxEntries) {
  const stack = [root];
  let seen = 0;
  while (stack.length) {
    const dir = stack.shift();
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (++seen > maxEntries) return;
      if (e.isSymbolicLink()) continue;                 // never traverse OR return a symlink (no escape, no loop)
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) yield full;
    }
  }
}

function createToolset(cfg) {
  cfg = cfg || {};
  // Roots are symlink-RESOLVED at construction: guardPath compares against the realpath of an input, so the roots
  // must be real too, or a vault whose path merely contains a symlink (macOS /var→/private/var, a symlinked $HOME)
  // would deny every access — fail-closed, but uselessly. realDeepest also normalizes a trailing slash away.
  const roots = [cfg.vaultDir, cfg.memoryDir, cfg.workspaceDir]
    .filter(Boolean).map((p) => realDeepest(path.resolve(p))).filter(Boolean);   // drop any root that won't resolve (fail-closed)
  const denyGlobs = Array.isArray(cfg.denyGlobs) ? cfg.denyGlobs.map((p) => path.resolve(p)) : defaultDenyGlobs();
  const maxBytes = cfg.maxBytes || DEFAULT_MAX_BYTES;
  const shellOn = !!(cfg.allowShell && typeof cfg.runShell === 'function');

  // guardPath(input, {forWrite}) — the one gate. Returns { path } (absolute, symlink-resolved, safe) or
  // { error } (a human-readable refusal). Deny-first, then allow-roots, then symlink re-check. Never throws.
  function guardPath(input, opts = {}) {
    if (typeof input !== 'string' || !input.trim()) return { error: 'no path given' };
    if (input.indexOf('\0') !== -1) return { error: 'denied: null byte in path' };
    if (roots.length === 0) return { error: 'denied: no file root configured (fail-closed)' };
    // resolve relative paths against the vault (the model's natural cwd), never process.cwd()
    let abs = path.isAbsolute(input) ? path.normalize(input) : path.resolve(roots[0], input);
    // expand a leading ~ so a deny-glob on $HOME actually matches an input the model typed with ~
    if (input === '~' || input.startsWith('~/')) abs = path.normalize(path.join(os.homedir(), input.slice(1)));
    const real = realDeepest(abs);
    if (real === null) return { error: 'denied: unresolvable path (fail-closed)' };   // >budget-deep or unresolvable → never trust the literal
    // 1. DENY-FIRST: refuse credential/RC/persistence targets on BOTH the literal and the resolved path
    for (const d of denyGlobs) {
      if (isUnder(abs, d) || isUnder(real, d)) return { error: 'denied: protected path (credentials/system)' };
    }
    // 2. ALLOWLIST: the resolved real path must live inside a configured root
    if (!roots.some((r) => isUnder(real, r))) return { error: 'denied: outside the vault/workspace (fail-closed)' };
    return { path: real, forWrite: !!opts.forWrite };
  }

  // ---- tool implementations. Each returns a string (the tool_result content). Guard failures are normal results.
  const impl = {
    read_file(args) {
      const g = guardPath(args && args.path);
      if (g.error) return g.error;
      let st; try { st = fs.statSync(g.path); } catch { return 'not found: ' + (args && args.path); }
      if (st.isDirectory()) return 'is a directory (use list_dir): ' + args.path;
      if (st.size > maxBytes) return 'file too large (' + st.size + ' bytes > ' + maxBytes + ' cap); read a smaller slice';
      try { return fs.readFileSync(g.path, 'utf8'); } catch (e) { return 'read error: ' + String((e && e.code) || e); }
    },
    list_dir(args) {
      const g = guardPath(args && args.path);
      if (g.error) return g.error;
      let ents; try { ents = fs.readdirSync(g.path, { withFileTypes: true }); } catch (e) { return 'list error: ' + String((e && e.code) || e); }
      const lines = ents.slice(0, MAX_LIST).map((e) => (e.isDirectory() ? 'd ' : '- ') + e.name);
      if (ents.length > MAX_LIST) lines.push('… (' + (ents.length - MAX_LIST) + ' more, truncated)');
      return lines.join('\n') || '(empty)';
    },
    write_file(args) {
      const g = guardPath(args && args.path, { forWrite: true });
      if (g.error) return g.error;
      const content = String((args && args.content) != null ? args.content : '');
      if (Buffer.byteLength(content) > maxBytes) return 'refused: content exceeds ' + maxBytes + '-byte cap';
      try {
        fs.mkdirSync(path.dirname(g.path), { recursive: true });
        // atomic + never-follow-symlink: write a fresh temp then rename over the target
        const tmp = g.path + '.urftmp-' + process.pid;
        fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'w' });
        fs.renameSync(tmp, g.path);
        return 'wrote ' + Buffer.byteLength(content) + ' bytes to ' + path.basename(g.path);
      } catch (e) { return 'write error: ' + String((e && e.code) || e); }
    },
    edit_file(args) {
      const g = guardPath(args && args.path, { forWrite: true });
      if (g.error) return g.error;
      const find = args && typeof args.find === 'string' ? args.find : null;
      const replace = args && typeof args.replace === 'string' ? args.replace : null;
      if (find == null || replace == null) return 'refused: edit needs string `find` and `replace`';
      let cur; try { cur = fs.readFileSync(g.path, 'utf8'); } catch { return 'not found: ' + args.path; }
      const idx = cur.indexOf(find);
      if (idx === -1) return 'refused: `find` text not present (no change made)';
      if (cur.indexOf(find, idx + find.length) !== -1) return 'refused: `find` matches more than once — make it unique';
      const next = cur.slice(0, idx) + replace + cur.slice(idx + find.length);
      if (Buffer.byteLength(next) > maxBytes) return 'refused: result exceeds ' + maxBytes + '-byte cap';
      try { const tmp = g.path + '.urftmp-' + process.pid; fs.writeFileSync(tmp, next, { mode: 0o600 }); fs.renameSync(tmp, g.path); return 'edited ' + path.basename(g.path); }
      catch (e) { return 'edit error: ' + String((e && e.code) || e); }
    },
    grep(args) {
      if (roots.length === 0) return 'denied: no file root configured (fail-closed)';
      const pattern = String((args && args.pattern) || '').slice(0, 200);
      if (!pattern) return 'refused: empty pattern';
      let re; try { re = new RegExp(pattern, (args && args.ignoreCase) ? 'i' : ''); } catch (e) { return 'bad regex: ' + String((e && e.message) || e); }
      const nameFilter = (args && args.glob) ? globToRe(String(args.glob)) : null;
      const out = [];
      const MAX_MATCHES = 200, MAX_LINE = 2000;         // MAX_LINE bounds regex backtracking work per line (ReDoS guard)
      for (const root of roots) {
        for (const f of walkFiles(root, 20000)) {
          if (out.length >= MAX_MATCHES) break;
          if (nameFilter && !nameFilter.test(path.basename(f))) continue;
          const g = guardPath(f);                       // deny-first + allowlist even on a walked path (belt + suspenders)
          if (g.error) continue;
          let st; try { st = fs.statSync(g.path); } catch { continue; }
          if (st.size > maxBytes) continue;
          let content; try { content = fs.readFileSync(g.path, 'utf8'); } catch { continue; }
          if (content.indexOf('\0') !== -1) continue;   // skip binary
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && out.length < MAX_MATCHES; i++) {
            const line = lines[i].length > MAX_LINE ? lines[i].slice(0, MAX_LINE) : lines[i];
            if (re.test(line)) out.push(path.relative(root, g.path) + ':' + (i + 1) + ': ' + line.trim().slice(0, 200));
          }
        }
      }
      return out.length ? out.join('\n') + (out.length >= MAX_MATCHES ? '\n… (truncated at ' + MAX_MATCHES + ' matches)' : '') : 'no matches';
    },
    find_files(args) {
      if (roots.length === 0) return 'denied: no file root configured (fail-closed)';
      const pat = String((args && args.pattern) || '').slice(0, 200);
      if (!pat) return 'refused: empty pattern';
      let re; try { re = globToRe(pat); } catch (e) { return 'bad glob: ' + String((e && e.message) || e); }
      const out = [];
      for (const root of roots) {
        for (const f of walkFiles(root, 50000)) {
          if (out.length >= MAX_LIST) break;
          const rel = path.relative(root, f);
          if (re.test(rel) || re.test(path.basename(f))) { const g = guardPath(f); if (!g.error) out.push(rel); }
        }
      }
      return out.length ? out.join('\n') + (out.length >= MAX_LIST ? '\n… (' + MAX_LIST + '+, truncated)' : '') : 'no matches';
    },
    async recall(args) {
      if (typeof cfg.recall !== 'function') return 'recall unavailable';
      const q = String((args && args.query) || '').slice(0, 500);
      if (!q) return 'refused: empty query';
      try { const r = await cfg.recall(q, Math.min(Math.max((args && args.k) | 0 || 8, 1), 25)); return typeof r === 'string' ? r : JSON.stringify(r); }
      catch (e) { return 'recall error: ' + String((e && e.message) || e); }
    },
    async remember(args) {
      if (typeof cfg.appendMemory !== 'function') return 'memory unavailable';
      const note = String((args && args.note) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 1000);
      if (!note) return 'refused: empty note';
      try { await cfg.appendMemory(note); return 'remembered'; }
      catch (e) { return 'memory error: ' + String((e && e.message) || e); }
    },
    async exec_shell(args) {
      if (!shellOn) return 'denied: shell is disabled (fail-closed default; enable with the owner opt-in)';
      const cmd = String((args && args.command) || '').slice(0, 4000);
      if (!cmd.trim()) return 'refused: empty command';
      try {
        const r = await cfg.runShell(cmd, {}, { timeoutMs: 60000 });   // runShell already uses scopedEnv + a watchdog + is vault-cwd
        let out = String(r.out == null ? '' : r.out);
        if (out.length > maxBytes) out = out.slice(0, maxBytes) + '\n… (output truncated at ' + maxBytes + ' bytes)';   // bound the tool_result like read_file
        return 'exit ' + r.exitCode + (out ? '\n' + out : '');
      } catch (e) { return 'shell error: ' + String((e && e.message) || e); }
    },
  };

  // Tool DEFINITIONS handed to the adapters (engine-neutral {name, description, parameters}). exec_shell is only
  // advertised when it is actually enabled, so a fail-closed install never even shows the model a shell tool.
  const defs = [
    { name: 'read_file', description: 'Read a UTF-8 text file inside the vault/workspace.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'list_dir', description: 'List a directory inside the vault/workspace.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    { name: 'write_file', description: 'Create or overwrite a file inside the vault/workspace.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    { name: 'edit_file', description: 'Replace one unique occurrence of `find` with `replace` in a vault/workspace file.', parameters: { type: 'object', properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } }, required: ['path', 'find', 'replace'] } },
    { name: 'grep', description: 'Search file contents by regex across the vault/workspace. Optional `glob` filters filenames; `ignoreCase` for case-insensitive. Returns path:line: match.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, glob: { type: 'string' }, ignoreCase: { type: 'boolean' } }, required: ['pattern'] } },
    { name: 'find_files', description: 'List files whose path matches a glob (e.g. **/*.md) across the vault/workspace.', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
  ];
  if (typeof cfg.recall === 'function') defs.push({ name: 'recall', description: 'Search prior conversations/memory (BM25-ranked).', parameters: { type: 'object', properties: { query: { type: 'string' }, k: { type: 'integer' } }, required: ['query'] } });
  if (typeof cfg.appendMemory === 'function') defs.push({ name: 'remember', description: 'Append a durable one-line fact to long-term memory.', parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] } });
  if (shellOn) defs.push({ name: 'exec_shell', description: 'Run a shell command (owner-enabled).', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } });

  // dispatch(name, args) — run a tool by name; unknown/failed always resolve to a string. NEVER throws/rejects.
  async function dispatch(name, args) {
    const fn = impl[name];
    if (!fn) return 'unknown tool: ' + name;
    try { return await fn(args || {}); }
    catch (e) { return 'tool error: ' + String((e && e.message) || e); }   // last-resort net; impls already guard
  }

  return { defs, dispatch, guardPath, _shellOn: shellOn };
}

module.exports = { createToolset, isUnder, defaultDenyGlobs };
