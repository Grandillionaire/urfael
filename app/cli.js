#!/usr/bin/env node
'use strict';
// urfael — talk to the brain from any terminal. A thin client of the daemon's unix socket
// (same brain, same memory, same warm sessions as the orb). No deps, no API key.
//   urfael setup                               onboarding wizard — pick subscription / API key / local model
//   urfael "what's on my calendar today?"      ask (streams the answer live)
//   urfael status                              the Hearth — a framed vitals card: model, 7-day token trend, facts known, ledger seal, uptime
//   urfael doctor                              health read — deps, brain, memory (readable AND writable), provider, persona, ledger, seal; every red line carries its own one-command fix
//   urfael jobs | job <id> | cancel <id>       background jobs
//   urfael reminders                           list reminders
//   urfael remind "text" --in 20 [--repeat daily|weekly|<mins>]   or  --at "2026-06-11T15:00"
//   urfael sessions search <query>             full-text search of every past conversation
//   urfael why "<belief>"                       provenance: walk a stored belief back to the exact commit/date/pass that introduced it (a checkable git SHA)
//   urfael as-of <date> [file]                  time machine: reconstruct a memory file (default USER.md) as it was on a past date
//   urfael drift [file] [--since <date>]        belief changelog: how the model of you changed over time (added / revised / removed)
//   urfael forget ["<phrase>"]                  consented forgetting: remove matching beliefs + leave a git tombstone (provable deletion); no arg shows the tombstone record
//   urfael learn [trusted|proposed|retired]    the learning ledger — what it learned, verified, and pruned (with confidence)
//   urfael team [add <channel> <id> [name] [role] | remove <channel> <id> | pair [channel] [--ttl <mins>]]   manage the roster; `pair` mints a single-use guest code
//   urfael audit [--json | --verify]           team-mode activity trail; --verify walks the tamper-evident Ledger of Record (prove what your agent did)
//   urfael seal [--verify]                      Sovereign Seal: an owner ed25519 key signs the ledger head (--verify checks the signature)
//   urfael cron [add "<prompt>" --cron "*/15 9-17 * * 1-5" | --days "mon,wed,fri" --at 07:30 | --daily-at HH:MM | --in N | --repeat daily [--then "<prompt>"] [--script "<cmd>"]] [list|cancel <id>|run <id>]
//                                              scheduled jobs — runs the brain (or, --script, a no-LLM shell cmd) on a schedule,
//                                              delivers the result, and chains a --then follow-up on completion
//   urfael serve [--token]                     start the OpenAI-compatible local API (Open WebUI / any OpenAI client)
//   urfael hooks                               start the loopback webhook receiver (event triggers) — prints its URL
//   urfael hook add "<name>" [--action ask|notify|relay] [--reply-url <url> --reply-auth <hdr>] [--deliver notify|silent|push]
//                                              register a webhook (prints the secret once). relay = two-way chat channel: any platform
//                                              with an in/out webhook (Teams/Mattermost/Zapier/n8n/…) → the reply posts to --reply-url
//   urfael hook [list | rm <id>]               list / remove webhook event triggers
//   urfael script add <name> "<shell>" | run <name> [args…] | list | rm <name>   reusable owner scripts (the trustworthy execute_code; needs URFAEL_SCRIPT_CRON=1)
//   urfael import [--from openclaw|hermes] [--apply]   migrate memory + skills from another assistant (dry-run by default)
//   urfael skills list                         your installed skills (name + description)
//   urfael skills export <name>                print a skill to stdout to share it
//   urfael skills scan <file>                  static safety-scan a skill .md before trusting it
//   urfael skills install <https-url> [--yes]  fetch a skill .md, scan it, show it, install on confirm (never executes it)
//   urfael hub [search <term>]                 browse the safe skill registry (set URFAEL_HUB_INDEX to your index.json)
//   urfael hub install <slug> [--yes]          install a registry skill — scanned + sha256-checked + previewed, never executed
//   urfael hub publish <file>                  print the registry index entry (slug + sha256) for a local skill to submit
//   urfael tui                                 full-screen terminal cockpit (streams turns, scrollback, status bar)
//   urfael dashboard                           open the token-gated localhost web console (prints the URL)
//   urfael stop                                abort the current in-flight turn (also: Ctrl+C while asking)
//   urfael health | shutdown
//   urfael logo                                print the Urfael terminal logo
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
const gold = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const warn = (s) => `\x1b[38;5;208m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
// strip ANSI to measure true printed width, so box borders line up regardless of colour codes
const visLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/[̀-ͯ]/g, '').length;
// every command keyword — powers `urfael <typo>` did-you-mean (lib.suggestCommand). Kept beside the handlers below.
const COMMANDS = ['logo', 'help', 'doctor', 'status', 'setup', 'sessions', 'why', 'as-of', 'drift', 'forget', 'learn', 'skills', 'hub', 'import', 'serve', 'dashboard', 'hooks', 'hook', 'script', 'team', 'audit', 'seal', 'cron', 'tui', 'health', 'shutdown', 'stop', 'jobs', 'job', 'cancel', 'reminders', 'remind', 'unremind'];
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
  const tag = 'an old intelligence, in service to one.';
  if (!process.stdout.isTTY) return '\n' + logo + '\n    ᚢᚱᚠᚨᛖᛚ   ' + tag + '\n';   // U·R·F·A·E·L in Elder Futhark
  return '\n\x1b[38;5;179m' + logo + '\x1b[0m\n    \x1b[38;5;214mᚢᚱᚠᚨᛖᛚ\x1b[0m   \x1b[2m' + tag + '\x1b[0m\n';
}

// A gold rounded box around pre-coloured content lines, title set into the top rule. Each line is padded
// to a common inner width measured WITHOUT ANSI codes, so the borders always align. Plain when piped.
function frame(title, lines) {
  const tty = process.stdout.isTTY;
  const G = tty ? '\x1b[38;5;179m' : '', A = tty ? '\x1b[38;5;214m' : '', R = tty ? '\x1b[0m' : '';
  const inner = Math.max(visLen(title) + 4, ...lines.map((l) => visLen(l) + 2), 46);
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

function ask(text) {
  return new Promise((resolve) => {
    // Ctrl+C while a turn streams: stop the brain's in-flight turn, then leave cleanly.
    // race the abort against a short timer so a wedged daemon can't make Ctrl+C hang (req timeout is 5min)
    const onSigint = () => { Promise.race([req('POST', '/abort').catch(() => {}), new Promise((r) => setTimeout(r, 1500))]).then(() => process.exit(0)); };
    process.on('SIGINT', onSigint);
    const done = () => { process.removeListener('SIGINT', onSigint); resolve(); };
    const r = http.request({ socketPath: SOCK, method: 'POST', path: '/ask', headers: { 'Content-Type': 'application/json' }, timeout: 300000 }, (res) => {
      let buf = '', started = false, lastTool = '';
      res.on('data', (d) => {
        buf += d.toString(); let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!ln) continue;
          let e; try { e = JSON.parse(ln); } catch { continue; }
          if (e.kind === 'thinking' && e.tool && e.tool !== lastTool) { lastTool = e.tool; process.stderr.write(dim(`  ⟳ ${e.tool}\n`)); }
          else if (e.kind === 'thinking' && e.delta) { if (!started) { started = true; } process.stdout.write(e.delta); }
          else if (e.kind === 'done') { process.stdout.write('\n' + dim(`— ${e.aborted ? 'stopped' : (e.model || '')}${e.ms ? ' · ' + (e.ms / 1000).toFixed(1) + 's' : ''}\n`)); done(); }
        }
      });
      res.on('end', done);
    });
    r.on('error', () => { console.error(bad('✗') + ' the brain is unreachable, sir.' + dim('  run  ') + gold('urfael doctor') + dim('  to diagnose it')); done(); });
    r.on('timeout', () => { r.destroy(); done(); }); // a wedged daemon mid-stream shouldn't hang the CLI forever
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

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'logo') { console.log(banner()); return; }
  if (!cmd || cmd === 'help' || cmd === '--help') { if (!cmd) console.log(banner()); console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); return; }

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
      const { flags } = hub.scan(text);
      if (!flags.length) { console.log(gold('✓ scan clean') + dim(' — no dangerous patterns found (still your call)')); return; }
      const dangers = flags.filter((f) => f.level === 'danger').length;
      console.log((dangers ? gold('⚠ ' + dangers + ' DANGER') + dim(' + ' + (flags.length - dangers) + ' warn') : gold('⚠ ' + flags.length + ' warning')) + dim(' flag(s):'));
      for (const f of flags) console.log('  ' + (f.level === 'danger' ? gold('[DANGER]') : dim('[warn]  ')) + ' ' + f.why + (f.sample ? dim('  «' + f.sample + '»') : ''));
      if (dangers) process.exit(1); // non-zero exit so scripts/pipelines can gate on a dirty scan
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

  // setup: the onboarding wizard (auth mode + provider config). Pure CLI, runs BEFORE ensureDaemon.
  if (cmd === 'setup' || cmd === 'init' || cmd === 'onboard') { await require('./setup').run(); return; }

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
    const rows = [];
    const add = (good, glyph, label, detail, fix) => {
      good ? healthy++ : attention++;
      rows.push('  ' + glyph + '  ' + label.padEnd(11) + ' ' + detail);
      if (!good && fix) rows.push('       ' + dim('↳ ' + fix));
    };
    const note = (label, detail) => rows.push('  ' + dim('·') + '  ' + label.padEnd(11) + ' ' + dim(detail));
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
    const head = attention === 0
      ? ok('✓ all ' + healthy + ' systems nominal')
      : ok(healthy + ' healthy') + dim(' · ') + warn(attention + (attention === 1 ? ' needs' : ' need') + ' attention');
    console.log(frame('urfael doctor', [head, '', ...rows]));
    return;
  }

  if (!(await ensureDaemon())) { console.error(bad('✗') + ' I could not wake the brain, sir.' + dim('   run  ') + gold('urfael doctor') + dim('  to see why, or check  ~/.claude/urfael/daemon.log')); process.exit(1); }
  // tui: hand the terminal to the full-screen cockpit (ensureDaemon ran first so spawn logs can't corrupt the alt buffer)
  if (cmd === 'tui') { require('./tui').run(); return; }
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
      gold(v.model) + dim('   warm: ' + ((v.warm || []).join(', ') || 'idle')) + '   ' + mode,
      '',
      dim('today    ') + v.turnsToday + ' turns · ' + tok(v.tokToday) + ' tokens · avg ' + v.avgMs + 'ms',
      dim('7-day    ') + gold(spark) + dim('  ' + tok(sum7) + ' tokens'),
      dim('memory   ') + facts + ' facts known · ' + v.memCommits + ' commits',
      dim('ledger   ') + seal,
      dim('uptime   ') + Math.round(v.uptimeS / 60) + 'm' + (v.errors ? dim('   ·   restarts today: ') + v.errors : ''),
    ]));
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
      // urfael team add <channel> <id> [name] [role]
      const [, channel, id, name, role] = rest;
      const { team, error } = lib.addPrincipal(readTeam(), channel, { id, name: name || id, role });
      if (error) { console.error('✗ ' + error); process.exit(1); }
      const shownRole = /^(owner|member|guest)$/.test(role || '') ? role : 'guest';
      writeTeam(team); console.log(gold('✓ added ') + id + dim(' to ' + channel + ' as ' + shownRole + '. Takes effect live.'));
      return;
    }
    if ((sub === 'remove' || sub === 'rm') && rest[1] && rest[2]) {
      const { team, removed } = lib.removePrincipal(readTeam(), rest[1], rest[2]);
      if (!removed) { console.error('✗ ' + rest[2] + ' is not in the ' + rest[1] + ' roster'); process.exit(1); }
      writeTeam(team); console.log(gold('✓ removed ') + rest[2] + dim(' from ' + rest[1]));
      return;
    }
    if (sub === 'add' || sub === 'remove' || sub === 'rm') { console.log('usage: urfael team add <channel> <id> [name] [owner|member|guest]   ·   urfael team remove <channel> <id>'); return; }
    // default: show the roster
    const team = readTeam();
    const chans = Object.keys(team).filter((c) => Array.isArray(team[c]) && team[c].length);
    if (!chans.length) { console.log(dim('single-owner mode — no team.json yet.')); console.log(dim('  add a teammate:  ') + gold('urfael team add telegram <chat-id> "Sam" member')); return; }
    for (const c of chans) {
      console.log(gold(c));
      for (const p of team[c]) { const role = p.role === 'owner' ? gold('owner ') : p.role === 'guest' ? dim('guest ') : 'member'; console.log(`  ${role}  ${dim(String(p.id).slice(0, 18).padEnd(18))}  ${p.name || ''}`); }
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
  if (cmd === 'jobs') { for (const j of await req('GET', '/jobs')) console.log(`${j.id}  ${j.kind}  ${gold(j.state)}  ${dim(j.createdAt || '')}`); return; }
  if (cmd === 'job' && rest[0]) { const j = await req('GET', '/job/' + rest[0]); console.log(JSON.stringify({ ...j, log: undefined }, null, 2)); if (j.log) console.log(dim('--- log tail ---\n') + j.log); return; }
  if (cmd === 'cancel' && rest[0]) { console.log(JSON.stringify(await req('POST', `/job/${rest[0]}/cancel`))); return; }
  if (cmd === 'reminders') {
    const rs = await req('GET', '/reminders');
    if (!rs.length) { console.log('no reminders scheduled'); return; }
    for (const r of rs) console.log(`${r.id}  ${gold(r.at.replace('T', ' ').slice(0, 16))}  ${r.text}${r.repeat ? dim('  (repeats: ' + JSON.stringify(r.repeat) + ')') : ''}`);
    return;
  }
  if (cmd === 'remind') {
    const text = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] || '').startsWith('--')).join(' ');
    const spec = { text };
    if (flag(rest, '--in') != null) spec.inMins = Number(flag(rest, '--in'));
    if (flag(rest, '--at')) spec.at = flag(rest, '--at');
    if (flag(rest, '--cron')) spec.repeat = { cron: flag(rest, '--cron') };                            // full 5-field cron
    else if (flag(rest, '--days')) spec.repeat = { days: flag(rest, '--days'), at: flag(rest, '--days-at') || '09:00' }; // "mon,wed,fri" / "weekdays"
    const rep = flag(rest, '--repeat');
    if (!spec.repeat) { if (rep === 'daily' || rep === 'weekly') spec.repeat = rep; else if (rep) spec.repeat = { everyMins: Number(rep) }; }
    const r = await req('POST', '/remind', spec);
    console.log(r.error ? '✗ ' + r.error : `✓ reminder ${r.id} fires at ${r.at}`);
    return;
  }
  if (cmd === 'unremind' && rest[0]) { console.log(JSON.stringify(await req('POST', `/reminder/${rest[0]}/cancel`))); return; }

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
  await ask([cmd, ...rest].join(' '));
})();
