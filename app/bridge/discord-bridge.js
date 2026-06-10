'use strict';
// Discord bridge — owner-allowlisted DM control of Urfael via the Gateway (built-in WebSocket, no deps).
// Owner DMs are relayed to POST /ask with channel:'discord' (sandboxed by the daemon). Outbound only otherwise.
// Needs Node 22+ (global WebSocket) and the bot's MESSAGE CONTENT privileged intent enabled in the dev portal.
//   node discord-bridge.js            run the bridge
//   node discord-bridge.js --notify "text"   one-way push (used by jobs/brief)
const core = require('./bridge-core');

const cfg = core.loadEnv();
const TOKEN = cfg.DISCORD_BOT_TOKEN;
const OWNER = cfg.DISCORD_OWNER_USER_ID;
const INTENTS = (1 << 12) | (1 << 15); // DIRECT_MESSAGES + MESSAGE_CONTENT
const bucket = new core.TokenBucket(8, 20);

let ws, hb, seq = null, acked = true, backoff = 1000;

function send(o) { try { ws.send(JSON.stringify(o)); } catch {} }

async function handle(content) {
  const t0 = Date.now();
  const reply = core.stripSpoken(await core.askDaemon(content, 'discord'));
  try { await core.discordDM(TOKEN, OWNER, reply); } catch {}
  core.audit({ ev: 'discord_turn', inLen: content.length, outLen: reply.length, ms: Date.now() - t0 });
}

function onMessage(p) {
  if (p.s != null) seq = p.s;
  if (p.op === 10) { // hello -> heartbeat + identify
    if (!p.d || !p.d.heartbeat_interval) { try { ws.close(); } catch {} return; } // guard malformed HELLO
    const iv = p.d.heartbeat_interval;
    clearInterval(hb);
    hb = setInterval(() => { if (!acked) { try { ws.close(); } catch {} return; } acked = false; send({ op: 1, d: seq }); }, iv);
    send({ op: 2, d: { token: TOKEN, intents: INTENTS, properties: { os: 'mac', browser: 'urfael', device: 'urfael' } } });
  } else if (p.op === 11) { acked = true; }
  else if (p.op === 1) { send({ op: 1, d: seq }); }
  else if (p.op === 7 || p.op === 9) { try { ws.close(); } catch {} }
  else if (p.op === 0 && p.t === 'MESSAGE_CREATE') {
    const m = p.d;
    if (m.guild_id) return;                                   // DMs only — ignore guild channels
    if (!m.author || m.author.bot) return;                     // ignore bots / self
    if (String(m.author.id) !== String(OWNER)) { core.audit({ ev: 'discord_drop', from: m.author && m.author.id }); return; } // ALLOWLIST
    if (!m.content) return;
    if (!bucket.take()) { core.audit({ ev: 'discord_ratelimited' }); core.discordDM(TOKEN, OWNER, 'Rate limited — one sec.').catch(() => {}); return; }
    handle(m.content).catch(() => {});
  }
}

function connect() {
  ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
  ws.addEventListener('open', () => { backoff = 1000; core.audit({ ev: 'discord_open' }); });
  ws.addEventListener('message', (ev) => { let p; try { p = JSON.parse(ev.data); } catch { return; } onMessage(p); });
  ws.addEventListener('close', () => { clearInterval(hb); acked = true; core.audit({ ev: 'discord_close', retryMs: backoff }); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 60000); }); // exp backoff, reset on open
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}

async function main() {
  const i = process.argv.indexOf('--notify');
  if (i >= 0) { if (TOKEN && OWNER) { try { await core.discordDM(TOKEN, OWNER, process.argv[i + 1] || ''); } catch {} } process.exit(0); }
  if (!TOKEN || !OWNER) { console.error('discord-bridge: set DISCORD_BOT_TOKEN and DISCORD_OWNER_USER_ID in ~/.claude/urfael/bridge.env'); process.exit(1); }
  if (typeof WebSocket === 'undefined') { console.error('discord-bridge: needs Node 22+ (built-in WebSocket). Telegram works on Node 18+.'); process.exit(1); }
  core.audit({ ev: 'discord_boot' });
  connect();
}

main().catch((e) => { console.error(e); process.exit(1); });
