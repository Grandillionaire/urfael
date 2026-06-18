'use strict';
// `urfael setup` — a friendly first-run onboarding wizard. Pure CLI, no brain needed; runs before ensureDaemon.
// It chooses how Urfael reaches Claude (subscription / API key / local model), writes ~/.claude/urfael/provider.env
// (mode 0600 — it may hold an API key), checks the essentials, and offers to (re)start the always-on daemon.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const JDIR = path.join(os.homedir(), '.claude', 'urfael');
const PROVIDER_ENV = path.join(JDIR, 'provider.env');
const VAULT = path.join(os.homedir(), process.env.URFAEL_VAULT_DIR || 'Urfael');
const gold = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const warn = (s) => `\x1b[38;5;208m${s}\x1b[0m`;

// A small line reader robust for BOTH a real TTY (with masked key input) and piped/scripted stdin — avoids the
// readline.question race that drops buffered lines on a pipe. One stdin listener, a line queue, optional masking.
function makeIO() {
  const stdin = process.stdin;
  const tty = !!stdin.isTTY;
  let buf = '', mask = false, pending = null;
  const queue = [];
  const give = (l) => { if (pending) { const p = pending; pending = null; p(l.trim()); } else queue.push(l.trim()); };
  if (tty) { try { stdin.setRawMode(true); } catch {} }
  stdin.resume(); stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    for (const ch of chunk) {
      if (ch === '') { process.stdout.write('\n'); process.exit(130); }       // Ctrl-C
      else if (ch === '\r' || ch === '\n') { if (tty) process.stdout.write('\n'); const l = buf; buf = ''; mask = false; give(l); }
      else if (ch === '' || ch === '\b') { if (buf.length) { buf = buf.slice(0, -1); if (tty) process.stdout.write('\b \b'); } }
      else if (ch >= ' ') { buf += ch; if (tty) process.stdout.write(mask ? '*' : ch); }  // printable only (drops escape seqs)
    }
  });
  const next = () => new Promise((res) => { if (queue.length) res(queue.shift()); else pending = res; });
  return {
    ask: (q) => { process.stdout.write(q); mask = false; return next(); },
    askHidden: (q) => { process.stdout.write(q); mask = tty; return next(); },          // mask only matters on a TTY
    close: () => { if (tty) { try { stdin.setRawMode(false); } catch {} } stdin.pause(); },
  };
}
function has(bin) { // scan PATH for an executable — no shell (avoids the shell-args deprecation + injection)
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  return (process.env.PATH || '').split(path.delimiter).some((d) => d && exts.some((e) => { try { fs.accessSync(path.join(d, bin + e), fs.constants.X_OK); return true; } catch { return false; } }));
}
function claudePath() { return ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude'].find((p) => { try { fs.accessSync(p); return true; } catch { return false; } }) || (has('claude') ? 'claude' : ''); }

// Best-effort auto-detect of who the user is, so we can fill the CLAUDE.md {{PLACEHOLDERS}} instead of making
// them hand-edit (a step everyone forgets — then the brain literally addresses you as "{{USER_NAME}}").
function detectPersona() {
  const tryCmd = (c) => { try { return spawnSync('sh', ['-c', c], { stdio: ['ignore', 'pipe', 'ignore'] }).stdout.toString().trim(); } catch { return ''; } };
  let name = tryCmd('git config user.name');
  const email = tryCmd('git config user.email');
  if (!name && email) name = email.split('@')[0];
  if (!name) name = process.env.USER || process.env.LOGNAME || '';
  let tz = '', locale = '';
  try { const o = Intl.DateTimeFormat().resolvedOptions(); tz = o.timeZone || ''; locale = o.locale || ''; } catch {}
  const city = tz.includes('/') ? tz.split('/').pop().replace(/_/g, ' ') : '';
  const LANGS = { en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', ru: 'Russian', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', ar: 'Arabic', hi: 'Hindi', pl: 'Polish', tr: 'Turkish', sv: 'Swedish', uk: 'Ukrainian' };
  const language = LANGS[(locale.split('-')[0] || 'en').toLowerCase()] || 'English';
  return { name, city, timezone: tz, language };
}

// read provider.env into a {KEY:val} map (so we edit non-destructively), and write it back atomic + 0600
function readEnv() {
  const out = {};
  try { for (const l of fs.readFileSync(PROVIDER_ENV, 'utf8').split('\n')) { const m = l.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/); if (m && !l.trim().startsWith('#')) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); } } catch {}
  return out;
}
function writeEnv(map) {
  fs.mkdirSync(JDIR, { recursive: true });
  const body = '# Urfael provider config — written by `urfael setup`. 0600; may hold an API key.\n' +
    Object.entries(map).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  const tmp = PROVIDER_ENV + '.tmp';
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, PROVIDER_ENV);
  try { fs.chmodSync(PROVIDER_ENV, 0o600); } catch {}
}

