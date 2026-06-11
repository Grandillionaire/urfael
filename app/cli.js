#!/usr/bin/env node
'use strict';
// urfael — talk to the brain from any terminal. A thin client of the daemon's unix socket
// (same brain, same memory, same warm sessions as the orb). No deps, no API key.
//   urfael "what's on my calendar today?"      ask (streams the answer live)
//   urfael status                              vitals: model, latency, turns, tokens, uptime
//   urfael jobs | job <id> | cancel <id>       background jobs
//   urfael reminders                           list reminders
//   urfael remind "text" --in 20 [--repeat daily|weekly|<mins>]   or  --at "2026-06-11T15:00"
//   urfael sessions search <query>             full-text search of every past conversation
//   urfael learn [trusted|proposed|retired]    the learning ledger — what it learned, verified, and pruned (with confidence)
//   urfael cron [add "<prompt>" --daily-at HH:MM | --in N | --repeat daily] [list|cancel <id>|run <id>]
//                                              scheduled AGENT jobs — runs the brain on a schedule, delivers the result
//   urfael serve [--token]                     start the OpenAI-compatible local API (Open WebUI / any OpenAI client)
//   urfael import [--from openclaw|hermes] [--apply]   migrate memory + skills from another assistant (dry-run by default)
//   urfael skills list                         your installed skills (name + description)
//   urfael skills export <name>                print a skill to stdout to share it
//   urfael skills scan <file>                  static safety-scan a skill .md before trusting it
//   urfael skills install <https-url> [--yes]  fetch a skill .md, scan it, show it, install on confirm (never executes it)
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

  if (!(await ensureDaemon())) { console.error('✗ brain offline and could not be started'); process.exit(1); }
  // tui: hand the terminal to the full-screen cockpit (ensureDaemon ran first so spawn logs can't corrupt the alt buffer)
  if (cmd === 'tui') { require('./tui').run(); return; }
  if (cmd === 'health') { console.log(JSON.stringify(await req('GET', '/health'))); return; }
  if (cmd === 'shutdown') { await req('POST', '/shutdown').catch(() => {}); console.log('brain stopped'); return; }
  if (cmd === 'status') {
    const v = await req('GET', '/vitals');
    console.log(gold('Urfael') + dim(' · the brain is warm'));
    console.log(`  model     ${v.model}    warm: ${(v.warm || []).join(', ')}`);
    console.log(`  today     ${v.turnsToday} turns · ${v.tokToday >= 1000 ? Math.round(v.tokToday / 1000) + 'k tokens' : (v.tokToday || 0) + ' tokens'} · avg ${v.avgMs}ms`);
    console.log(`  memory    ${v.memCommits} commits    uptime ${Math.round(v.uptimeS / 60)}m    brain restarts today: ${v.errors}`);
    return;
  }
  if (cmd === 'cron') {
    const sub = rest[0];
    if (sub === 'add') {
      const prompt = rest.slice(1).filter((a, i) => !a.startsWith('--') && !(rest[i] || '').startsWith('--')).join(' ');
      const spec = { prompt };
      if (flag(rest, '--in') != null) spec.inMins = Number(flag(rest, '--in'));
      if (flag(rest, '--daily-at')) spec.repeat = { dailyAt: flag(rest, '--daily-at') };
      else if (flag(rest, '--repeat')) { const r = flag(rest, '--repeat'); spec.repeat = (r === 'daily' || r === 'weekly') ? r : { everyMins: Number(r) }; }
      if (flag(rest, '--deliver')) spec.deliver = flag(rest, '--deliver');
      const r = await req('POST', '/cron', spec);
      console.log(r && r.error ? '✗ ' + r.error : `✓ cron ${r.id} — first run ${r.at}`);
      return;
    }
    if (sub === 'cancel' && rest[1]) { console.log(JSON.stringify(await req('POST', `/cron/${rest[1]}/cancel`))); return; }
    if (sub === 'run' && rest[1]) { console.log(JSON.stringify(await req('POST', `/cron/${rest[1]}/run`))); return; }
    const cj = await req('GET', '/cron');
    if (!cj || !cj.length) { console.log('no scheduled jobs'); return; }
    for (const j of cj) console.log(`${j.id}  ${gold((j.at || '').replace('T', ' ').slice(0, 16))}  ${(j.prompt || '').slice(0, 60)}${j.repeat ? dim('  (' + JSON.stringify(j.repeat) + ')') : ''}`);
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
