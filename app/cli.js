#!/usr/bin/env node
'use strict';
// urfael — talk to the brain from any terminal. A thin client of the daemon's unix socket
// (same brain, same memory, same warm sessions as the orb). No deps, no API key.
// The command surface (names, summaries, usage, examples) lives in ./registry.js — the single
// source of truth that feeds bare/grouped/per-command help AND did-you-mean. Nothing scrapes
// this file for help any more, so docs can't drift from the dispatch branches below.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const SOCK = path.join(os.homedir(), '.claude', 'urfael', 'daemon.sock');
const MEMORY_DIR = path.join(os.homedir(), process.env.URFAEL_MEMORY_DIR || 'Urfael-memory');
const DAEMON = path.join(__dirname, 'daemon.js');
const DASHBOARD = path.join(__dirname, 'dashboard.js');
const APISERVER = path.join(__dirname, 'openai-api.js');
const TOKENF = path.join(os.homedir(), '.claude', 'urfael', 'dashboard.token');
const APITOKENF = path.join(os.homedir(), '.claude', 'urfael', 'api.token');
// Colour only on a real terminal, and honour NO_COLOR — so `urfael help > FILE` / `| less` are clean plain text.
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const gold = (s) => COLOR ? `\x1b[33m${s}\x1b[0m` : `${s}`;
const dim = (s) => COLOR ? `\x1b[2m${s}\x1b[0m` : `${s}`;
const ok = (s) => COLOR ? `\x1b[32m${s}\x1b[0m` : `${s}`;
const warn = (s) => COLOR ? `\x1b[38;5;208m${s}\x1b[0m` : `${s}`;
const bad = (s) => COLOR ? `\x1b[31m${s}\x1b[0m` : `${s}`;
// strip ANSI to measure true printed width, so box borders line up regardless of colour codes
const visLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/[̀-ͯ]/g, '').length;
// The command surface is described once in ./registry.js. did-you-mean's keyword set is DERIVED
// from it — every canonical name + every real alias + `unremind` (its own branch, no registry
// entry) — so the hand-list can't fall out of sync with the dispatch branches below.
const reg = require('./registry');
reg.editDistance = require('./lib').editDistance;                       // lets `help <bad>` suggest a near command
const COMMANDS = [...reg.COMMANDS.map((c) => c.name), ...Object.keys(reg.ALIASES), 'unremind'];
const helpUI = { banner, frame, gold, dim, visLen };                   // the helpers registry's renderers draw with
// The terminal logo — gold ANSI-shadow URFAEL + the Uruz rune (ᚢ) + tagline. Colour only on a TTY (plain when piped).
function banner() {
  const logo = [
    '   ██╗   ██╗██████╗ ███████╗ █████╗ ███████╗██╗',
    '   ██║   ██║██╔══██╗██╔════╝██╔══██╗██╔════╝██║',
    '   ██║   ██║██████╔╝█████╗  ███████║█████╗  ██║',
    '   ██║   ██║██╔══██╗██╔══╝  ██╔══██║██╔══╝  ██║',
    '   ╚██████╔╝██║  ██║██║     ██║  ██║███████╗███████╗',
    '    ╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝╚══════╝╚══════╝',
  ].join('\n');
  const tag = 'Liquid Intelligence. At your service.';
  if (!COLOR) return '\n' + logo + '\n    ᚢᚱᚠᚨᛖᛚ   ' + tag + '\n';   // U·R·F·A·E·L in Elder Futhark
  return '\n\x1b[38;5;179m' + logo + '\x1b[0m\n    \x1b[38;5;214mᚢᚱᚠᚨᛖᛚ\x1b[0m   \x1b[2m' + tag + '\x1b[0m\n';
}

// A gold rounded box around pre-coloured content lines, title set into the top rule. Each line is padded
// to a common inner width measured WITHOUT ANSI codes, so the borders always align. Plain when piped.
function frame(title, lines, forceInner) {
  const G = COLOR ? '\x1b[38;5;179m' : '', A = COLOR ? '\x1b[38;5;214m' : '', R = COLOR ? '\x1b[0m' : '';
  const inner = Math.max(visLen(title) + 4, ...lines.map((l) => visLen(l) + 2), 46, forceInner || 0);
  const out = [G + '╭─ ' + A + title + R + ' ' + G + '─'.repeat(Math.max(1, inner - visLen(title) - 3)) + '╮' + R];
  for (const l of lines) {
    if (l === '') { out.push(G + '│' + R + ' '.repeat(inner) + G + '│' + R); continue; }
    out.push(G + '│ ' + R + l + ' '.repeat(Math.max(0, inner - visLen(l) - 1)) + G + '│' + R);
  }
  out.push(G + '╰' + '─'.repeat(inner) + '╯' + R);
  return out.join('\n');
}

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ socketPath: SOCK, method, path: p, headers: { 'Content-Type': 'application/json' }, timeout: 300000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function ensureDaemon() {
  const ok = () => req('GET', '/health').then(() => true).catch(() => false);
  if (await ok()) return true;
  try { const p = spawn(process.execPath, [DAEMON], { detached: true, stdio: 'ignore' }); p.unref(); } catch {}
  for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 400)); if (await ok()) return true; }
  return false;
}

function ask(text, pathOverride, useFinalText) {
  return new Promise((resolve) => {
    // While the turn runs, show a live one-line "oracle" status on stderr (a changing rune + thinking-word +
    // elapsed + token estimate + the current tool), then render the FULL answer as Markdown → ANSI on stdout —
    // so it reads like Claude Code's terminal (headings/bold/lists/code), never raw ## / ** . pathOverride lets a
    // sibling channel (e.g. the schedule channel's /schedule) reuse this exact NDJSON stream; default is /ask.
    const ttyErr = !!process.stderr.isTTY;
    const anim = ttyErr ? require('./tui-anim') : null;
    const TH = COLOR ? { accent: '\x1b[38;5;214m', gold: '\x1b[33m', dim: '\x1b[2m', RST: '\x1b[0m' } : { accent: '', gold: '', dim: '', RST: '' };
    const acfg = { anim: 'oracle', frameMs: 83, reduceMotion: false };
    const t0 = Date.now();
    let buf = '', started = false, lastTool = '', acc = '', timer = null, rendered = false;
    const cols = () => Math.max(20, process.stdout.columns || process.stderr.columns || 80);
    const drawStatus = () => { if (ttyErr) process.stderr.write('\r' + anim.composeWorker(acfg, TH, { t0, lastTool, answerChars: acc.length, usageTokens: null }, cols(), Date.now()) + '\x1b[K'); };
    const clearStatus = () => { if (timer) { clearInterval(timer); timer = null; } if (ttyErr) process.stderr.write('\r\x1b[K'); };
    const onSigint = () => { clearStatus(); Promise.race([req('POST', '/abort').catch(() => {}), new Promise((r) => setTimeout(r, 1500))]).then(() => process.exit(0)); };
    process.on('SIGINT', onSigint);
    const done = () => { clearStatus(); process.removeListener('SIGINT', onSigint); resolve(acc); };   // resolves with the raw answer so a caller (schedule) can detect a staged-confirm reply
    if (ttyErr) { timer = setInterval(drawStatus, acfg.frameMs); if (timer.unref) timer.unref(); }
    const render = (e) => {
      rendered = true;                                                     // a done event arrived; the end/timeout paths must NOT then claim a dropped stream
      const answer = acc.replace(/\[\/?SPOKEN\]/gi, '').replace(/[ \t\r\n]+$/, '');
      if (answer) process.stdout.write(require('./md').toAnsi(answer, { color: COLOR, base: COLOR ? '\x1b[33m' : '' }) + (COLOR ? '\x1b[0m' : '') + '\n');
      process.stdout.write(dim(`— ${e.aborted ? 'stopped' : (e.model || '')}${e.ms ? ' · ' + (e.ms / 1000).toFixed(1) + 's' : ''}`) + '\n');
    };
    const r = http.request({ socketPath: SOCK, method: 'POST', path: pathOverride || '/ask', headers: { 'Content-Type': 'application/json' }, timeout: 300000 }, (res) => {
      res.on('data', (d) => {
        buf += d.toString(); let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!ln) continue;
          let e; try { e = JSON.parse(ln); } catch { continue; }
          if (e.kind === 'thinking' && e.tool) lastTool = e.tool;
          else if (e.kind === 'thinking' && e.delta) { started = true; acc += e.delta; }
          // normally the de-dashed streamed deltas are the answer; useFinalText (the schedule channel) prefers the
          // done event's text instead, because the daemon strips its <<urfael:…>> directives + appends the confirm
          // marker only on that final text — streaming it raw would leak the tokens and hide "Say yes to apply."
          else if (e.kind === 'done') { if (e.text && (useFinalText || !started)) acc = e.text; clearStatus(); render(e); done(); }
        }
      });
      // a stream that ends WITHOUT a done event = the brain dropped it mid-turn; fail loudly + non-zero rather than vanish
      res.on('end', () => { clearStatus(); if (!rendered) { console.error(bad('✗') + ' the turn ended without a reply (the brain dropped the stream).' + dim('  run  ') + gold('urfael doctor')); process.exitCode = 1; } done(); });
    });
    r.on('error', () => { clearStatus(); console.error(bad('✗') + ' the brain is unreachable, sir.' + dim('  run  ') + gold('urfael doctor') + dim('  to diagnose it')); done(); });
    r.on('timeout', () => { clearStatus(); r.destroy(); if (!rendered) { console.error(bad('✗') + ' the turn timed out without a reply.' + dim('  run  ') + gold('urfael doctor')); process.exitCode = 1; } done(); }); // a wedged daemon mid-stream shouldn't hang the CLI forever
    r.end(JSON.stringify({ text }));
  });
}

function searchSessions(query) {
  const dir = path.join(MEMORY_DIR, 'sessions');
  if (!fs.existsSync(dir)) { console.log('no session archive yet'); return; }
  let out = '';
  try { out = execFileSync('grep', ['-ih', '-r', '--', query, dir], { maxBuffer: 1 << 24 }).toString(); } catch { console.log('no matches'); return; } // -- so a query starting with '-' isn't parsed as a flag
  const lines = out.trim().split('\n').slice(-30);
  for (const ln of lines) {
    try {
      const e = JSON.parse(ln);
      console.log(gold(`[${(e.t || '').slice(0, 16).replace('T', ' ')}] `) + `you: ${(e.user || '').slice(0, 100)}`);
      console.log(`  urfael: ${(e.urfael || '').replace(/\[\/?SPOKEN\]/gi, '').replace(/\s+/g, ' ').slice(0, 160)}`);
    } catch {}
  }
  console.log(dim(`(${lines.length} most recent matches)`));
}

function flag(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

// ── connector helpers (used by the `connect` dispatch) ──────────────────────────────────────────
// A masked secret prompt: reads from the TTY in raw mode and NEVER echoes the value, so a key isn't shoulder-
// surfed and (because the value is later passed to claude as an execFile argv element, not a shell line) never
// reaches ~/.zsh_history or a visible `ps` line. Resolves '' on a non-TTY (fail-closed: the caller aborts).
function promptSecret(label) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) { console.log(dim("(no tty — cannot read a secret safely; aborting)")); return resolve(""); }
    process.stdout.write(label);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
    let buf = "";
    const done = () => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener("data", onData); process.stdout.write("\n"); resolve(buf); };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        const code = ch.charCodeAt(0);
        if (code === 13 || code === 10 || code === 4) return done();          // enter / EOT
        if (code === 3) { stdin.setRawMode(false); process.stdout.write("\n"); process.exit(130); } // ctrl-c
        if (code === 127 || code === 8) { buf = buf.slice(0, -1); continue; } // backspace
        buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}
// Minimal TTY yes/no. Fail-closed: defaults to NO on a non-TTY.
function promptYesNo(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { console.log(dim('(no tty — refusing by default)')); return resolve(false); }
    process.stdout.write(question + ' [y/N] ');
    process.stdin.setEncoding('utf8'); process.stdin.resume();
    const onData = (d) => { process.stdin.pause(); process.stdin.removeListener('data', onData); resolve(/^\s*y(es)?\s*$/i.test(String(d))); };
    process.stdin.on('data', onData);
  });
}
// The pre-enable security preview — the move no competitor ships. Pure render of connectors.preview().
function printConnectorPreview(con, e) {
  const p = con.preview(e);
  console.log('');
  console.log(gold('── connector: ' + e.name) + dim('  (' + e.id + ' · ' + e.category + ')'));
  if (e.note) console.log(dim('   ' + e.note));
  console.log(dim('─'.repeat(60)));
  console.log(dim('   transport ') + (p.runsLocalCode ? gold(e.transport + ' — runs a third-party package on your machine') : (e.transport + ' → ' + (p.endpoint || ''))));
  console.log(dim('   auth      ') + e.auth + (p.secretsNeeded.length ? dim('  (needs: ' + p.secretsNeeded.join(', ') + ')') : ''));
  console.log(dim('   scope     ') + gold('owner turns only') + dim(' — sandboxed remote/cron/job turns never load it'));
  for (const f of p.flags) {
    const tag = f.level === 'danger' ? gold('[DANGER]') : f.level === 'warn' ? gold('[warn] ') : dim('[info] ');
    console.log('   ' + tag + ' ' + (f.level === 'info' ? dim(f.why) : f.why));
  }
  console.log(dim('─'.repeat(60)));
  console.log(dim('   command   ') + dim(p.command));
}
// The plugin capability preview — the exact grant + sandbox the owner would consent to. Pure render of pluginhub.preview().
function printPluginPreview(ph, m) {
  const p = ph.preview(m);
  console.log('');
  console.log(gold('── plugin: ' + m.name) + dim('  (' + m.id + ' · ' + p.runtime + ' · v' + m.version + ')'));
  if (m.description) console.log(dim('   ' + m.description));
  console.log(dim('─'.repeat(60)));
  console.log(dim('   tier      ') + (p.requiresDocker ? gold(p.tier) : p.tier));
  if (p.unconfined) console.log(dim('   ') + gold('⚠ not sandboxed') + dim('  — this plugin\'s MCP server is spawned as a normal local process with your privileges (no Docker cell). It has no GRANTED fs/net/secret, but the server code itself is unconfined. Install only code you trust.'));
  console.log(dim('   scope     ') + gold('owner turns only') + dim(' — never loaded on a sandboxed/remote/cron turn'));
  console.log(dim('   trust     ') + dim('signed ') + (p.signed ? gold('yes') : gold('NO')) + dim('   sha-pinned ') + (p.shaPinned ? gold('yes') : gold('NO')));
  if (!p.capabilities.length) console.log(dim('   caps      ') + dim('none — zero-capability, inert until granted'));
  else {
    console.log(dim('   caps      ') + dim('requested (each has NO effect until you grant it):'));
    for (const c of p.capabilities) console.log('     ' + gold(c.kind.padEnd(8)) + ' ' + dim(c.key));
  }
  if (p.tools.length) console.log(dim('   tools     ') + dim(p.tools.join(', ')));
  console.log(dim('─'.repeat(60)));
  console.log(dim('   sandbox   ') + dim('docker ' + p.cellArgs));
}