function restartDaemon() {
  // best-effort: kick the launchd/systemd unit if it's loaded, else tell the user. Picks up the new provider.env.
  if (process.platform === 'darwin') {
    const label = 'com.urfael.daemon';
    const r = spawnSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' });
    return r.status === 0;
  }
  const r = spawnSync('systemctl', ['--user', 'restart', 'urfael-daemon'], { stdio: 'ignore' });
  return r.status === 0;
}

async function run() {
  const io = makeIO();
  const p = (s) => process.stdout.write(s + '\n');
  try {
    p('');
    const _G = '\x1b[38;5;179m', _AM = '\x1b[38;5;214m', _RS = '\x1b[0m', _tty = process.stdout.isTTY;
    for (const l of ['   ██╗   ██╗██████╗ ███████╗ █████╗ ███████╗██╗', '   ██║   ██║██╔══██╗██╔════╝██╔══██╗██╔════╝██║', '   ██║   ██║██████╔╝█████╗  ███████║█████╗  ██║', '   ██║   ██║██╔══██╗██╔══╝  ██╔══██║██╔══╝  ██║', '   ╚██████╔╝██║  ██║██║     ██║  ██║███████╗███████╗', '    ╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝╚══════╝╚══════╝'])
      p(_tty ? _G + l + _RS : l);
    p('    ' + (_tty ? _AM + 'ᚢᚱᚠᚨᛖᛚ' + _RS : 'ᚢᚱᚠᚨᛖᛚ') + dim('  setup — an old intelligence, in service to one. Let us get you configured.'));
    p('');

    // 1) dependency check (informational — never blocks)
    const cb = claudePath();
    p('  ' + bold('Checking your machine'));
    p('    ' + (cb ? ok('✓') : warn('!')) + '  claude CLI       ' + (cb ? dim(cb) : warn('not found — install Claude Code first: https://claude.com/claude-code')));
    p('    ' + (has('ffmpeg') ? ok('✓') : dim('·')) + '  ffmpeg           ' + (has('ffmpeg') ? dim('(voice capture)') : dim('optional — for voice')));
    p('    ' + (has('whisper-cli') || has('whisper-cpp') || has('main') ? ok('✓') : dim('·')) + '  whisper.cpp      ' + dim('optional — local speech-to-text'));
    p('    ' + (fs.existsSync(VAULT) ? ok('✓') : dim('·')) + '  vault            ' + (fs.existsSync(VAULT) ? dim(VAULT) : dim('not scaffolded yet — run ./install.sh for the full setup')));
    p('');

    // 2) the key question: how does Urfael reach Claude?
    const cur = readEnv();
    const curMode = cur.ANTHROPIC_BASE_URL ? 'local' : cur.ANTHROPIC_API_KEY ? 'apikey' : 'subscription';
    p('  ' + bold('How should Urfael reach Claude?') + dim('   (current: ' + curMode + ')'));
    p('    ' + gold('1') + ')  Claude subscription   ' + dim('— your Pro/Max login. No key, flat rate. Recommended.'));
    p('    ' + gold('2') + ')  Anthropic API key     ' + dim('— pay-per-token. For when you do not have a subscription.'));
    p('    ' + gold('3') + ')  Local model / custom  ' + dim('— run on your own GPU or endpoint (see docs/LOCAL-GPU.md).'));
    p('');
    let choice = '';
    while (!['1', '2', '3'].includes(choice)) choice = await io.ask('  Choose ' + gold('[1-3]') + ' (Enter = 1): ') || '1';

    // start from current config and clear the auth keys we manage, then set per the choice
    const next = { ...cur };
    delete next.ANTHROPIC_API_KEY; delete next.ANTHROPIC_BASE_URL; delete next.ANTHROPIC_AUTH_TOKEN;

    if (choice === '1') {
      p('');
      p('  ' + ok('Subscription mode.') + ' Urfael will use your ' + bold('claude') + ' login — nothing to paste.');
      if (cb) { const logged = spawnSync(cb, ['-p', 'reply with: ok'], { stdio: 'ignore', timeout: 20000 }); if (logged.status !== 0) p('  ' + warn('Heads up:') + ' run ' + gold('claude') + ' once to sign in, then come back.'); }
      else p('  ' + warn('Install + sign into Claude Code first: https://claude.com/claude-code'));
    } else if (choice === '2') {
      p('');
      p('  ' + dim('Paste your Anthropic API key (starts with ') + gold('sk-ant-') + dim('). Input is hidden.'));
      p('  ' + dim('Get one at https://console.anthropic.com/settings/keys — note: this BILLS PER TOKEN, unlike the subscription.'));
      let key = '';
      while (!key) { key = await io.askHidden('  API key: '); if (!key) p('  ' + warn('Empty — try again (or Ctrl+C to cancel).')); }
      if (!/^sk-ant-/.test(key)) { const go = await io.ask('  ' + warn('That does not look like an sk-ant- key. Use it anyway?') + ' ' + gold('[y/N]') + ': '); if (!/^y/i.test(go)) { p('  ' + dim('Cancelled — no changes written.')); io.close(); return; } }
      next.ANTHROPIC_API_KEY = key;
      p('  ' + ok('API-key mode set.') + ' ' + dim('Cost will show as a real per-token estimate in `urfael status`.'));
    } else {
      p('');
      p('  ' + dim('Point Urfael at a proxy that speaks the Anthropic API (it sits in front of Ollama / LM Studio /'));
      p('  ' + dim('NVIDIA NIM / OpenRouter — see docs/LOCAL-GPU.md). The sandbox + credential-deny hold whatever'));
      p('  ' + dim('model answers (enforced by the harness, not the model). Pick a known proxy or enter a URL:'));
      p('    ' + gold('1') + ')  claude-code-router  ' + dim('http://127.0.0.1:3456'));
      p('    ' + gold('2') + ')  LiteLLM             ' + dim('http://127.0.0.1:4000'));
      p('    ' + gold('3') + ')  Custom URL');
      const PRESET = { '1': 'http://127.0.0.1:3456', '2': 'http://127.0.0.1:4000' };
      let pick = ''; while (!['1', '2', '3'].includes(pick)) pick = await io.ask('  Choose ' + gold('[1-3]') + ' (Enter = 1): ') || '1';
      let url = PRESET[pick] || '';
      if (!url) { while (!/^https?:\/\//.test(url)) url = await io.ask('  Base URL ' + dim('(e.g. http://127.0.0.1:3456)') + ': '); }
      else p('  ' + dim('using ' + url));
      next.ANTHROPIC_BASE_URL = url;
      next.ANTHROPIC_AUTH_TOKEN = (await io.ask('  Auth token ' + dim('(Enter = "local")') + ': ')) || 'local';
      const om = await io.ask('  Map the Opus tier to which model? ' + dim('(Enter = skip)') + ': ');
      const sm = await io.ask('  Map the Sonnet tier to which model? ' + dim('(Enter = skip)') + ': ');
      if (om) next.URFAEL_OPUS_MODEL = om;
      if (sm) next.URFAEL_SONNET_MODEL = sm;
      p('  ' + ok('Provider set.') + ' ' + dim('Any model now answers; the sandbox + guarantees are unchanged. Cost meter reads $0.'));
    }

    // 2b) optional: semantic recall (a local embeddings endpoint). Off by default → recall stays lexical BM25.
    p('');
    p('  ' + bold('Semantic recall?') + dim('   (optional) — surface past turns by MEANING, not just shared words.'));
    p('  ' + dim('Needs a local OpenAI-compatible /v1/embeddings endpoint (Ollama / LM Studio). Skips to lexical if off.'));
    const wantSem = await io.ask('  Enable it? ' + gold('[y/N]') + ' (current: ' + (cur.URFAEL_EMBED_URL ? 'on' : 'off') + '): ');
    delete next.URFAEL_EMBED_URL; delete next.URFAEL_EMBED_MODEL;
    if (/^y/i.test(wantSem)) {
      let eurl = '';
      while (!/^https?:\/\//.test(eurl)) eurl = await io.ask('  Embeddings URL ' + dim('(e.g. http://127.0.0.1:11434/v1/embeddings)') + ': ');
      next.URFAEL_EMBED_URL = eurl;
      next.URFAEL_EMBED_MODEL = (await io.ask('  Embedding model ' + dim('(Enter = nomic-embed-text)') + ': ')) || 'nomic-embed-text';
      p('  ' + ok('Semantic recall on.') + ' ' + dim('History indexes lazily as you recall; falls back to BM25 if the endpoint is down.'));
    } else {
      p('  ' + dim('Lexical BM25 recall (the default). You can enable semantic recall later by re-running setup.'));
    }

    // 2c) Fortress vs Full mode — the secure default, or opt into Hermes-level reach for remote turns.
    p('');
    p('  ' + bold('Mode for remote (chat) turns?') + dim('   (current: ' + (cur.URFAEL_MODE === 'full' ? 'full' : 'fortress') + ')'));
    p('    ' + gold('1') + ')  Fortress  ' + dim('— recommended. Remote turns are read-only, no web, no write. Smallest blast radius.'));
    p('    ' + gold('2') + ')  Full      ' + dim('— remote owner/member can browse + search the web (web reach). Still no write/shell/bypass,'));
    p('         ' + dim('still framed, and credential files stay denied (read + write) — so even Full is safer than Hermes default.'));
    delete next.URFAEL_MODE;
    const mpick = await io.ask('  Choose ' + gold('[1-2]') + ' (Enter = 1, Fortress): ');
    if (/^2/.test(mpick)) { next.URFAEL_MODE = 'full'; p('  ' + warn('Full mode set.') + ' ' + dim('Remote turns can now reach the web. You can switch back anytime.')); }
    else p('  ' + ok('Fortress (secure default).'));

    // 2d) personalize — auto-detect + FILL the CLAUDE.md placeholders so Urfael knows who it serves from turn one
    //     (no more hand-editing {{USER_NAME}}; the #1 forgotten first-run step).
    try {
      const CLAUDE_MD = path.join(VAULT, 'CLAUDE.md');
      let md = ''; try { md = fs.readFileSync(CLAUDE_MD, 'utf8'); } catch {}
      if (md && /\{\{(USER_NAME|CITY|TIMEZONE|LANGUAGE)\}\}/.test(md)) {
        p('');
        p('  ' + bold('Who do I serve?') + dim('   I detected these — press Enter to accept each, or type a correction.'));
        const d = detectPersona();
        const ask = async (label, val) => (await io.ask('    ' + label.padEnd(9) + (val ? dim('[' + val + '] ') : '') + ': ')).trim() || val;
        const name = await ask('name', d.name);
        const city = await ask('city', d.city);
        const tz = await ask('timezone', d.timezone);
        const lang = await ask('language', d.language);
        md = md.replace(/\{\{USER_NAME\}\}/g, name || 'friend').replace(/\{\{CITY\}\}/g, city || 'your city')
          .replace(/\{\{TIMEZONE\}\}/g, tz || 'local').replace(/\{\{LANGUAGE\}\}/g, lang || 'English');
        fs.writeFileSync(CLAUDE_MD, md);
        p('  ' + ok('✓ Personalized ') + dim(CLAUDE_MD) + dim('  — Urfael now knows who it serves, from the first turn.'));
      }
    } catch {}

    writeEnv(next);
    p('');
    p('  ' + ok('✓ Wrote ') + dim(PROVIDER_ENV) + ok(' (0600).'));

    // 3) restart so the running daemon picks it up
    const restart = await io.ask('  Restart the Urfael daemon now to apply? ' + gold('[Y/n]') + ': ');
    if (!/^n/i.test(restart)) {
      p('  ' + (restartDaemon() ? ok('✓ daemon restarted.') : dim('daemon not managed by a service — it will use the new config next start.')));
    }

    p('');
    p('  ' + bold('You are set.') + '  Next:');
    p('    ' + gold('cd app && npm start') + dim('   — open the Console'));
    p('    ' + gold('urfael status') + dim('         — confirm the brain is warm'));
    p('    ' + gold('urfael setup') + dim('          — re-run this anytime to switch modes'));
    p('');
  } finally { io.close(); }
}

module.exports = { run, readEnv, writeEnv, PROVIDER_ENV };
