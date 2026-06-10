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
const TOKENF = path.join(os.homedir(), '.claude', 'urfael', 'dashboard.token');
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

  // stop is best-effort BEFORE ensureDaemon — never spawn a brain just to abort nothing
  if (cmd === 'stop') { const r = await req('POST', '/abort').catch(() => ({ ok: false })); console.log(r && r.ok ? gold('stopped') : dim('nothing to stop')); return; }

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
