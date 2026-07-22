'use strict';
// app/claude-bin.js — ONE resolver for "how do we spawn the claude CLI here", pure + injected like platform.js.
// Returns { bin, pre }: spawn(bin, pre.concat(args)) at every call site. On POSIX pre is ALWAYS [] and bin is
// the same absolute-path probe that shipped — byte-identical behavior.
//
// Native Windows needs care: an npm-installed claude is a `claude.cmd` shim, and spawning a .cmd without a
// shell is (correctly) refused by Node, while spawning WITH a shell would let metacharacters in a prompt
// re-enter cmd.exe — an injection we refuse to build. So we never touch a shell: we either find a real
// `claude.exe` (the native installer puts one in %USERPROFILE%\.local\bin) or we unwrap the npm shim to the
// cli.js it targets and run THAT with our own node (process.execPath). If neither exists, we fall back to the
// bare name so the caller's existing "is claude installed?" error path fires with its usual message.
const path = require('path');
const W = path.win32;   // win32 resolution uses win32 path semantics EXPLICITLY, so the branch is unit-testable from any host

const POSIX_PROBES = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude'];

function exists(fsx, p) { try { fsx.accessSync(p); return true; } catch { return false; } }

// The cli.js an npm/pnpm `claude.cmd` shim points at, derived from the shim's own directory — the shim text
// itself is not parsed (formats drift across npm versions; the layout next to it does not).
function shimTarget(fsx, cmdPath) {
  const dir = W.dirname(cmdPath);
  const cand = W.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  return exists(fsx, cand) ? cand : '';
}

function resolveWin(env, fsx, execPath) {
  const e = env || {};
  const home = String(e.USERPROFILE || e.HOME || '');
  const appdata = String(e.APPDATA || (home && W.join(home, 'AppData', 'Roaming')) || '');

  // 1) explicit override wins, in whatever form the owner gave it
  const forced = String(e.URFAEL_CLAUDE_BIN || '');
  if (forced) {
    if (/\.(cjs|mjs|js)$/i.test(forced)) return { bin: execPath, pre: [forced] };
    if (/\.cmd$/i.test(forced)) { const t = shimTarget(fsx, forced); if (t) return { bin: execPath, pre: [t] }; }
    return { bin: forced, pre: [] };
  }
  // 2) the native installer's real executable
  if (home) { const exe = W.join(home, '.local', 'bin', 'claude.exe'); if (exists(fsx, exe)) return { bin: exe, pre: [] }; }
  // 3) the npm global tree, entered directly (no shim, no shell)
  if (appdata) { const cli = W.join(appdata, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'); if (exists(fsx, cli)) return { bin: execPath, pre: [cli] }; }
  // 4) anything on PATH: a real .exe is spawnable as-is; a .cmd shim gets unwrapped
  for (const dir of String(e.PATH || e.Path || '').split(W.delimiter)) {
    if (!dir) continue;
    const exe = W.join(dir, 'claude.exe'); if (exists(fsx, exe)) return { bin: exe, pre: [] };
    const cmd = W.join(dir, 'claude.cmd'); if (exists(fsx, cmd)) { const t = shimTarget(fsx, cmd); if (t) return { bin: execPath, pre: [t] }; }
  }
  // 5) nothing found — keep the caller's friendly "is claude installed?" failure mode
  return { bin: 'claude', pre: [] };
}

// resolve(env?, platform?, fsx?, execPath?) → { bin, pre }
function resolve(env, platform, fsx, execPath) {
  const e = env || process.env;
  const p = platform || process.platform;
  const fs = fsx || require('fs');
  const xp = execPath || process.execPath;
  if (p === 'win32') return resolveWin(e, fs, xp);
  const bin = e.URFAEL_CLAUDE_BIN || POSIX_PROBES.find((c) => exists(fs, c)) || 'claude';
  return { bin, pre: [] };
}

module.exports = { resolve, POSIX_PROBES };
