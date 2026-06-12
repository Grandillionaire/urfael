#!/usr/bin/env node
'use strict';
// urfael — talk to the brain from any terminal. A thin client of the daemon's unix socket
// (same brain, same memory, same warm sessions as the orb). No deps, no API key.
//   urfael setup                               onboarding wizard — pick subscription / API key / local model
//   urfael "what's on my calendar today?"      ask (streams the answer live)
//   urfael status                              vitals: model, latency, turns, tokens, uptime
//   urfael jobs | job <id> | cancel <id>       background jobs
//   urfael reminders                           list reminders
//   urfael remind "text" --in 20 [--repeat daily|weekly|<mins>]   or  --at "2026-06-11T15:00"
//   urfael sessions search <query>             full-text search of every past conversation
//   urfael learn [trusted|proposed|retired]    the learning ledger — what it learned, verified, and pruned (with confidence)
//   urfael team [add <channel> <id> [name] [role] | remove <channel> <id>]   manage the team roster (principals + roles)
//   urfael audit [--json]                      team-mode activity trail (who/when/channel/sandbox) for an admin/auditor
//   urfael cron [add "<prompt>" --daily-at HH:MM | --in N | --repeat daily [--then "<prompt>"] [--script "<cmd>"]] [list|cancel <id>|run <id>]
//                                              scheduled jobs — runs the brain (or, --script, a no-LLM shell cmd) on a schedule,
//                                              delivers the result, and chains a --then follow-up on completion
//   urfael serve [--token]                     start the OpenAI-compatible local API (Open WebUI / any OpenAI client)
//   urfael hooks                               start the loopback webhook receiver (event triggers) — prints its URL
//   urfael hook add "<name>" [--action ask|notify] [--deliver notify|silent|push]   register a webhook (prints the secret once)
//   urfael hook [list | rm <id>]               list / remove webhook event triggers
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
    r.on('error', () => { console.error('brain unreachable'); done(); });
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
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(fs.readFileSync(__filename, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); return; }

  if (cmd === 'sessions') { if (rest[0] === 'search' && rest[1]) searchSessions(rest.slice(1).join(' ')); else console.log('usage: urfael sessions search <query>'); return; }

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

  if (!(await ensureDaemon())) { console.error('✗ brain offline and could not be started'); process.exit(1); }
  // tui: hand the terminal to the full-screen cockpit (ensureDaemon ran first so spawn logs can't corrupt the alt buffer)
  if (cmd === 'tui') { require('./tui').run(); return; }
  if (cmd === 'health') { console.log(JSON.stringify(await req('GET', '/health'))); return; }
  if (cmd === 'shutdown') { await req('POST', '/shutdown').catch(() => {}); console.log('brain stopped'); return; }
  if (cmd === 'status') {
    const v = await req('GET', '/vitals');
    console.log(gold('Urfael') + dim(' · the brain is warm') + (v.mode === 'full' ? '  ' + '\x1b[38;5;208mFULL mode\x1b[0m' : dim('  · fortress mode')));
    console.log(`  model     ${v.model}    warm: ${(v.warm || []).join(', ')}`);
    console.log(`  today     ${v.turnsToday} turns · ${v.tokToday >= 1000 ? Math.round(v.tokToday / 1000) + 'k tokens' : (v.tokToday || 0) + ' tokens'} · avg ${v.avgMs}ms`);
    console.log(`  memory    ${v.memCommits} commits    uptime ${Math.round(v.uptimeS / 60)}m    brain restarts today: ${v.errors}`);
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
      if (flag(rest, '--daily-at')) spec.repeat = { dailyAt: flag(rest, '--daily-at') };
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
      const r = await req('POST', '/hooks', spec);
      if (!r || r.error) { console.error('✗ ' + ((r && r.error) || 'failed')); process.exit(1); }
      const port = parseInt(process.env.URFAEL_HOOKS_PORT, 10) || 7718;
      console.log(gold('✓ webhook ' + r.id) + dim('  action=' + r.action + ' · deliver=' + r.deliver));
      console.log('  URL     ' + gold(`http://127.0.0.1:${port}/hook/${r.id}`));
      console.log('  secret  ' + gold(r.secret) + dim('  (shown once — store it)'));
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
  if (cmd === 'team') {
    // manage the team roster (allowlisted principals per channel + roles) at ~/.claude/urfael/team.json.
    const lib = require('./lib');
    const TEAMF = path.join(os.homedir(), '.claude', 'urfael', 'team.json');
    const readTeam = () => { try { return JSON.parse(fs.readFileSync(TEAMF, 'utf8')); } catch { return {}; } };
    const writeTeam = (t) => { fs.mkdirSync(path.dirname(TEAMF), { recursive: true }); fs.writeFileSync(TEAMF + '.tmp', JSON.stringify(t, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(TEAMF + '.tmp', TEAMF); };
    const sub = rest[0];
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
    const rep = flag(rest, '--repeat');
    if (rep === 'daily' || rep === 'weekly') spec.repeat = rep; else if (rep) spec.repeat = { everyMins: Number(rep) };
    const r = await req('POST', '/remind', spec);
    console.log(r.error ? '✗ ' + r.error : `✓ reminder ${r.id} fires at ${r.at}`);
    return;
  }
  if (cmd === 'unremind' && rest[0]) { console.log(JSON.stringify(await req('POST', `/reminder/${rest[0]}/cancel`))); return; }

  // default: everything is a question for the brain
  await ask([cmd, ...rest].join(' '));
})();
