'use strict';
// Signal bridge — owner-allowlisted control of Urfael by wrapping the user-installed `signal-cli` binary.
// REQUIRES signal-cli (https://github.com/AsamK/signal-cli) installed and the SIGNAL_ACCOUNT already registered
// or linked. NO inbound port: we spawn `signal-cli -a ACCOUNT receive --json` and parse its JSON lines. Only
// dataMessages from SIGNAL_OWNER_NUMBER are relayed to POST /ask with channel:'signal', which the daemon forces
// into the sandboxed 'untrusted' profile. Replies go out via `signal-cli -a ACCOUNT send -m <reply> OWNER`.
//   node signal-bridge.js            run the bridge
//   node signal-bridge.js --notify "text"   one-way push (used by jobs/brief) to SIGNAL_OWNER_NUMBER
const { spawn, execFile, execFileSync } = require('child_process');
const core = require('./bridge-core');

const cfg = core.loadEnv();
const CLI = cfg.SIGNAL_CLI_PATH || 'signal-cli';
const ACCOUNT = cfg.SIGNAL_ACCOUNT;            // +E164 of the bridge's own Signal number
const OWNER = cfg.SIGNAL_OWNER_NUMBER;         // +E164 of the single allowlisted sender
const OWNER_UUID = (cfg.SIGNAL_OWNER_UUID || '').trim().toLowerCase(); // optional: newer signal-cli may send only sourceUuid
const bucket = new core.TokenBucket(8, 20);    // 8 burst, ~20/min sustained — bounds a flood/injection loop
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Confirm signal-cli is actually runnable before we depend on it. Returns true/false; never throws.
function cliPresent() {
  try { execFileSync(CLI, ['--version'], { timeout: 15000, stdio: 'ignore' }); return true; } catch { return false; }
}

// Send a text reply to the owner number. -m carries the body; recipient is the LAST arg. Never logs the body.
function send(text, to) {
  return new Promise((resolve) => {
    execFile(CLI, ['-a', ACCOUNT, 'send', '-m', (text || '(empty)').slice(0, 4000), to || OWNER],
      { timeout: 60000 }, (err) => { if (err) core.audit({ ev: 'signal_send_error', err: String((err && err.message) || err) }); resolve(); });
  });
}

async function handle(text, principal, to) {
  const t0 = Date.now();
  const reply = core.stripSpoken(await core.askDaemon(text, 'signal', principal)); // TEAM MODE: role-scoped + attributed
  await send(reply, to);                                                           // reply to the sender's number/source
  core.audit({ ev: 'signal_turn', principal: principal.name, role: principal.role, inLen: text.length, outLen: reply.length, ms: Date.now() - t0 });
}

// Parse one JSON line from `receive --json` -> relay an owner dataMessage. signal-cli wraps everything in an
// `envelope`; the sender is envelope.sourceNumber (older builds) or envelope.source. ALLOWLIST before the brain.
function onLine(line) {
  let env;
  try { env = JSON.parse(line); } catch { return; }       // ignore non-JSON / partial lines
  const e = env && env.envelope;
  if (!e) return;
  const dm = e.dataMessage;
  if (!dm || !dm.message) return;                          // text dataMessages only — ignore receipts/typing/sync
  const from = e.sourceNumber || e.source;
  const uuid = (e.sourceUuid || '').toLowerCase();
  // ALLOWLIST (roster: team.json + env fallback), before the brain: a principal may be listed by E.164 number
  // OR by uuid — newer signal-cli builds may carry only sourceUuid, so we resolve against either.
  const principal = core.resolvePrincipal('signal', from) || (uuid && core.resolvePrincipal('signal', uuid));
  if (!principal) { core.audit({ ev: 'signal_drop', from: from || uuid }); return; }
  if (!bucket.take()) { core.audit({ ev: 'signal_ratelimited', principal: principal.name }); send('Rate limited — one sec.', from).catch(() => {}); return; }
  handle(dm.message, principal, from).catch(() => {});
}

// Spawn `receive --json` and stream-parse its stdout line by line. Resolves when the child exits so the caller
// can restart it (signal-cli's `receive` is a one-shot/streaming process depending on build/flags).
function receiveOnce() {
  return new Promise((resolve) => {
    const child = spawn(CLI, ['-a', ACCOUNT, 'receive', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (ln) onLine(ln); }
    });
    // audit only that stderr happened + its size — signal-cli emits account/identity diagnostics here that we
    // don't want persisted verbatim into the audit log.
    child.stderr.on('data', (d) => core.audit({ ev: 'signal_stderr', bytes: d.length }));
    child.on('error', (err) => { core.audit({ ev: 'signal_spawn_error', err: String((err && err.message) || err) }); resolve(); });
    child.on('close', (code) => { if (buf.trim()) onLine(buf.trim()); core.audit({ ev: 'signal_receive_exit', code }); resolve(); });
  });
}

async function main() {
  const i = process.argv.indexOf('--notify');
  if (i >= 0) {
    if (ACCOUNT && OWNER && cliPresent()) { try { await send(process.argv[i + 1] || ''); } catch {} }
    process.exit(0);
  }
  if (!ACCOUNT || !OWNER) { console.error('signal-bridge: set SIGNAL_ACCOUNT (+E164) and SIGNAL_OWNER_NUMBER (+E164) in ~/.claude/urfael/bridge.env'); process.exit(1); }
  if (!cliPresent()) { console.error('signal-bridge: `' + CLI + '` not found or not runnable. Install signal-cli (https://github.com/AsamK/signal-cli) and register/link SIGNAL_ACCOUNT, or set SIGNAL_CLI_PATH.'); process.exit(1); }
  core.warnExperimental('signal');
  core.audit({ ev: 'signal_boot', account: ACCOUNT });

  let backoff = 1000;
  for (;;) {
    const t0 = Date.now();
    await receiveOnce();
    // A clean long-lived receive resets the backoff; a fast crash-loop grows it.
    backoff = (Date.now() - t0) > 30000 ? 1000 : Math.min(backoff * 2, 60000);
    await sleep(backoff);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