// A prompt can come from argv, a file (`--file <path>`, alias `--message-file`), or stdin (`urfael -`, or any pipe).
// These two adapters are the ONLY IO lib.resolvePromptText touches; they live here so that resolver stays pure and
// unit-tested with injected fakes. PROMPT_MAX_BYTES caps the prompt client-side with headroom under the daemon's
// 256KB body cap, so an oversized prompt fails LOUD here instead of being silently truncated to '' on the wire.
const PROMPT_MAX_BYTES = 200000;
const readFileAdapter = (p) => fs.readFileSync(p, 'utf8');               // throws on missing / dir / perm → fail-closed (mirrors the `skills scan` read above)
function readStdinAdapter(maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let len = 0, capped = false;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      if (capped) return;                                               // already one chunk past the cap → drop the rest so a runaway pipe can't exhaust memory
      chunks.push(c); len += Buffer.byteLength(c, 'utf8');
      if (len > maxBytes) capped = true;                                // keep the chunk that crossed it so the resolver still sees an over-cap body and rejects loud
    });
    process.stdin.on('end', () => resolve(chunks.join('')));
    process.stdin.on('error', reject);
  });
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'logo') { console.log(banner()); return; }

  // version / update: release discipline. Pure CLI, no brain. `update` pulls + reinstalls the user's own clone.
  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    const pkg = require('./package.json');
    const root = path.join(__dirname, '..');
    let sha = '';
    try { sha = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
    console.log(gold('Urfael ') + 'v' + pkg.version + (sha ? dim('  (' + sha + ')') : '') + dim('  ·  node ' + process.version + '  ·  ' + process.platform));
    console.log(dim('  changelog: ') + 'CHANGELOG.md' + dim('   ·   update: ') + gold('urfael update'));
    return;
  }
  if (cmd === 'update' || cmd === 'upgrade') {
    const root = path.join(__dirname, '..');
    try { execFileSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' }); }
    catch { console.error('✗ not a git checkout, so there is nothing to update. Reinstall from https://github.com/Grandillionaire/urfael'); process.exit(1); }
    process.stdout.write(dim('checking for updates…\n'));
    try { execFileSync('git', ['-C', root, 'fetch', '--quiet', 'origin'], { stdio: ['ignore', 'ignore', 'inherit'], timeout: 60000 }); }
    catch { console.error('✗ could not reach the remote (offline?)'); process.exit(1); }
    let behind = '0', branch = 'main';
    try { branch = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'main'; } catch {}
    try { behind = execFileSync('git', ['-C', root, 'rev-list', '--count', 'HEAD..origin/' + branch], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
    if (behind === '0') { console.log(gold('✓ already up to date') + dim('  (' + branch + ')')); return; }
    console.log(gold(behind + ' new commit' + (behind === '1' ? '' : 's') + ':'));
    try { console.log(execFileSync('git', ['-C', root, 'log', '--oneline', '--no-decorate', 'HEAD..origin/' + branch], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 20 }).toString().replace(/^/gm, '  ')); } catch {}
    if (rest.includes('--check')) { console.log(dim('  run ') + gold('urfael update') + dim(' to apply.')); return; }   // --check: report only, never pull
    const dirty = (() => { try { return !!execFileSync('git', ['-C', root, 'status', '--porcelain'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return false; } })();
    if (dirty) { console.error(dim('  you have local changes; commit or stash them first, then re-run ') + gold('urfael update')); process.exit(1); }
    if (!(await promptYesNo('Pull these and reinstall?'))) { console.log(dim('aborted, nothing changed')); return; }
    try { execFileSync('git', ['-C', root, 'pull', '--ff-only', '--quiet', 'origin', branch], { stdio: ['ignore', 'inherit', 'inherit'] }); }
    catch { console.error('✗ pull failed (a non-fast-forward?). Resolve it in ' + root); process.exit(1); }
    process.stdout.write(dim('installing dependencies…\n'));
    try { execFileSync('npm', ['install', '--silent'], { cwd: __dirname, stdio: ['ignore', 'ignore', 'inherit'], timeout: 300000 }); } catch { console.error(dim('  (npm install reported an issue; check it manually)')); }
    console.log(gold('✓ updated') + dim('  ·  restart the daemon to run the new code:  ') + gold('urfael shutdown') + dim(' then your next command'));
    return;
  }
  if (!cmd && process.stdin.isTTY) { console.log(reg.renderBare(helpUI)); return; }    // bare urfael → the "start here" card (but a piped `echo … | urfael` falls through to read stdin)
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(rest[0] ? reg.renderOne(rest[0], helpUI) : reg.renderFull(helpUI));   // `help <cmd>` drills in; `help` is the grouped reference
    return;
  }

  if (cmd === 'sessions') { if (rest[0] === 'search' && rest[1]) searchSessions(rest.slice(1).join(' ')); else console.log('usage: urfael sessions search <query>'); return; }

  // why: provenance. Memory is a git repo (distill/review/user-model passes commit it), so a git pickaxe
  // (-S <phrase>) walks any belief back to the exact commit/date/pass that introduced it. No new storage, no
  // LLM guessing — a checkable SHA. Pure CLI; phrase passed as a git ARG (execFile, never a shell), injection-safe.
  if (cmd === 'why') {
    const phrase = rest.filter((a) => !a.startsWith('--')).join(' ').trim();
    if (!phrase) { console.log('usage: urfael why "<a belief or fact you want sourced>"'); return; }
    const US = '\x1f';
    let out = '';
    try { out = execFileSync('git', ['-C', MEMORY_DIR, 'log', '-S', phrase, '--format=%h' + US + '%ci' + US + '%s', '--', 'MEMORY.md', 'USER.md', 'USER.json', 'WORKFLOW.md', 'LESSONS.md'], { maxBuffer: 1 << 22 }).toString(); }
    catch { console.log(dim('no versioned memory repo at ' + MEMORY_DIR + ' yet (or git unavailable)')); return; }
    const lines = out.trim().split('\n').filter(Boolean);
    if (!lines.length) { console.log(dim('No recorded provenance for "') + phrase + dim('" — I may be inferring it live rather than from a stored belief.')); return; }
    const prov = require('./provenance');
    const rows = lines.slice(0, 25).map((ln) => { const [sha, ci, subject] = ln.split(US); return { sha, ci, subject }; });
    console.log(prov.card(phrase, rows, { gold, dim }));
    console.log(dim('  see any change in full:  git -C ' + MEMORY_DIR + ' show <sha>'));
    return;
  }

  // as-of: a time machine over the git-versioned memory. Reconstruct what a memory file looked like as of a past
  // date — "what did you believe about me last month". Structurally can't leak present knowledge (it's the file
  // AT that commit). Pure git; date + file passed as ARGS (execFile), never a shell.
  if (cmd === 'as-of' || cmd === 'asof') {
    const args = rest.filter((a) => !a.startsWith('--'));
    const when = args[0], file = args[1] || 'USER.md';
    if (!when) { console.log('usage: urfael as-of <date> [file]   e.g.  urfael as-of "2026-05-01" MEMORY.md'); return; }
    let sha = '';
    try { sha = execFileSync('git', ['-C', MEMORY_DIR, 'rev-list', '-1', '--before=' + when, 'HEAD'], { maxBuffer: 1 << 20 }).toString().trim(); } catch { console.log(dim('no versioned memory repo at ' + MEMORY_DIR)); return; }
    if (!sha) { console.log(dim('No memory recorded before ' + when + '.')); return; }
    let content = '';
    try { content = execFileSync('git', ['-C', MEMORY_DIR, 'show', sha + ':' + file], { maxBuffer: 1 << 22 }).toString(); }
    catch { console.log(dim(file + ' did not exist as of ' + when + '.')); return; }
    let date = ''; try { date = execFileSync('git', ['-C', MEMORY_DIR, 'show', '-s', '--format=%ci', sha]).toString().trim().slice(0, 16); } catch {}
    console.log(gold(file + ' as of ' + when) + dim('  ·  commit ' + sha.slice(0, 8) + (date ? ' (' + date + ')' : '')));
    process.stdout.write(content.endsWith('\n') ? content : content + '\n');
    return;
  }

  // drift: turn the invisible in-place USER.md/MEMORY.md rewrite into an honest CHANGELOG — how beliefs were
  // added / revised / removed over time. Pure git plumbing (log -p over the committed memory file).
  if (cmd === 'drift') {
    const args = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] || '').startsWith('--'));
    const file = args[0] || 'USER.md';
    const sinceA = flag(rest, '--since') ? ['--since=' + flag(rest, '--since')] : [];
    let out = '';
    try { out = execFileSync('git', ['-C', MEMORY_DIR, 'log', ...sinceA, '--format=%x01%h%x1f%ci%x1f%s', '-p', '--', file], { maxBuffer: 1 << 24 }).toString(); }
    catch { console.log(dim('no versioned memory repo at ' + MEMORY_DIR)); return; }
    const blocks = out.split('\x01').filter((b) => b.trim());
    if (!blocks.length) { console.log(dim('no recorded changes to ' + file + (sinceA.length ? ' in that window' : ''))); return; }
    console.log(gold('Belief drift — ' + file) + dim('  ·  ' + blocks.length + ' change(s), newest first'));
    for (const b of blocks.slice(0, 25)) {
      const nl = b.indexOf('\n'); const [sha, date, subj] = b.slice(0, nl).split('\x1f');
      console.log('\n' + gold(sha) + dim('  ' + (date || '').slice(0, 16) + '  ' + (subj || '')));
      for (const ln of b.slice(nl + 1).split('\n')) {
        // diff content lines start with +/- ; skip the file headers (+++/---) and hunk/meta lines. NB a memory
        // bullet itself starts with '-', so detect by the DIFF prefix, not the 2nd char.
        if (ln.startsWith('+') && !ln.startsWith('+++')) { const c = ln.slice(1).trim(); if (c) console.log('  \x1b[32m+ ' + c.slice(0, 100) + '\x1b[0m'); }      // added belief
        else if (ln.startsWith('-') && !ln.startsWith('---')) { const c = ln.slice(1).trim(); if (c) console.log('  \x1b[31m- ' + c.slice(0, 100) + '\x1b[0m'); }   // removed / revised belief
      }
    }
    return;
  }

  // dataset: export your own runs + VERIFIED lessons as training data. Pure CLI, read-only, no brain. Provenance is
  // the tamper-evident Ledger of Record; credential-shaped strings are redacted by default. `stats` summarises.
  if (cmd === 'dataset' || cmd === 'trajectories') {
    const tj = require('./trajectory');
    const learn = require('./learn');
    const sub = rest[0] || 'stats';
    const sdir = path.join(MEMORY_DIR, 'sessions');
    const entries = [];
    try {
      for (const f of fs.readdirSync(sdir).filter((x) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort()) {
        for (const ln of fs.readFileSync(path.join(sdir, f), 'utf8').split('\n')) { if (!ln.trim()) continue; try { entries.push(JSON.parse(ln)); } catch {} }
      }
    } catch {}
    const ledger = (() => { try { return learn.load(MEMORY_DIR); } catch { return []; } })();
    const mc = flag(rest, '--min-confidence');
    const opts = { since: flag(rest, '--since'), until: flag(rest, '--until'), channel: flag(rest, '--channel'), model: flag(rest, '--model'), minConfidence: mc != null ? Number(mc) : undefined, redact: !rest.includes('--no-redact') };

    if (sub === 'stats') {
      const sft = tj.buildSFT(entries, opts);
      const trusted = ledger.filter((it) => it && it.status === 'trusted').length;
      const filtered = (opts.since || opts.until || opts.channel || opts.model);
      console.log(gold('Urfael dataset'));
      console.log('  archived turns:   ' + entries.length + (filtered ? dim('  (' + sft.records.length + ' after filter)') : ''));
      console.log('  verified lessons: ' + trusted);
      console.log(dim('  formats:  ') + 'sft' + dim(' (fine-tune messages) · ') + 'atropos' + dim(' (trajectory+reward) · ') + 'lessons' + dim(' (verified knowledge, confidence-weighted)'));
      console.log(dim('  export:   ') + gold('urfael dataset export --format all --out ~/urfael-dataset'));
      return;
    }

    if (sub === 'export') {
      const fmt = (flag(rest, '--format') || 'sft').toLowerCase();
      const out = flag(rest, '--out') || path.join(process.cwd(), 'urfael-dataset');
      try { fs.mkdirSync(out, { recursive: true }); } catch (e) { console.error('✗ cannot create ' + out + ': ' + (e && e.message)); process.exit(1); }
      const parts = {}; const want = (k) => fmt === 'all' || fmt === k;
      if (want('sft')) parts.sft = tj.buildSFT(entries, opts);
      if (want('atropos')) parts.atropos = tj.buildAtropos(entries, opts);
      if (want('lessons')) parts.lessons = tj.buildLessons(ledger, opts);
      if (!Object.keys(parts).length) { console.error('✗ unknown --format ' + fmt + ' (use sft|atropos|lessons|all)'); process.exit(1); }
      let totalRec = 0;
      for (const [k, v] of Object.entries(parts)) {
        const file = path.join(out, k + '.jsonl');
        try { fs.writeFileSync(file, tj.toJSONL(v.records)); } catch (e) { console.error('✗ write failed: ' + (e && e.message)); process.exit(1); }
        totalRec += v.records.length;
        console.log(gold('✓ ') + k + dim(' → ') + file + dim('  (' + v.records.length + ' records, ' + v.redactions + ' redactions)'));
      }
      const man = tj.manifest(parts, opts);
      fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(man, null, 2));
      console.log(gold('✓ manifest → ') + path.join(out, 'manifest.json'));
      console.log(dim('  ' + totalRec + ' records · ' + man.totalRedactions + ' secrets redacted · provenance: ') + gold('urfael audit --verify'));
      if (!opts.redact) console.log(dim('  ⚠ --no-redact: secrets are NOT stripped from this export. Review before sharing.'));
      return;
    }

    console.log('usage: urfael dataset [stats | export --format sft|atropos|lessons|all [--since <date>] [--channel <name>] [--model opus|sonnet] [--out <dir>] [--no-redact]]');
    return;
  }

  // coding mode: Claude Code in YOUR repo with Urfael's layers, per-project memory + auto-checkpoint + a rewind.
  // The brain is the claude CLI; this wraps a coding session so it (a) remembers each repo, (b) snapshots the working
  // tree (tracked + untracked, the set `git add -A` stages) before it touches anything, and (c) lets you undo. The
  // CHECKPOINT is pure git surgery on a private shadow ref: it never touches your branch, index, or working tree.
  // Rewind deliberately rewrites your working tree (then unstages, leaving only worktree changes), and is itself
  // reversible. Runs BEFORE ensureDaemon (it spawns its own claude in the repo).
  if (cmd === 'code' || cmd === 'rewind' || cmd === 'checkpoints') {
    const proj = require('./project');
    const ckpt = require('./checkpoint');
    const { spawnSync } = require('child_process');
    const dirArg = flag(rest, '--dir');
    const dir = path.resolve(dirArg || process.cwd());
    let root;
    try { root = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
    catch { console.error('✗ ' + dir + ' is not a git repo. `urfael code` needs one (run `git init` first) so it can checkpoint and rewind safely.'); process.exit(1); }
    const gitc = (a) => { try { return execFileSync('git', ['-C', root, ...a], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 24 }).toString(); } catch { return ''; } };
    const hasHead = () => { try { execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { stdio: 'ignore' }); return true; } catch { return false; } };

    // snapshot the working tree (tracked + untracked, the set `git add -A` stages) onto refs/urfael/checkpoints/<id>
    // via a temp index, so it captures that set yet touches nothing live. Gitignored files (e.g. .env) are deliberately
    // NOT included, so secrets never land in a shadow ref. Returns the commit sha, or '' if git refused.
    function snapshot(id, task) {
      const idx = path.join(os.tmpdir(), 'urfael-cpidx-' + process.pid + '-' + id);
      const genv = { ...process.env, GIT_INDEX_FILE: idx }; delete genv.ELECTRON_RUN_AS_NODE;
      try {
        if (hasHead()) execFileSync('git', ['-C', root, 'read-tree', 'HEAD'], { env: genv, stdio: 'ignore' });
        execFileSync('git', ['-C', root, 'add', '-A'], { env: genv, stdio: 'ignore' });
        const tree = execFileSync('git', ['-C', root, 'write-tree'], { env: genv, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const parents = hasHead() ? ['-p', gitc(['rev-parse', 'HEAD']).trim()] : [];
        const commit = execFileSync('git', ['-C', root, 'commit-tree', tree, ...parents, '-m', ckpt.msgFor(id, task)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        execFileSync('git', ['-C', root, 'update-ref', ckpt.ref(id), commit], { stdio: 'ignore' });
        return commit;
      } catch { return ''; } finally { try { fs.rmSync(idx, { force: true }); } catch {} }
    }
    const listCheckpoints = () => ckpt.parseList(gitc(['for-each-ref', '--sort=-creatordate', '--format=' + ckpt.LIST_FORMAT, ckpt.REF_PREFIX]));

    if (cmd === 'checkpoints') {
      const rows = listCheckpoints();
      if (!rows.length) { console.log(dim('no checkpoints in this repo yet. `urfael code "<task>"` takes one before each turn.')); return; }
      console.log(gold('Checkpoints') + dim('  (' + path.basename(root) + ')'));
      for (const r of rows) console.log('  ' + gold(r.id.padEnd(14)) + dim((r.date.slice(0, 16).replace('T', ' ')) + '  ') + r.task);
      console.log(dim('\n  rewind:  ') + gold('urfael rewind <id>') + dim('   restores your files to that snapshot (files created since are kept)'));
      return;
    }

    if (cmd === 'rewind') {
      const rows = listCheckpoints();
      if (!rows.length) { console.error('✗ no checkpoints to rewind to in this repo'); process.exit(1); }
      const want = rest.find((a) => !a.startsWith('--') && a !== dirArg);
      const target = want ? rows.find((r) => r.id === want) : rows[0];
      if (!target) { console.error('✗ no checkpoint "' + want + '" here. Run `urfael checkpoints`.'); process.exit(1); }
      console.log(dim('rewind ' + path.basename(root) + ' → ') + gold(target.id) + dim('  "' + target.task + '"  (' + target.date.slice(0, 16).replace('T', ' ') + ')'));
      if (!rest.includes('--yes') && !(await promptYesNo('This restores your tracked files to that snapshot. The current state is checkpointed first, so it is undoable. Proceed?'))) { console.log(dim('aborted')); return; }
      // checkpoint the current state first so the rewind is itself reversible. If that fails, REFUSE: overwriting the
      // working tree with no way back would betray the undo promise. --force overrides for the rare deliberate case.
      const back = ckpt.newId();
      const backSha = snapshot(back, 'before rewind to ' + target.id);
      if (!backSha && !rest.includes('--force')) { console.error('✗ could not checkpoint the current state, so a rewind would be irreversible. Refusing. Re-run with --force to override.'); process.exit(1); }
      // the files present now but absent from the snapshot, the ones a restore KEEPS. Computed BEFORE the checkout and
      // untracked-aware (git diff would not see new untracked files), so the report is actually true.
      const inSnap = new Set(gitc(['ls-tree', '-r', '--name-only', target.sha]).split('\n').filter(Boolean));
      const nowFiles = new Set(gitc(['ls-files']).split('\n').concat(gitc(['ls-files', '--others', '--exclude-standard']).split('\n')).filter(Boolean));
      const kept = [...nowFiles].filter((f) => !inSnap.has(f));
      try { execFileSync('git', ['-C', root, 'checkout', target.sha, '--', '.'], { stdio: ['ignore', 'ignore', 'inherit'] }); }
      catch (e) { console.error('✗ rewind failed: ' + ((e && e.message) || e)); process.exit(1); }
      if (hasHead()) { try { execFileSync('git', ['-C', root, 'reset', '-q'], { stdio: 'ignore' }); } catch {} }   // unstage, so only the working tree differs (the index is left as it was)
      console.log(gold('✓ restored to ' + target.id));
      if (kept.length) console.log(dim('  ' + kept.length + ' file(s) created since the snapshot were KEPT (not deleted): ') + kept.slice(0, 8).join(', ') + (kept.length > 8 ? ' …' : ''));
      if (backSha) console.log(dim('  undo this rewind:  ') + gold('urfael rewind ' + back));
      return;
    }

    // urfael code "<task>"
    const task = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--dir').join(' ').trim();
    if (!task) { console.error('usage: urfael code "<task>" [--dir <path>] [--no-checkpoint] [--no-memory] [--no-run]'); process.exit(1); }
    const remote = gitc(['remote', 'get-url', 'origin']).trim();
    const id = proj.idFor(root, remote);
    const pmem = proj.memDir(MEMORY_DIR, id);
    let conventions = '';
    if (!rest.includes('--no-memory')) {
      try { fs.mkdirSync(pmem, { recursive: true }); } catch {}
      const cpath = path.join(pmem, proj.CONVENTIONS);
      try { conventions = fs.readFileSync(cpath, 'utf8'); } catch { try { fs.writeFileSync(cpath, proj.conventionsTemplate(id)); } catch {} }
    }
    let cpId = '';
    if (!rest.includes('--no-checkpoint')) { cpId = ckpt.newId(); if (!snapshot(cpId, task)) { console.error(dim('  (could not checkpoint, proceeding without one)')); cpId = ''; } }
    const ctx = proj.contextBlock(conventions);
    const prompt = (ctx ? ctx + '\n\n' : '') + task;
    console.log(gold('● urfael code') + dim('  repo ' + path.basename(root) + '  ·  memory ' + id + (cpId ? '  ·  checkpoint ' + cpId : '  ·  no checkpoint')));
    if (!rest.includes('--no-run')) {                                            // --no-run: just checkpoint + load memory, skip the brain
      const cenv = { ...process.env }; delete cenv.ELECTRON_RUN_AS_NODE;
      // `--` so a task that begins with a dash (e.g. "-c") is always the prompt, never parsed as a claude flag.
      spawnSync('claude', ['--', prompt], { cwd: root, stdio: 'inherit', env: cenv });
    }
    // record the session: a HISTORY.md entry + an append-only code-log line, both in the git-versioned memory repo.
    if (!rest.includes('--no-memory')) {
      try { fs.appendFileSync(path.join(pmem, proj.HISTORY), proj.historyEntry(task, '', cpId, new Date().toISOString())); } catch {}
      try { fs.appendFileSync(path.join(pmem, 'code-log.jsonl'), JSON.stringify({ at: new Date().toISOString(), task: task.slice(0, 300), checkpoint: cpId, root }) + '\n'); } catch {}
    }
    console.log('');
    if (cpId) console.log(dim('  undo this session:  ') + gold('urfael rewind ' + cpId) + dim('   ·   all:  ') + gold('urfael checkpoints'));
    console.log(dim('  teach it about this repo:  ') + gold(path.join(pmem, proj.CONVENTIONS).replace(os.homedir(), '~')));
    return;
  }

  // skills: a paranoid share/install hub for VAULT/_urfael/skills/. Pure CLI — no brain needed, runs
  // BEFORE ensureDaemon. Install never executes a skill; it only stores the markdown after you confirm.
  if (cmd === 'skills') {
    const hub = require('./skillhub');
    const sub = rest[0];
    if (sub === 'list') {
      const skills = hub.listLocal();
      if (!skills.length) { console.log(dim('no skills installed yet')); return; }
      for (const s of skills) console.log(gold(s.slug) + (s.desc ? '  ' + dim(s.desc) : ''));
      return;
    }
    if (sub === 'export' && rest[1]) { if (!hub.exportSkill(rest[1])) { console.error('✗ no such skill: ' + rest[1]); process.exit(1); } return; }
    if (sub === 'scan' && rest[1]) {
      let text = ''; try { text = fs.readFileSync(rest[1], 'utf8'); } catch (e) { console.error('✗ cannot read ' + rest[1] + ': ' + (e && e.message || e)); process.exit(1); }
      const result = hub.scan(text);
      const { flags } = result;
      if (!flags.length) console.log(gold('✓ scan clean') + dim(' — no dangerous patterns found (still your call)'));
      else {
        const dangers = flags.filter((f) => f.level === 'danger').length;
        console.log((dangers ? gold('⚠ ' + dangers + ' DANGER') + dim(' + ' + (flags.length - dangers) + ' warn') : gold('⚠ ' + flags.length + ' warning')) + dim(' flag(s):'));
        for (const f of flags) console.log('  ' + (f.level === 'danger' ? gold('[DANGER]') : dim('[warn]  ')) + ' ' + f.why + (f.sample ? dim('  «' + f.sample + '»') : ''));
      }
      // Capability footprint + structured verdict — mirrors the install preview so a pre-install `scan` shows the
      // exact same "what would this touch" view. Single scanner: this is scan()'s own output, not a second pass.
      const caps = hub.capabilityLines(result);
      console.log(gold('  capabilities ') + dim(caps.length ? caps.join(', ') : 'none - inert markdown, runs nothing on its own'));
      console.log(gold('  verdict      ') + (result.verdict === 'block' ? gold(result.verdict) : dim(result.verdict)));
      // gate on the structured verdict, not just dangers: block already implies dangers>0 OR score>=9, so this is
      // strictly stronger (it also catches the warn-only score>=9 pile-up scan() already treats as block).
      if (result.verdict === 'block') process.exit(1); // non-zero exit so scripts/pipelines can gate on a dirty scan
      return;
    }
    if (sub === 'install' && rest[1]) { const r = await hub.installFromUrl(rest[1], { yes: rest.includes('--yes') }); if (!r.ok) process.exit(1); return; }
    console.log('usage: urfael skills list | export <name> | scan <file> | install <https-url> [--yes]');
    return;
  }

  // hub: the safe skill registry. Browse/search/install BY SLUG — every install runs the scanner + integrity
  // (sha256) + full preview, and never executes a skill. Pure CLI, runs BEFORE ensureDaemon.
  if (cmd === 'hub') {
    const hub = require('./skillhub');
    const sub = rest[0];
    if (sub === 'install' && rest[1]) { const r = await hub.hubInstall(rest[1], { yes: rest.includes('--yes') }); if (!r.ok) process.exit(1); return; }
    if (sub === 'publish' && rest[1]) {
      const e = hub.entryFor(rest[1]);
      if (!e) { console.error('✗ could not read ' + rest[1]); process.exit(1); }
      console.log(dim('Add this entry to your registry index.json (set the real url + author), then PR it:'));
      console.log(JSON.stringify(e, null, 2));
      return;
    }
    // default + search: browse the registry
    let entries; try { entries = await hub.fetchIndex(); } catch (e) { console.error('✗ could not fetch the registry (' + ((e && e.message) || e) + '). Set URFAEL_HUB_INDEX to your index.json.'); process.exit(1); }
    if (sub === 'search' && rest[1]) entries = hub.searchEntries(entries, rest.slice(1).join(' '));
    if (!entries.length) { console.log(dim('no skills in the registry (or none matched)')); return; }
    const installed = new Set(hub.listLocal().map((s) => s.slug));
    console.log(gold('Skill hub') + dim('  ·  ' + hub.hubIndexUrl()));
    for (const e of entries.slice(0, 60)) {
      const mark = installed.has(e.slug) ? gold('✓') : ' ';
      const pin = e.sha256 ? '' : dim(' (unpinned)');
      console.log(`  ${mark} ${gold(e.slug.padEnd(22))} ${dim((e.description || e.title).slice(0, 50))}${pin}`);
    }
    console.log(dim('install:  urfael hub install <slug>   ·   each install is scanned + sha-checked + previewed, never executed'));
    return;
  }

  // connect: optional MCP connectors, set up the Urfael way. A connector is an MCP server — the open standard the
  // brain already speaks. `add` shows a pre-enable security preview + a static scan, prompts for any secret WITHOUT
  // echoing it (and passes it to claude as an execFile argv element, so it never reaches the shell history), and
  // only writes after you confirm. Connectors load on OWNER turns only — every sandbox spawn is --strict-mcp-config.
  // Pure CLI, runs BEFORE ensureDaemon. The full ecosystem (thousands of servers) also works via `claude mcp add`.
  if (cmd === 'connect' || cmd === 'connectors') {
    const con = require('./connectors');
    const { VAULT } = require('./setup');
    const list = con.load();
    const sub = rest[0];

    // active connectors come from the brain's own config, not our guess
    if (sub === 'installed' || sub === 'active' || sub === 'doctor') {
      try { execFileSync('claude', ['mcp', 'list'], { stdio: 'inherit', cwd: VAULT }); }
      catch { console.error('✗ could not run `claude mcp list` — is the Claude CLI installed and on PATH?'); process.exit(1); }
      return;
    }
    if ((sub === 'info' || sub === 'show') && rest[1]) {
      const e = con.find(list, rest[1]);
      if (!e) { console.error('✗ no connector "' + rest[1] + '". Try: urfael connect search <term>'); process.exit(1); }
      printConnectorPreview(con, e);
      console.log('\n' + dim('add it:  ') + gold('urfael connect add ' + e.id));
      return;
    }
    if (sub === 'add' && rest[1]) {
      const e = con.find(list, rest[1]);
      if (!e) { console.error('✗ no connector "' + rest[1] + '". Try: urfael connect search <term>'); process.exit(1); }
      printConnectorPreview(con, e);
      const danger = con.scan(e).flags.some((f) => f.level === 'danger');
      const secrets = {};
      for (const f of con.secretsNeeded(e)) {                                  // masked prompt per secret; abort if blank
        const v = await promptSecret('   ' + f.label + ': ');
        if (!v) { console.log(dim('aborted — no value entered for ' + f.key)); return; }
        secrets[f.key] = v;
      }
      const ok = await promptYesNo('\nAdd this connector?' + (danger ? gold(' (DANGER flags present!)') : ''));
      if (!ok) { console.log(dim('aborted — nothing added')); return; }
      let args; try { args = con.buildAddArgs(e, secrets); } catch (err) { console.error('✗ ' + ((err && err.message) || err)); process.exit(1); }
      try { execFileSync('claude', args, { stdio: 'inherit', cwd: VAULT }); }  // execFile array → secrets never hit the shell / history
      catch (err) { console.error('✗ `claude mcp add` failed: ' + ((err && err.message) || err)); process.exit(1); }
      console.log(gold('✓ connected ') + e.name + dim('  — owner turns only; sandboxed turns never load it'));
      if (e.auth === 'oauth') console.log(dim('  next time you use it on an owner turn, Claude opens the browser to authorize — no key is stored here.'));
      return;
    }
    if ((sub === 'remove' || sub === 'rm') && rest[1]) {
      const e = con.find(list, rest[1]) || { id: con.slugify(rest[1]) };
      try { execFileSync('claude', con.buildRemoveArgs(e), { stdio: 'inherit', cwd: VAULT }); }
      catch (err) { console.error('✗ remove failed: ' + ((err && err.message) || err)); process.exit(1); }
      console.log(gold('✓ removed ') + e.id);
      return;
    }
    // default + search: browse the curated registry, grouped by category
    let entries = list;
    if (sub === 'search' && rest[1]) entries = con.search(list, rest.slice(1).join(' '));
    if (!entries.length) { console.log(dim('no connectors matched')); return; }
    console.log(gold('Connectors') + dim('  ·  optional MCP integrations — previewed + scanned + secrets masked, owner turns only'));
    for (const [cat, items] of con.categories(entries)) {
      console.log('\n' + dim(cat));
      for (const e of items) {
        const tag = (e.transport === 'http' || e.transport === 'sse') ? (e.auth === 'oauth' ? dim('oauth') : dim('remote')) : dim('local');
        const v = e.verified ? '' : gold(' •unverified');
        console.log('  ' + gold(e.id.padEnd(20)) + ' ' + dim((e.note || e.name).slice(0, 44)).padEnd(0) + ' ' + tag + v);
      }
    }
    console.log('\n' + dim('details:  ') + gold('urfael connect info <id>') + dim('   ·   add:  ') + gold('urfael connect add <id>') + dim('   ·   active:  ') + gold('urfael connect installed'));
    console.log(dim('beyond this curated set, the whole MCP ecosystem (thousands of servers) also works via ') + gold('claude mcp add'));
    return;
  }

  // plugin: capability-scoped, sandboxed, signed extensions. v1 = the verified inspect pipeline (parse + static
  // scan + the capability preview + the exact --network none cell command). A plugin is loaded as DATA and only
  // ever runs as an MCP server inside the cell on OWNER turns; it never enters the daemon and never opens a port.
  // Live runtime enablement (the cell attach + the egress/secret brokers) is the next increment (docs/PLUGINS.md).
  if (cmd === 'plugin' || cmd === 'plugins') {
    const ph = require('./pluginhub');
    const sub = rest[0];
    if ((sub === 'scan' || sub === 'info' || sub === 'show') && rest[1]) {
      const m = ph.load(rest[1]);
      if (!m) { console.error('✗ not a valid plugin manifest (urfael.plugin/v1): ' + rest[1]); process.exit(1); }
      printPluginPreview(ph, m);
      if (sub === 'scan') {
        const { flags } = ph.scanBundle(m);
        if (!flags.length) console.log(gold('✓ scan clean') + dim(' — no dangerous patterns found (still your call)'));
        else {
          const d = flags.filter((f) => f.level === 'danger').length;
          console.log((d ? gold('⚠ ' + d + ' DANGER') + dim(' + ' + (flags.length - d) + ' warn') : gold('⚠ ' + flags.length + ' warning')) + dim(' flag(s):'));
          for (const f of flags) console.log('  ' + (f.level === 'danger' ? gold('[DANGER]') : dim('[warn]  ')) + ' ' + f.why + (f.sample ? dim('  «' + f.sample + '»') : ''));
          if (d) process.exit(1);
        }
      } else {
        console.log(dim('   signature ') + (m.signature ? dim('present (the ed25519 verify primitive ships + is tested; publisher-key verification at install is the next increment)') : gold('UNSIGNED')) + dim('   integrity: the manifest is sha-pinned at install and re-checked at enable'));
      }
      return;
    }
    // install — pure six-gate (parse -> scan -> preview -> consent -> write bundle + grant 0600, DISABLED). No daemon.
    if (sub === 'install' && rest[1]) {
      const m = ph.load(rest[1]);
      if (!m) { console.error('✗ not a valid plugin manifest (urfael.plugin/v1): ' + rest[1]); process.exit(1); }
      const { flags } = ph.scanBundle(m);
      printPluginPreview(ph, m);
      const danger = flags.some((f) => f.level === 'danger');
      if (flags.length) { const d = flags.filter((f) => f.level === 'danger').length; console.log((d ? gold('⚠ ' + d + ' DANGER') : gold('⚠ ' + flags.length + ' warning')) + dim(' flag(s):')); for (const f of flags) console.log('  ' + (f.level === 'danger' ? gold('[DANGER]') : dim('[warn]  ')) + ' ' + f.why); }
      else console.log(gold('✓ scan clean'));
      if (danger) { console.error('✗ refusing to install: the static scan flagged DANGER'); process.exit(1); }
      const ok = await promptYesNo('Install plugin "' + m.id + '"? (installed DISABLED; you enable it separately)');
      if (!ok) { console.log(dim('aborted — nothing written')); return; }
      const dir = path.join(ph.PLUGINS_DIR, m.id);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(m, null, 2), { mode: 0o600 });
        const grant = { id: m.id, enabled: false, caps: ph.grantFromManifest(m), manifestSha: ph.sha256(Buffer.from(JSON.stringify(m))) };
        fs.writeFileSync(path.join(dir, 'grant.json'), JSON.stringify(grant, null, 2), { mode: 0o600 });
      } catch (e) { console.error('✗ write failed: ' + ((e && e.message) || e)); process.exit(1); }
      console.log(gold('✓ installed ') + m.id + dim(' (disabled) — enable with: ') + gold('urfael plugin enable ' + m.id));
      if (m.hostReaching) console.log(dim('  note: requests host capabilities (fs/net/secret); brain-tools plugins enable today, host-reaching tiers land with the cell + broker.'));
      return;
    }
    // import — bring an OpenClaw/Hermes plugin onto Urfael safely: read its manifest as DATA, scan, map to a
    // capability-scoped draft (or refuse with a reason), dry-run by default. Never executes foreign code.
    if (sub === 'import' && rest[1]) {
      const r = await require('./plugin-import').run({ from: flag(rest, '--from'), path: rest[1], apply: rest.includes('--apply'), force: rest.includes('--force') });
      if (r && r.error) process.exit(1);
      return;
    }
    // secret — set a plugin secret BY REFERENCE (masked; stored 0600; used only by a brokerd to inject into a granted host)
    if (sub === 'secret' && rest[1]) {
      const ref = String(rest[1]);
      if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(ref)) { console.error('✗ a secret ref is UPPER_SNAKE (e.g. STRIPE_KEY)'); process.exit(1); }
      const v = await promptSecret('   ' + ref + ': ');
      if (!v) { console.log(dim('aborted — no value entered')); return; }
      if (!await ensureDaemon()) { console.error('✗ daemon unreachable'); process.exit(1); }
      const r = await req('POST', '/secret/' + ref, { value: v }).catch(() => ({ ok: false }));
      if (!r || !r.ok) { console.error('✗ failed to store secret'); process.exit(1); }
      console.log(gold('✓ stored ') + ref + dim('  (0600; a plugin uses it by reference only and never sees the value)'));
      return;
    }
    // enable / disable / list — via the daemon (re-verifies, attaches/detaches the plugin's MCP server on the warm sessions)
    if ((sub === 'enable' || sub === 'disable') && rest[1]) {
      if (!await ensureDaemon()) { console.error('✗ daemon unreachable'); process.exit(1); }
      const r = await req('POST', '/plugin/' + ph.slugify(rest[1]) + '/' + sub).catch(() => ({ ok: false, error: 'request failed' }));
      if (!r || !r.ok) { console.error('✗ ' + ((r && r.error) || 'failed')); process.exit(1); }
      if (sub === 'enable') console.log(gold('✓ enabled ') + rest[1] + ((r.tools && r.tools.length) ? dim('  tools: ' + r.tools.join(', ')) : ''));
      else console.log(gold('✓ disabled ') + rest[1]);
      return;
    }
    if (sub === 'list') {
      if (!await ensureDaemon()) { console.error('✗ daemon unreachable'); process.exit(1); }
      const r = await req('GET', '/plugins').catch(() => ({ plugins: [] }));
      const list = (r && r.plugins) || [];
      if (!list.length) { console.log(dim('no plugins installed — ') + gold('urfael plugin install <file>')); return; }
      for (const p of list) console.log('  ' + (p.enabled ? gold('●') : dim('○')) + ' ' + gold(p.id.padEnd(20)) + ' ' + dim('v' + p.version) + (p.hostReaching ? gold('  host-reaching') : '') + ((p.tools && p.tools.length) ? dim('  [' + p.tools.length + ' tools]') : ''));
      console.log(dim('  ● enabled  ○ installed   ·   ') + gold('urfael plugin enable <id>'));
      return;
    }
    console.log(gold('Plugins') + dim('  ·  capability-scoped, sandboxed, signed MCP extensions'));
    console.log(dim('  A plugin is loaded as DATA, never run inside the daemon, and only ever runs as an MCP server'));
    console.log(dim('  in a --network none Docker cell on OWNER turns. Zero capability by default: every power is'));
    console.log(dim('  declared, then granted by you, then compiled into the sandbox. It never opens a port.'));
    console.log('');
    console.log(dim('  install + enable:  ') + gold('urfael plugin install ./plugin.json') + dim('  →  ') + gold('urfael plugin enable <id>'));
    console.log(dim('  inspect first:  ') + gold('urfael plugin scan ./plugin.json') + dim('   ·   list:  ') + gold('urfael plugin list'));
    console.log(dim('  the design + the v1 / next-increment split:  ') + gold('docs/PLUGINS.md'));
    return;
  }

  // quickstart: the fast path. Connects you (or skips), then shows the moat. Pure CLI, runs BEFORE ensureDaemon.
  if (cmd === 'quickstart' || cmd === 'quick') { await require('./quickstart').run(); return; }
  // setup: the onboarding wizard (auth mode + provider config). Pure CLI, runs BEFORE ensureDaemon.
  if (cmd === 'setup' || cmd === 'init' || cmd === 'onboard') { await require('./setup').run(); return; }
  // radar: scan rival agents (Hermes, OpenClaw) for new releases worth borrowing; writes a report to approve. Pure CLI.
  if (cmd === 'radar') {
    const radar = require('./radar'); const setup = require('./setup');
    // OWNER-ONLY tool, off by default. A downloaded copy never runs a competitor scan unless the owner opts in.
    const _renv = (() => { try { return setup.readEnv(); } catch { return {}; } })();
    const radarOn = /^(1|on|true)$/i.test(process.env.URFAEL_RADAR || _renv.URFAEL_RADAR || '') || (parseInt(process.env.URFAEL_RADAR_DAYS || _renv.URFAEL_RADAR_DAYS, 10) || 0) > 0;
    if (!radarOn) { console.log(dim('radar is an owner-only competitor watch, off by default. Enable it with ') + gold('URFAEL_RADAR=1') + dim(' in ~/.claude/urfael/provider.env.')); return; }
    const claudeBin = setup.claudePath();
    if (!claudeBin) { console.error(bad('✗') + ' the claude CLI is required for the analysis. ' + dim('Install Claude Code first: https://claude.com/claude-code')); process.exit(1); }
    process.stdout.write(dim('scanning rival releases (Hermes, OpenClaw) for anything worth borrowing…\n'));
    const r = await radar.run({ claudeBin, env: { ...process.env, ...setup.readEnv() } });
    if (!r.analyzed) console.log(gold('✓ no new rival releases') + dim('  (watching ' + r.repos.join(', ') + '; needs `gh` installed + authed)'));
    else {
      console.log(gold('✓ analyzed ' + r.analyzed + ' new release' + (r.analyzed === 1 ? '' : 's')) + dim('  →  ') + (r.reportPath || '(report write failed)')); console.log(dim('  Review + approve in the dashboard (Radar), or open the file above. I implement the approved items.'));
      // notify the owner when run by the daily launchd cron, so a new report is never silently buried in a log. macOS only; fail-soft.
      if (process.platform === 'darwin') { try { const msg = 'Radar: ' + r.analyzed + ' new rival release' + (r.analyzed === 1 ? '' : 's') + ' to review'; require('child_process').spawn('osascript', ['-e', 'display notification "' + msg.replace(/["\\]/g, "'") + '" with title "Urfael"'], { stdio: 'ignore' }).unref(); } catch {} }
    }
    return;
  }

  // stop is best-effort BEFORE ensureDaemon — never spawn a brain just to abort nothing
  if (cmd === 'stop') { const r = await req('POST', '/abort').catch(() => ({ ok: false })); console.log(r && r.ok ? gold('stopped') : dim('nothing to stop')); return; }

  // import: pull memory + skills from an OpenClaw/Hermes install. Pure CLI (no brain); dry-run unless --apply.
  if (cmd === 'import') {
    const from = flag(rest, '--from'), srcPath = flag(rest, '--path');
    const r = await require('./import').run({ from, path: srcPath, apply: rest.includes('--apply'), force: rest.includes('--force') });
    if (r && r.error) process.exit(1);
    return;
  }

  // serve: ensure the OpenAI-compatible local API is up (spawn detached if not), print its base URL + token path.
  // Runs BEFORE ensureDaemon — the API server manages its own lifecycle and proxies the brain on demand.
  if (cmd === 'serve') {
    const port = parseInt(process.env.URFAEL_API_PORT, 10) || 7720;
    const up = () => new Promise((r) => { const s = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/v1/models', timeout: 800 }, (res) => { res.resume(); r(true); }); s.on('error', () => r(false)); s.on('timeout', () => { s.destroy(); r(false); }); s.end(); });
    if (!(await up())) { try { const p = spawn(process.execPath, [APISERVER], { detached: true, stdio: 'ignore' }); p.unref(); } catch {} for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 300)); if (await up()) break; } }
    console.log(gold(`http://127.0.0.1:${port}/v1`) + dim('  (OpenAI-compatible · localhost only · bearer-token gated)'));
    if (rest.includes('--token')) { try { console.log('  API key: ' + gold(fs.readFileSync(APITOKENF, 'utf8').trim())); } catch { console.error('  (no token yet)'); } }
    else console.log(dim('  API key: the token in ' + APITOKENF + ' (run `urfael serve --token` to print it)'));
    return;
  }

  // dashboard: ensure the standalone localhost console is up (spawn detached if not), then print its tokened URL.
  // Runs BEFORE ensureDaemon — the dashboard manages its own lifecycle and proxies the brain on demand.
  if (cmd === 'dashboard') {
    const port = parseInt(process.env.URFAEL_DASHBOARD_PORT, 10) || 7717;
    const up = () => new Promise((r) => { const s = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/', timeout: 800 }, (res) => { res.resume(); r(true); }); s.on('error', () => r(false)); s.on('timeout', () => { s.destroy(); r(false); }); s.end(); });
    if (!(await up())) { try { const p = spawn(process.execPath, [DASHBOARD], { detached: true, stdio: 'ignore' }); p.unref(); } catch {} for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 300)); if (await up()) break; } }
    let tok = ''; try { tok = fs.readFileSync(TOKENF, 'utf8').trim(); } catch {}
    if (!tok) { console.error('✗ dashboard not reachable (no token yet)'); process.exit(1); }
    console.log(gold(`http://127.0.0.1:${port}/?token=${tok}`));
    console.log(dim('  localhost only · token-gated · open this URL in your browser'));
    return;
  }

  // hooks: ensure the loopback webhook receiver is up (spawn detached if not), print its base URL. Runs BEFORE
  // ensureDaemon — it manages its own lifecycle and proxies the daemon socket on demand. OFF until you run this.
  if (cmd === 'hooks') {
    const port = parseInt(process.env.URFAEL_HOOKS_PORT, 10) || 7718;
    const HOOKS = path.join(__dirname, 'hooks.js');
    const up = () => new Promise((r) => { const s = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/', timeout: 800 }, (res) => { res.resume(); r(true); }); s.on('error', () => r(false)); s.on('timeout', () => { s.destroy(); r(false); }); s.end(); });
    if (!(await up())) { try { const p = spawn(process.execPath, [HOOKS], { detached: true, stdio: 'ignore' }); p.unref(); } catch {} for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 300)); if (await up()) break; } }
    console.log(gold(`http://127.0.0.1:${port}/hook/<id>`) + dim('  (webhook receiver · localhost only · per-hook secret)'));
    console.log(dim('  register a hook:  ') + gold('urfael hook add "my trigger"'));
    console.log(dim('  external events:  point your own tunnel (cloudflared / ngrok / ssh -R) at this port'));
    return;
  }

  // doctor: a one-card health read — every red line carries its own one-command fix. Pure CLI, runs BEFORE
  // ensureDaemon so it can diagnose a DOWN brain rather than spawn one. Reads only real, local state.
  if (cmd === 'doctor') {
    const { has, claudePath, VAULT, readEnv } = require('./setup');
    const probe = (p) => req('GET', p).catch(() => null);     // never spawns the brain; null if it's down
    let healthy = 0, attention = 0;
    const rows = [], checks = [];
    const noAnsi = (s) => String(s == null ? '' : s).replace(/\x1b\[[0-9;]*m/g, '').trim();
    const add = (good, glyph, label, detail, fix) => {
      good ? healthy++ : attention++;
      rows.push('  ' + glyph + '  ' + label.padEnd(11) + ' ' + detail);
      if (!good && fix) rows.push('       ' + dim('↳ ' + fix));
      checks.push({ component: noAnsi(label), ok: !!good, detail: noAnsi(detail), ...(good ? {} : { fix }) });
    };
    const note = (label, detail) => { rows.push('  ' + dim('·') + '  ' + label.padEnd(11) + ' ' + dim(detail)); checks.push({ component: noAnsi(label), ok: true, detail: noAnsi(detail), note: true }); };
    // 1) the engine — Claude Code on PATH
    const cb = claudePath();
    add(!!cb, cb ? ok('✓') : bad('✗'), 'claude CLI', cb ? dim(cb) : bad('not found on PATH'), 'install Claude Code — https://claude.com/claude-code');
    // 2) the brain — probe the socket without spawning
    const h = await probe('/health');
    add(!!(h && h.ok), h && h.ok ? ok('✓') : warn('!'), 'brain', h && h.ok ? dim('warm · ' + ((h.warm || []).join(', ') || 'idle')) : warn('asleep'), 'wake it:  urfael status');
    // 3) the vault — exists + writable + scaffolded
    const vEx = fs.existsSync(VAULT); let vW = false; try { fs.accessSync(VAULT, fs.constants.W_OK); vW = true; } catch {}
    add(vEx && vW, vEx && vW ? ok('✓') : bad('✗'), 'vault', vEx ? (vW ? dim(VAULT) : bad('not writable')) : bad('missing'), 'scaffold it:  ./install.sh');
    // 4) memory — readable AND WRITABLE + versioned. This is the exact class of bug that shipped silently once.
    const mEx = fs.existsSync(MEMORY_DIR), mGit = fs.existsSync(path.join(MEMORY_DIR, '.git')); let mW = false; try { fs.accessSync(MEMORY_DIR, fs.constants.W_OK); mW = true; } catch {}
    const memOk = mEx && mGit && mW;
    add(memOk, memOk ? ok('✓') : bad('✗'), 'memory', memOk ? dim(MEMORY_DIR + ' · writable, versioned') : bad(!mEx ? 'missing' : !mGit ? 'not a git repo' : 'not writable'), 'fix:  ./install.sh   (creates + git-inits ~/Urfael-memory)');
    // 5) provider — how it reaches Claude (always "ok"; just surfaces the mode)
    const env = readEnv();
    const pmode = env.ANTHROPIC_BASE_URL ? 'local model / proxy' : env.ANTHROPIC_API_KEY ? 'API key (pay-per-token)' : 'Claude subscription';
    add(true, ok('✓'), 'provider', dim(pmode) + dim('   ·   change with  urfael setup'));
    // 6) persona — the {{PLACEHOLDER}} fill that everyone used to forget
    let leftover = false; try { leftover = /\{\{(USER_NAME|CITY|TIMEZONE|LANGUAGE)\}\}/.test(fs.readFileSync(path.join(VAULT, 'CLAUDE.md'), 'utf8')); } catch {}
    add(!leftover, leftover ? warn('!') : ok('✓'), 'persona', leftover ? warn('placeholders not filled in') : dim('Urfael knows who it serves'), 'fill them:  urfael setup');
    // 7) ledger + seal — only meaningful while the brain is up
    if (h && h.ok) {
      const lv = await probe('/audit/verify');
      add(!!(lv && lv.ok), lv && lv.ok ? ok('✓') : bad('✗'), 'ledger', lv && lv.ok ? dim('tamper-evident chain intact · ' + (lv.count || 0) + ' entries') : bad('TAMPERED at seq ' + (lv && lv.brokenSeq)), 'investigate:  urfael audit --verify');
      const sv = await probe('/seal/verify');
      if (sv && sv.reason !== 'no_seal') add(!!(sv && sv.ok), sv && sv.ok ? ok('✓') : bad('✗'), 'seal', sv && sv.ok ? dim('owner key ' + sv.fp + ' · sealed through seq ' + sv.seq) : bad('does not verify'), 'reseal:  urfael seal');
      else note('seal', 'unsealed (optional) — mint one:  urfael seal');
    } else { note('ledger', '— brain asleep; start it to check the ledger + seal'); }
    if (rest.includes('--json')) { console.log(JSON.stringify({ ok: attention === 0, healthy, attention, checks }, null, 2)); return; }
    const head = attention === 0
      ? ok('✓ all ' + healthy + ' systems nominal')
      : ok(healthy + ' healthy') + dim(' · ') + warn(attention + (attention === 1 ? ' needs' : ' need') + ' attention');
    console.log(frame('urfael doctor', [head, '', ...rows]));
    return;
  }

  if (!(await ensureDaemon())) { console.error(bad('✗') + ' I could not wake the brain, sir.' + dim('   run  ') + gold('urfael doctor') + dim('  to see why, or check  ~/.claude/urfael/daemon.log')); process.exit(1); }
  // Register this terminal so other Urfael sessions can see it, then heartbeat on an unref'd interval, and disconnect on exit.
  // Fire-and-forget over the existing 0600 socket; every call swallows its error so presence can never break a command.
  const cid = 'cli-' + process.pid;
  req('POST', '/clients', { clientId: cid, surface: 'cli' }).catch(() => {});
  const hb = setInterval(() => { req('POST', '/clients', { clientId: cid, beat: true }).catch(() => {}); }, 30000); if (hb.unref) hb.unref();
  process.on('exit', () => { try { req('POST', '/clients', { clientId: cid, disconnect: true }).catch(() => {}); } catch {} });
  // tui: hand the terminal to the full-screen cockpit (ensureDaemon ran first so spawn logs can't corrupt the alt buffer)
  if (cmd === 'tui') { require('./tui').run(); return; }
  // acp: the ACP stdio bridge — an editor (Zed/JetBrains/Neovim/VS Code) spawns this and drives Urfael over JSON-RPC
  // on stdin/stdout. FOREGROUND (the editor owns the process), like tui; it opens NO port, only the 0600 socket.
  if (cmd === 'acp') { if (rest.includes('--probe')) { await require('./acp').probe(); return; } require('./acp').run(); return; }
  if (cmd === 'council') {
    // a live, watchable round table of agents — the orchestrator decomposes, dispatches, and synthesizes.
    if (rest.includes('--list')) {
      const cs = await req('GET', '/councils');
      if (!cs || !cs.length) { console.log(dim('no councils yet — convene one:  ') + gold('urfael council "<task>"')); return; }
      for (const c of cs) console.log(gold(c.id) + dim('  ' + String(c.state || '').padEnd(11) + '  ') + String(c.task || '').slice(0, 70));
      return;
    }
    const replay = flag(rest, '--replay'), agents = flag(rest, '--agents');
    const task = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--replay' && rest[i - 1] !== '--agents').join(' ');
    if (!replay && !task.trim()) { console.error('usage: urfael council "<task>" [--agents N]   ·   urfael council --list   ·   urfael council --replay <id>'); process.exit(1); }
    await require('./council-view').run(task, agents, { replay });
    return;
  }
  if (cmd === 'health') { console.log(JSON.stringify(await req('GET', '/health'))); return; }
  if (cmd === 'shutdown') { await req('POST', '/shutdown').catch(() => {}); console.log('brain stopped'); return; }
  if (cmd === 'status') {
    // the Hearth — a framed vitals card. Every number is real: facts counts memory bullets, the sparkline is
    // the 7-day token series from /vitals, the seal badge is a live signature check.
    const lib = require('./lib');
    const v = await req('GET', '/vitals');
    let facts = 0; for (const f of ['MEMORY.md', 'USER.md']) { try { facts += (fs.readFileSync(path.join(MEMORY_DIR, f), 'utf8').match(/^\s*[-*] .+/gm) || []).length; } catch {} }
    const sv = await req('GET', '/seal/verify').catch(() => null);
    const seal = sv && sv.ok ? ok('✓ sealed') + dim(' · ' + sv.fp) : (sv && sv.reason !== 'no_seal') ? bad('⚠ seal broken') : dim('unsealed');
    const mode = v.mode === 'full' ? warn('FULL') : gold('ᚦ fortress');                 // ᚦ Thurisaz — the warding rune
    const tok = (n) => (n >= 1000 ? Math.round(n / 1000) + 'k' : (n || 0) + '');
    const spark = lib.sparkline(v.days7 || []);
    const sum7 = (v.days7 || []).reduce((a, b) => a + b, 0);
    console.log(frame('Urfael · the Hearth', [
      gold(v.model) + (v.pinned ? dim(' · pinned') : '') + dim('   warm: ' + ((v.warm || []).join(', ') || 'idle')) + '   ' + mode,
      ...(v.persona ? [gold(v.persona.glyph + ' ' + v.persona.name) + dim('   ' + v.persona.essence)] : []),
      '',
      dim('today    ') + v.turnsToday + ' turns · ' + tok(v.tokToday) + ' tokens · avg ' + v.avgMs + 'ms',
      dim('7-day    ') + gold(spark) + dim('  ' + tok(sum7) + ' tokens'),
      dim('memory   ') + facts + ' facts known · ' + v.memCommits + ' commits',
      dim('ledger   ') + seal,
      dim('uptime   ') + Math.round(v.uptimeS / 60) + 'm' + (v.errors ? dim('   ·   restarts today: ') + v.errors : ''),
    ]));
    return;
  }
  if (cmd === 'model') {
    // show or pin the model. The same switch works verbally in chat ("switch to opus", "back to auto").
    const sub = (rest[0] || '').toLowerCase();

    // ── first-class PROVIDER management: pick any model backend (your own key/hardware via a proxy). ──
    if (sub === 'providers' || sub === 'provider') {
      const prov = require('./providers'); const setup = require('./setup');
      const list = prov.load(); const env = setup.readEnv();
      const activeId = env.CLAUDE_CODE_USE_BEDROCK ? 'claude-bedrock' : env.CLAUDE_CODE_USE_VERTEX ? 'claude-vertex'
        : !env.ANTHROPIC_BASE_URL ? 'claude' : ((list.find((x) => x.baseUrl === env.ANTHROPIC_BASE_URL) || {}).id || '');
      if (rest.includes('--json')) { console.log(JSON.stringify({ active: activeId, providers: list.map((x) => ({ id: x.id, label: x.label, kind: x.kind, models: x.models.length, verified: x.verified, hasKey: !!(x.authEnv && env[x.authEnv]) })) }, null, 2)); return; }
      console.log(gold('Providers') + dim('  ·  the flat-rate Claude subscription is the default; others run on YOUR key/hardware'));
      list.forEach((x, i) => console.log('  ' + (x.id === activeId ? gold('●') : dim('○')) + ' ' + dim(String(i + 1).padStart(2)) + ' ' + gold(x.id.padEnd(16)) + ' ' + dim((x.note || x.label).slice(0, 46)) + (x.verified ? '' : gold(' •unverified'))));
      console.log('\n' + dim('● active  ○ available   ·   switch:  ') + gold('urfael model use <id>') + dim('   ·   probe:  ') + gold('urfael model test <id>'));
      return;
    }
    if (sub === 'use' && rest[1]) {
      const prov = require('./providers'); const setup = require('./setup');
      const list = prov.load(); const arg = rest[1];
      const e = /^\d+$/.test(arg) ? list[parseInt(arg, 10) - 1] : prov.find(list, arg);
      if (!e) { console.error('✗ no provider "' + arg + '". Try: urfael model providers'); process.exit(1); }
      const pv = prov.preview(e);
      console.log('');
      console.log(gold('── provider: ' + e.label) + dim('  (' + e.id + ' · ' + e.kind + ')'));
      console.log(dim('   target    ') + pv.target);
      console.log(dim('   tiers     ') + dim('opus→') + pv.big + dim('   sonnet→') + pv.small);
      if (pv.proxyHint) console.log(dim('   proxy     ') + gold(pv.proxyHint));
      if (e.note) console.log(dim('   note      ') + dim(e.note));
      if (!pv.verified) console.log('   ' + gold('•unverified') + dim(' — confirm the base URL + model ids above before relying on it'));
      const secrets = {}; const need = prov.secretNeeded(e);
      if (need) { const v = await promptSecret('   ' + need.label + ': '); if (!v) { console.log(dim('aborted — no key entered')); return; } secrets[e.authEnv] = v; }
      const ok = await promptYesNo('\nSwitch to ' + e.label + '? (writes provider.env 0600 + restarts the daemon)');
      if (!ok) { console.log(dim('aborted — nothing changed')); return; }
      let delta; try { delta = prov.resolveEnv(e, secrets[e.authEnv], { big: flag(rest, '--big'), small: flag(rest, '--small') }); } catch (err) { console.error('✗ ' + ((err && err.message) || err)); process.exit(1); }
      const cur = setup.readEnv(); for (const k of delta.clear) delete cur[k]; Object.assign(cur, delta.set);
      try { setup.writeEnv(cur); } catch (err) { console.error('✗ write failed: ' + ((err && err.message) || err)); process.exit(1); }
      await req('POST', '/shutdown').catch(() => {});           // restart so the daemon re-sources provider.env
      await new Promise((r) => setTimeout(r, 700)); await ensureDaemon();
      console.log(gold('✓ now on ' + e.label) + dim('  — `urfael model opus/sonnet` pins the tier within this provider'));
      if (e.proxy !== 'none') console.log(dim('  proxy reminder: ') + gold(pv.proxyHint || 'start your proxy first'));
      return;
    }
    if (sub === 'test' && rest[1]) {
      const prov = require('./providers'); const setup = require('./setup');
      const e = prov.find(prov.load(), rest[1]); if (!e) { console.error('✗ no provider "' + rest[1] + '"'); process.exit(1); }
      const env = setup.readEnv();
      let delta; try { delta = prov.resolveEnv(e, env[e.authEnv], {}); } catch (err) { console.error('✗ ' + err.message + ' — set it first: urfael model use ' + e.id); process.exit(1); }
      const probeEnv = { ...process.env }; for (const k of delta.clear) delete probeEnv[k]; Object.assign(probeEnv, delta.set);
      console.log(dim('probing ' + e.label + ' …'));
      try { const o = execFileSync('claude', ['-p', 'reply with exactly: ok'], { env: probeEnv, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); console.log(gold('✓ reachable') + dim('  — replied: ' + o.slice(0, 40))); }
      catch (err) { console.error('✗ unreachable' + (e.proxy !== 'none' ? dim('  — is your proxy running? ' + (e.proxyHint || '')) : '') + dim('  (' + String((err && err.message) || err).slice(0, 70) + ')')); process.exit(1); }
      return;
    }

    // ── cost/speed/quality-aware ROUTING: recommend the best provider for a priority (Pareto-aware, explainable). ──
    if (sub === 'route') {
      const prov = require('./providers'); const router = require('./router');
      const list = prov.load();
      const priority = (flag(rest, '--for') || 'balanced').toLowerCase();
      if (!router.PRIORITIES.includes(priority)) { console.error('✗ --for must be one of: ' + router.PRIORITIES.join(' | ')); process.exit(1); }
      const res = router.route(list, { priority, role: flag(rest, '--role'), needsTools: rest.includes('--tools'), minCtx: Number(flag(rest, '--ctx')) || 0 });
      console.log('');
      if (!res.pick) { console.log(dim(res.why)); return; }
      console.log(gold('Recommended for ' + priority) + dim('   (best of ' + res.considered + ' candidates)'));
      console.log('  ' + gold('● ' + res.pick.label) + dim('  (' + res.pick.providerId + ')'));
      console.log(dim('   ' + res.why));
      console.log('');
      console.log(dim('  The honest tradeoffs on the Pareto frontier (cost/speed/quality, 1-5):'));
      for (const c of res.frontier.slice(0, 8)) console.log('    ' + dim('·') + ' ' + gold(c.providerId.padEnd(14)) + dim('cost ' + (c.cost || '?') + '  speed ' + (c.speed || '?') + '  quality ' + (c.quality || '?') + (c.local ? '  · local' : '') + (c.flatRate ? '  · flat-rate' : '')));
      console.log('');
      console.log(dim('  switch:  ') + gold('urfael model use ' + res.pick.providerId) + dim('   ·   tiers are indicative, not benchmarks'));
      return;
    }

    if (sub) {
      const spec = /^(auto|reset|unpin|automatic)$/.test(sub) ? { action: 'auto' } : (sub === 'opus' || sub === 'sonnet') ? { model: sub } : null;
      if (!spec) { console.error('usage: urfael model [opus | sonnet | auto | route --for cost|speed|quality|privacy]'); process.exit(1); }
      const r = await req('POST', '/model', spec);
      if (r && r.error) { console.error('✗ ' + r.error); process.exit(1); }
      console.log(gold('✓ ' + (r.text || 'done')));
      return;
    }
    const m = await req('GET', '/model');
    if (m && m.pinned) console.log(gold('pinned to ' + m.pinned) + dim('   · say “go back to auto” (or `urfael model auto`) to unpin'));
    else console.log(gold('auto-routing') + dim('   · on ' + ((m && m.model) || '…') + ' now · say “switch to opus” (or `urfael model opus`) to pin'));
    return;
  }
  if (cmd === 'persona') {
    // show, switch, or reset the voice. The same switch works verbally in chat ("become the architect", "back to urfael").
    const sub = (rest[0] || '').toLowerCase();
    if (sub) {
      const spec = /^(reset|urfael|default|anchor|none)$/.test(sub) ? { action: 'reset' } : (sub === 'list') ? { action: 'list' } : (sub === 'status' || sub === 'who') ? { action: 'status' } : { id: sub };
      const r = await req('POST', '/persona', spec);
      if (r && r.error) { console.error('✗ ' + r.error); process.exit(1); }
      console.log(gold('✓ ' + (r.text || 'done')));
      return;
    }
    const m = await req('GET', '/persona');
    const cur = m && m.display;
    if (cur && m.persona !== 'urfael') console.log(gold(cur.glyph + ' ' + cur.name) + dim('   · ' + cur.essence + ' · say “back to urfael” (or `urfael persona reset`) to return'));
    else console.log(gold('ᚢ Urfael') + dim('   · the anchor · say “become the architect” (or `urfael persona <id>`) to switch'));
    console.log(dim('  roster:  ') + (m && m.roster || []).map((d) => d.glyph + ' ' + d.id).join('   '));
    return;
  }
  if (cmd === 'cron') {
    const sub = rest[0];
    if (sub === 'add') {
      const prompt = rest.slice(1).filter((a, i) => !a.startsWith('--') && !(rest[i] || '').startsWith('--')).join(' ');
      const spec = {};
      if (flag(rest, '--script')) { spec.kind = 'script'; spec.script = flag(rest, '--script'); } // no-LLM shell step (needs URFAEL_SCRIPT_CRON=1)
      else spec.prompt = prompt;
      if (flag(rest, '--in') != null) spec.inMins = Number(flag(rest, '--in'));
      if (flag(rest, '--cron')) spec.repeat = { cron: flag(rest, '--cron') };                          // full 5-field cron: "*/15 9-17 * * 1-5"
      else if (flag(rest, '--days')) spec.repeat = { days: flag(rest, '--days'), at: flag(rest, '--at') || '09:00' }; // "mon,wed,fri" / "weekdays" / "weekend"
      else if (flag(rest, '--daily-at')) spec.repeat = { dailyAt: flag(rest, '--daily-at') };
      else if (flag(rest, '--repeat')) { const r = flag(rest, '--repeat'); spec.repeat = (r === 'daily' || r === 'weekly') ? r : { everyMins: Number(r) }; }
      if (flag(rest, '--deliver')) spec.deliver = flag(rest, '--deliver');
      if (flag(rest, '--then')) spec.then = { prompt: flag(rest, '--then') };                       // chain: an agent follow-up on completion
      else if (flag(rest, '--then-script')) spec.then = { kind: 'script', script: flag(rest, '--then-script') };
      const r = await req('POST', '/cron', spec);
      console.log(r && r.error ? '✗ ' + r.error : `✓ ${r.kind || 'agent'} cron ${r.id} — first run ${r.at}${r.chained ? dim(' (chained)') : ''}`);
      return;
    }
    if (sub === 'cancel' && rest[1]) { console.log(JSON.stringify(await req('POST', `/cron/${rest[1]}/cancel`))); return; }
    if (sub === 'run' && rest[1]) { console.log(JSON.stringify(await req('POST', `/cron/${rest[1]}/run`))); return; }
    const cj = await req('GET', '/cron');
    if (!cj || !cj.length) { console.log('no scheduled jobs'); return; }
    for (const j of cj) console.log(`${j.id}  ${gold((j.at || '').replace('T', ' ').slice(0, 16))}  ${(j.prompt || '').slice(0, 60)}${j.repeat ? dim('  (' + JSON.stringify(j.repeat) + ')') : ''}`);
    return;
  }
  if (cmd === 'hook') {
    // manage webhook event triggers. `add` prints the secret ONCE; store it (sent as the X-Urfael-Hook header).
    const sub = rest[0];
    if (sub === 'add' && rest[1]) {
      const name = rest.slice(1).filter((a, i) => !a.startsWith('--') && !(rest[i] || '').startsWith('--')).join(' ');
      const spec = { name };
      if (flag(rest, '--action')) spec.action = flag(rest, '--action');
      if (flag(rest, '--deliver')) spec.deliver = flag(rest, '--deliver');
      if (flag(rest, '--reply-url')) spec.replyUrl = flag(rest, '--reply-url');   // relay: where the brain's reply is posted (owner-set)
      if (flag(rest, '--reply-auth')) spec.replyAuth = flag(rest, '--reply-auth'); // relay: optional outbound Authorization header
      const r = await req('POST', '/hooks', spec);
      if (!r || r.error) { console.error('✗ ' + ((r && r.error) || 'failed')); process.exit(1); }
      const port = parseInt(process.env.URFAEL_HOOKS_PORT, 10) || 7718;
      console.log(gold('✓ webhook ' + r.id) + dim('  action=' + r.action + ' · deliver=' + r.deliver));
      console.log('  URL     ' + gold(`http://127.0.0.1:${port}/hook/${r.id}`));
      console.log('  secret  ' + gold(r.secret) + dim('  (shown once — store it)'));
      if (r.replyUrl) console.log('  reply→  ' + gold(r.replyUrl) + dim('  (relay posts the answer here)'));
      console.log(dim('  test:   ') + `curl -X POST -H "X-Urfael-Hook: ${r.secret}" --data 'hello' http://127.0.0.1:${port}/hook/${r.id}`);
      console.log(dim('  start the receiver if you have not:  ') + gold('urfael hooks'));
      return;
    }
    if ((sub === 'rm' || sub === 'remove') && rest[1]) { const r = await req('POST', '/hook/' + rest[1] + '/delete'); console.log(r && r.ok ? gold('✓ removed ' + rest[1]) : '✗ no such hook'); return; }
    const hs = await req('GET', '/hooks');
    if (!hs || !hs.length) { console.log(dim('no webhooks yet — create one:  ') + gold('urfael hook add "my trigger"')); return; }
    for (const h of hs) console.log(`${gold(h.id)}  ${dim((h.action + '/' + h.deliver).padEnd(14))} ${h.name}`);
    return;
  }
  if (cmd === 'script') {
    // the saved-script library (the trustworthy execute_code): register an owner shell body once, call it with args.
    const sub = rest[0];
    if (sub === 'add' && rest[1] && rest[2]) {
      const r = await req('POST', '/scripts', { name: rest[1], script: rest.slice(2).join(' ') });
      if (!r || r.error) { console.error('✗ ' + ((r && r.error) || 'failed')); process.exit(1); }
      console.log(gold('✓ script ' + r.name) + dim('  run:  urfael script run ' + r.name + ' [args…]')); return;
    }
    if ((sub === 'rm' || sub === 'remove') && rest[1]) { const r = await req('POST', '/script/' + rest[1] + '/delete'); console.log(r && r.ok ? gold('✓ removed ' + rest[1]) : '✗ no such script'); return; }
    if (sub === 'run' && rest[1]) {
      const r = await req('POST', '/script/' + rest[1] + '/run', { args: rest.slice(2) });
      if (r && r.error) { console.error('✗ ' + r.error); process.exit(1); }
      if (r.out) process.stdout.write(r.out.endsWith('\n') ? r.out : r.out + '\n');
      console.log(dim('— exit ' + r.exitCode)); return;
    }
    const ss = await req('GET', '/scripts');
    if (!ss || !ss.length) { console.log(dim('no saved scripts — add one:  ') + gold('urfael script add <name> "<shell>"') + dim('   (needs URFAEL_SCRIPT_CRON=1)')); return; }
    for (const s of ss) console.log(gold(s.name) + dim('  ' + (s.createdAt || '').slice(0, 10)));
    return;
  }
  if (cmd === 'team') {
    // manage the team roster (allowlisted principals per channel + roles) at ~/.claude/urfael/team.json.
    const lib = require('./lib');
    const TEAMF = path.join(os.homedir(), '.claude', 'urfael', 'team.json');
    const readTeam = () => { try { return JSON.parse(fs.readFileSync(TEAMF, 'utf8')); } catch { return {}; } };
    const writeTeam = (t) => { fs.mkdirSync(path.dirname(TEAMF), { recursive: true }); fs.writeFileSync(TEAMF + '.tmp', JSON.stringify(t, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(TEAMF + '.tmp', TEAMF); };
    const sub = rest[0];
    if (sub === 'pair') {
      // urfael team pair [channel] [--ttl <mins>] — mint a single-use code; the new person DMs it to enroll as a GUEST.
      const channel = rest[1] && !rest[1].startsWith('--') ? rest[1] : undefined;
      const spec = {}; if (channel) spec.channel = channel; if (flag(rest, '--ttl')) spec.ttlMins = Number(flag(rest, '--ttl'));
      const r = await req('POST', '/pair', spec);
      if (!r || r.error) { console.error('✗ ' + ((r && r.error) || 'failed')); process.exit(1); }
      console.log(gold('✓ pairing code  ' + r.code) + dim('  (guest only · expires ' + (r.expISO || '').replace('T', ' ').slice(0, 16) + (r.channel ? ' · ' + r.channel : '') + ')'));
      console.log(dim('  share it; the new person DMs exactly this code to your bot to self-enroll as a guest.'));
      return;
    }
    if (sub === 'add' && rest[1] && rest[2]) {
      // urfael team add <channel> <id> [name] [role] [--max opus|sonnet]
      // --max sets an OWNER-imposed model CEILING for this principal: their turns auto-route as usual but can never
      // exceed this tier, so a member/guest can't burn the costly tier on a heavy prompt. Invalid values are ignored.
      let maxModel = '';
      const pos = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--max' || a === '--max-model') { maxModel = rest[i + 1] || ''; i++; continue; }
        const mm = typeof a === 'string' && a.match(/^--max(?:-model)?=(.+)$/); if (mm) { maxModel = mm[1]; continue; }
        pos.push(a);
      }
      const [, channel, id, name, role] = pos;
      const { team, error } = lib.addPrincipal(readTeam(), channel, { id, name: name || id, role, maxModel });
      if (error) { console.error('✗ ' + error); process.exit(1); }
      const shownRole = /^(owner|member|guest)$/.test(role || '') ? role : 'guest';
      const cap = lib.normPinModel(maxModel);
      writeTeam(team); console.log(gold('✓ added ') + id + dim(' to ' + channel + ' as ' + shownRole + (cap ? ', capped at ' + cap : '') + '. Takes effect live.'));
      return;
    }
    if ((sub === 'remove' || sub === 'rm') && rest[1] && rest[2]) {
      const { team, removed } = lib.removePrincipal(readTeam(), rest[1], rest[2]);
      if (!removed) { console.error('✗ ' + rest[2] + ' is not in the ' + rest[1] + ' roster'); process.exit(1); }
      writeTeam(team); console.log(gold('✓ removed ') + rest[2] + dim(' from ' + rest[1]));
      return;
    }
    if (sub === 'add' || sub === 'remove' || sub === 'rm') { console.log('usage: urfael team add <channel> <id> [name] [owner|member|guest] [--max opus|sonnet]   ·   urfael team remove <channel> <id>'); return; }
    // default: show the roster
    const team = readTeam();
    const chans = Object.keys(team).filter((c) => Array.isArray(team[c]) && team[c].length);
    if (!chans.length) { console.log(dim('single-owner mode — no team.json yet.')); console.log(dim('  add a teammate:  ') + gold('urfael team add telegram <chat-id> "Sam" member')); return; }
    for (const c of chans) {
      console.log(gold(c));
      for (const p of team[c]) { const role = p.role === 'owner' ? gold('owner ') : p.role === 'guest' ? dim('guest ') : 'member'; const cap = lib.normPinModel(p.maxModel != null ? p.maxModel : p.model); console.log(`  ${role}  ${dim(String(p.id).slice(0, 18).padEnd(18))}  ${p.name || ''}${cap ? dim('  ≤' + cap) : ''}`); }
    }
    return;
  }
  if (cmd === 'usage') {
    // tokens / turns / ESTIMATED cost. Bare → today / 7d / 30d totals (the usageSummary windows). --by principal|channel
    // → the per-key rollup (who/which channel spent what), the dimension a per-AGENT scope can't express. --verify adds a
    // Ledger-of-Record cross-check that every counted turn is chain-witnessed. --json prints the raw payload.
    const json = rest.includes('--json'), verify = rest.includes('--verify');
    const byFlag = flag(rest, '--by');
    const wantRollup = verify || byFlag != null;
    const by = byFlag === 'channel' ? 'channel' : 'principal';   // default the rollup dimension to principal
    const ktok = (n) => { n = n || 0; return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); };
    let p = '/usage';
    if (wantRollup) { p += '?by=' + by + (verify ? '&verify=1' : ''); }
    const u = await req('GET', p);
    if (json) { console.log(JSON.stringify(u, null, 2)); return; }
    if (!wantRollup) {
      if (!u || !u.today) { console.log(dim('no usage recorded yet')); return; }
      console.log(gold('Usage & cost (est.)'));
      for (const [label, b] of [['today', u.today], ['7d', u.last7d], ['30d', u.last30d]]) {
        const w = b || {};
        console.log('  ' + gold(label.padEnd(6)) + '$' + (w.costUsd || 0).toFixed(2) + dim(' est') + '  ' + dim((w.turns || 0) + ' turns · ' + ktok((w.tokIn || 0) + (w.tokOut || 0)) + ' tok'));
      }
      console.log(dim('  ' + (u.note || '')));
      console.log(dim('  per principal:  ') + gold('urfael usage --by principal') + dim('   ·   per channel:  ') + gold('urfael usage --by channel'));
      return;
    }
    const groups = (u && u.groups) || {};
    const keys = Object.keys(groups).sort((a, b) => (groups[b].costUsd - groups[a].costUsd) || (groups[b].turns - groups[a].turns));
    if (!keys.length) { console.log(dim('no usage recorded yet for that dimension')); return; }
    const cents = u.local ? 2 : 4;   // raw-Anthropic shows sub-cent estimates; LOCAL_MODE zeroes the dollar meter
    console.log(gold('Usage by ' + (u.by || by)) + dim('  ·  ' + keys.length + ' ' + (u.by || by) + (keys.length === 1 ? '' : 's') + (u.local ? '  · LOCAL_MODE: cost meter off' : '')));
    const row = (k, g) => '  ' + gold(String(k).slice(0, 18).padEnd(18)) + dim(String(g.turns || 0).padStart(4) + ' turns ') + ktok((g.tokIn || 0) + (g.tokOut || 0)).padStart(7) + ' tok  ' + ('$' + (g.costUsd || 0).toFixed(cents)).padStart(10) + dim(' est');
    for (const k of keys) console.log(row(k, groups[k]));
    console.log(dim('  ' + '─'.repeat(46)));
    console.log(row('total', u.total || {}));
    if (u.note) console.log(dim('  ' + u.note));
    if (u.verify) {
      if (u.verify.verified) console.log(gold('  ✓ ledger-witnessed') + dim('  · all ' + (u.verify.counted || 0) + ' counted turns appear in the Ledger of Record'));
      else console.log('\x1b[31m  ✗ ' + (u.verify.missing || 0) + ' of ' + (u.verify.counted || 0) + ' counted turns are NOT in the ledger\x1b[0m' + dim('  (run `urfael audit --verify`)'));
    } else {
      console.log(dim('  check the inputs against the ledger:  ') + gold('urfael usage --by ' + (u.by || by) + ' --verify'));
    }
    return;
  }
  if (cmd === 'audit') {
    if (rest.includes('--verify')) {
      // Ledger of Record: walk the tamper-evident hash chain and prove it's intact (or pinpoint the first break).
      const v = await req('GET', '/audit/verify');
      if (v && v.ok) console.log(gold('✓ Ledger of Record intact') + dim('  · ' + (v.count || 0) + ' entries, chain verified through seq ' + (v.through >= 0 ? v.through : '—')) + (v.head ? dim('\n  head ' + v.head) : ''));
      else console.log('\x1b[31m✗ Ledger TAMPERED\x1b[0m' + dim('  · first broken link at seq ' + (v && v.brokenSeq) + ' (line ' + (v && v.brokenLine) + '): ' + (v && v.reason)));
      return;
    }
    // export the team-mode activity trail (who/when/which channel/which sandbox profile) for an admin/auditor.
    const a = await req('GET', '/audit');
    if (rest.includes('--json')) { console.log(JSON.stringify(a, null, 2)); return; }
    if (!a || !a.activity || !a.activity.length) { console.log(dim('no remote (principal) activity recorded yet')); return; }
    console.log(gold('Remote activity') + dim('  ·  ' + a.activity.length + ' turns (newest first)'));
    for (const e of a.activity.slice(0, 50)) {
      console.log(`  ${dim((e.t || '').replace('T', ' ').slice(0, 16))}  ${gold((e.channel || '?').padEnd(8))} ${(e.principal || '—').slice(0, 14).padEnd(14)} ${dim(e.profile || '')}  ${dim('in ' + (e.in || 0) + '/out ' + (e.out || 0))}`);
    }
    return;
  }
  if (cmd === 'seal') {
    // Sovereign Seal: an owner ed25519 key signs the Ledger of Record's head, giving the tamper-evident record a
    // cryptographic identity. A seal proves the OWNER attested to the record at a moment — not that any claim is true.
    if (rest.includes('--verify')) {
      const v = await req('GET', '/seal/verify');
      if (!v || v.reason === 'no_seal') { console.log(dim('no seal yet — mint one:  ') + gold('urfael seal')); return; }
      if (v.ok) {
        console.log(gold('✓ seal valid') + dim('  · key ' + v.fp + ' signed the ledger through seq ' + v.seq + ' at ' + (v.t || '').replace('T', ' ').slice(0, 16)));
        if (v.headStillInChain === true) console.log(dim('  the sealed head still matches the current ledger'));
        else if (v.headStillInChain === false) console.log('  \x1b[31m⚠ the sealed head NO LONGER matches the ledger — history changed at/below the seal\x1b[0m');
      } else console.log('\x1b[31m✗ seal does NOT verify\x1b[0m' + dim('  (' + (v.reason || 'bad signature') + ')'));
      return;
    }
    const s = await req('POST', '/seal');
    if (!s || !s.sig) { console.error('✗ could not mint a seal'); process.exit(1); }
    console.log(gold('✓ sealed the record') + dim('  · key ' + s.fp + ' signed the ledger head through seq ' + s.seq));
    console.log(dim('  head ' + (s.chainHead || '').slice(0, 24) + '…   sig ' + (s.sig || '').slice(0, 24) + '…'));
    console.log(dim('  verify anytime:  ') + gold('urfael seal --verify') + dim('   ·   public key committed at ~/Urfael-memory/seal.pub'));
    return;
  }
  if (cmd === 'attest') {
    // Attestation Report: bundle the independently-verifiable facts (ledger hash-chain, ed25519 seal, posture in
    // force) into one human + JSON artifact a reviewer/auditor/client can keep, anchored by the seal. The wording is
    // scoped honestly in attest.js: it proves integrity + authorship + posture, NOT the truth of any recorded claim
    // and NOT an absolute no-egress guarantee.
    const at = require('./attest');
    const lv = await req('GET', '/audit/verify').catch(() => null);
    const sv = await req('GET', '/seal/verify').catch(() => null);
    const ledger = lv ? { verified: !!lv.ok, count: lv.count, through: lv.through, head: lv.head, reason: lv.ok ? undefined : lv.reason, brokenSeq: lv.brokenSeq } : { verified: false, reason: 'daemon unreachable' };
    const seal = (!sv || sv.reason === 'no_seal') ? { present: false, valid: false } : { present: true, valid: !!sv.ok, fp: sv.fp, seq: sv.seq, headStillInChain: sv.headStillInChain, reason: sv.ok ? undefined : sv.reason };
    const posture = { noInboundPort: true, untrustedProfile: 'read-only, no shell, no write, no egress, credential-deny', mode: process.env.URFAEL_YOLO === '1' ? 'Full' : 'Fortress' };
    const report = at.buildReport({ subject: os.hostname() + ' (Urfael)', ledger, seal, posture }, new Date().toISOString());
    const v = at.verdict(report);
    const bundle = JSON.stringify({ verdict: v, id: at.fingerprint(report), ...report }, null, 2);
    const out = flag(rest, '--out');
    if (rest.includes('--json')) {
      console.log(bundle);
      if (out) { try { fs.writeFileSync(out, bundle); console.error(dim('  wrote ' + out)); } catch (e) { console.error('✗ ' + (e && e.message)); } }
      return;
    }
    const lines = at.render(report).split('\n');
    console.log((v === 'NOT ATTESTED' ? '\x1b[31m' + lines[0] + '\x1b[0m' : gold(lines[0])));
    console.log(dim(lines.slice(1).join('\n')));
    if (out) { try { fs.writeFileSync(out, bundle); console.log(dim('\n  bundle written to ' + out + ' (anchored by the Sovereign Seal)')); } catch (e) { console.error('✗ ' + (e && e.message)); } }
    console.log(dim('\n  machine-readable:  ') + gold('urfael attest --json --out attestation.json') + dim('   ·   re-verify the anchor:  ') + gold('urfael seal --verify'));
    return;
  }
  if (cmd === 'forget') {
    // consented forgetting with a provable tombstone. No arg → show the tombstone record (auditable deletions).
    const phrase = rest.filter((a) => !a.startsWith('--')).join(' ').trim();
    if (!phrase) {
      // the record, as dignified blocks: each forgotten phrase, when, and its struck-through lines.
      let txt = ''; try { txt = fs.readFileSync(path.join(MEMORY_DIR, 'TOMBSTONES.md'), 'utf8'); } catch {}
      if (!txt.trim()) { console.log(dim('nothing forgotten yet — forget something:  ') + gold('urfael forget "<phrase>"')); return; }
      const blocks = txt.split(/^## /m).map((b) => b.trim()).filter(Boolean).slice(-12);
      const lines = [];
      for (const b of blocks) {
        const whenM = /^([\d-]+ [\d:]+)/.exec(b), quoteM = /"([^"]*)"/.exec(b);
        lines.push(gold('“' + (quoteM ? quoteM[1] : '?') + '”') + dim('   ' + (whenM ? whenM[1] : '')));
        for (const ln of b.split('\n').slice(1)) { const m = /^- (.+)$/.exec(ln.trim()); if (m) lines.push('    ' + bad('−') + ' ' + dim('\x1b[9m' + m[1].slice(0, 82) + '\x1b[0m')); }
        lines.push('');
      }
      if (lines[lines.length - 1] === '') lines.pop();
      console.log(frame('The tombstone record · provable deletions', lines));
      return;
    }
    const r = await req('POST', '/forget', { phrase });
    if (r && r.error) { console.error('✗ ' + r.error); process.exit(1); }
    if (!r.count) { console.log(dim('nothing in memory matched “' + phrase + '” — there was nothing to forget, sir.')); return; }
    const when = (r.at || '').slice(0, 16).replace('T', ' ');
    console.log(frame('Forgotten', [
      ok('✓ ' + r.count + ' belief' + (r.count === 1 ? '' : 's') + ' removed at your request') + (when ? dim('   · ' + when) : ''),
      '',
      ...(r.removed || []).slice(0, 20).map((x) => '  ' + bad('−') + ' ' + dim('(' + x.file + ') ') + '\x1b[9m\x1b[2m' + x.line.slice(0, 78) + '\x1b[0m'),
      '',
      dim('tombstoned + git-committed — the deletion itself is now provable.'),
      dim('see the record:  ') + gold('urfael forget'),
    ]));
    return;
  }
  if (cmd === 'learn') {
    const { stats, items } = await req('GET', '/learn');
    if (!stats || !stats.total) { console.log(dim('the ledger is empty — nothing learned yet')); return; }
    console.log(gold('Learning ledger') + dim(`  ·  ${stats.trusted} trusted · ${stats.proposed} proposed · ${stats.retired} retired · avg confidence ${stats.avgConfidence}`));
    const order = { trusted: 0, proposed: 1, retired: 2 };
    const want = rest[0]; // optional filter: trusted | proposed | retired
    const rows = items.filter((i) => !want || i.status === want).sort((a, b) => (order[a.status] - order[b.status]) || (b.confidence - a.confidence));
    for (const i of rows.slice(0, 40)) {
      const tag = i.status === 'trusted' ? gold('trusted') : i.status === 'retired' ? dim('retired') : '\x1b[2m\x1b[33mproposed\x1b[0m';
      const conf = i.status === 'retired' ? '    ' : (i.confidence).toFixed(2);
      console.log(`  ${tag}  ${dim(conf)}  ${i.ref.slice(0, 78)}`);
    }
    return;
  }
  if (cmd === 'jobs') { for (const j of await req('GET', '/jobs')) console.log(`${j.id}  ${j.kind}  ${gold(j.state)}  ${dim('scope=' + (j.scope || '?'))}  ${dim(j.createdAt || '')}`); return; }
  if (cmd === 'job') { if (!rest[0]) { console.log('usage: urfael job <id>'); return; } const j = await req('GET', '/job/' + rest[0]); console.log(dim('scope: ') + gold((j.spec && j.spec.scope) || '(unset)')); console.log(JSON.stringify({ ...j, log: undefined }, null, 2)); if (j.log) console.log(dim('--- log tail ---\n') + j.log); return; }
  if (cmd === 'cancel') { if (!rest[0]) { console.log('usage: urfael cancel <id>'); return; } console.log(JSON.stringify(await req('POST', `/job/${rest[0]}/cancel`))); return; }
  if (cmd === 'schedule') {
    // the dedicated Reminders & Calendar channel: add / move / cancel a reminder or calendar event in plain English.
    // It streams /schedule exactly like ask() streams /ask. The daemon (LOCAL-only; it 403s any channel key) stages
    // the directives and ends its reply with "Say yes to apply." — a follow-up `urfael schedule yes` / `no`, or the
    // inline y/N prompt below on a TTY, sends the second turn that makes applyScheduleDirectives run. Fail-closed:
    // on a non-TTY it never auto-applies, it just prints how to confirm by hand.
    const text = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] || '').startsWith('--')).join(' ').trim();
    if (!text) { console.log('usage: urfael schedule "<add/move/cancel a reminder or event, in plain English>"   ·   confirm with  urfael schedule yes'); return; }
    const reply = await ask(text, '/schedule', true);                      // true: render the daemon's final cleaned text (tokens stripped, confirm marker present), not the raw deltas
    if (reply && /say yes to apply/i.test(reply)) {                         // the daemon's exact confirm marker (describeScheduleDirectives staged something)
      if (process.stdin.isTTY) await ask((await promptYesNo('Apply this?')) ? 'yes' : 'no', '/schedule', true);
      else console.log(dim('  confirm:  ') + gold('urfael schedule yes') + dim('   ·   drop it:  ') + gold('urfael schedule no'));
    }
    return;
  }
  if (cmd === 'calendar' || cmd === 'cal') {
    // READ-ONLY view of upcoming events (GET /calendar; no brain turn, no mutate path). The apply path (add / move /
    // cancel) lives only on the confirm-gated schedule channel above. --ics prints an iCalendar export; --n caps it.
    if (rest.includes('--ics')) {
      const ics = await req('GET', '/calendar?format=ics&n=200');
      process.stdout.write(typeof ics === 'string' ? (ics.endsWith('\n') ? ics : ics + '\n') : JSON.stringify(ics) + '\n');
      return;
    }
    const n = flag(rest, '--n');
    const evs = await req('GET', '/calendar' + (n ? '?n=' + encodeURIComponent(n) : ''));
    if (!Array.isArray(evs) || !evs.length) { console.log(dim('no upcoming events.  add one:  ') + gold('urfael schedule "add <event> on <date> at <time>"')); return; }
    console.log(gold('Calendar') + dim('  ·  next ' + evs.length + ' event' + (evs.length === 1 ? '' : 's')));
    for (const e of evs) console.log('  ' + gold((e.start || '').replace('T', ' ').slice(0, 16)) + '  ' + (e.title || '') + (e.location ? dim('  @ ' + e.location) : ''));
    console.log(dim('  add / move / cancel:  ') + gold('urfael schedule "<plain English>"'));
    return;
  }
  if (cmd === 'reminders') {
    const rs = await req('GET', '/reminders');
    if (!rs.length) { console.log('no reminders scheduled'); return; }
    for (const r of rs) console.log(`${r.id}  ${gold(r.at.replace('T', ' ').slice(0, 16))}  ${r.text}${r.repeat ? dim('  (repeats: ' + JSON.stringify(r.repeat) + ')') : ''}`);
    return;
  }
  if (cmd === 'remind') {
    const text = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] || '').startsWith('--')).join(' ');
    const spec = { text };
    // a bare HH:MM --at is a time-of-DAY (the recurrence clock), not a one-shot ISO anchor. With --days/--cron present
    // it sets the recurrence time; if left as spec.at the daemon would reject the whole reminder. --days-at still wins.
    const atRaw = flag(rest, '--at');
    const isHM = atRaw && /^\d{1,2}:\d{2}$/.test(atRaw.trim());
    if (flag(rest, '--in') != null) spec.inMins = Number(flag(rest, '--in'));
    if (flag(rest, '--cron')) spec.repeat = { cron: flag(rest, '--cron') };                            // full 5-field cron
    else if (flag(rest, '--days')) spec.repeat = { days: flag(rest, '--days'), at: flag(rest, '--days-at') || (isHM ? atRaw.trim() : '09:00') }; // "mon,wed,fri" / "weekdays"
    if (atRaw && !(isHM && (flag(rest, '--days') || flag(rest, '--cron')))) spec.at = atRaw;            // keep an ISO --at as the one-shot anchor; never double-use a bare HH:MM already consumed by a recurrence
    const rep = flag(rest, '--repeat');
    if (!spec.repeat) { if (rep === 'daily' || rep === 'weekly') spec.repeat = rep; else if (rep) spec.repeat = { everyMins: Number(rep) }; }
    const r = await req('POST', '/remind', spec);
    console.log(r.error ? '✗ ' + r.error : `✓ reminder ${r.id} fires at ${r.at}`);
    return;
  }
  if (cmd === 'unremind') { if (!rest[0]) { console.log('usage: urfael unremind <id>'); return; } console.log(JSON.stringify(await req('POST', `/reminder/${rest[0]}/cancel`))); return; }

  // default: everything is a question for the brain — UNLESS a lone word is an obvious command typo, in which
  // case suggest the fix instead of silently spending a turn on it. You can always force it as a real question.
  if (!rest.length) {
    const guess = require('./lib').suggestCommand(cmd, COMMANDS);
    if (guess) {
      console.log(dim('did you mean  ') + gold('urfael ' + guess) + dim('  ?'));
      console.log(dim('  (or ask me literally:  ') + gold('urfael "' + cmd + '"') + dim(')'));
      return;
    }
  }
  // resolve the prompt from argv, a --file/--message-file path, or stdin (a lone `-` or a pipe). Intercepting the
  // flags here means `urfael --file ./p.md` no longer mis-sends the literal "--file ./p.md" as a question.
  try {
    const text = await require('./lib').resolvePromptText({
      argv: [cmd, ...rest],
      readFile: readFileAdapter,
      readStdin: () => readStdinAdapter(PROMPT_MAX_BYTES),
      stdinIsTTY: process.stdin.isTTY,
      maxBytes: PROMPT_MAX_BYTES,
    });
    await ask(text);
  } catch (e) { console.error(bad('✗') + ' ' + ((e && e.message) || e)); process.exit(1); }
})();
