'use strict';
// QQ Bot bridge — owner-allowlisted control of Urfael via Tencent's QQ Bot v2 WebSocket gateway. OUTBOUND ONLY:
// it dials the gateway (built-in WebSocket, no deps) and replies via outbound HTTPS REST — no inbound port, works
// behind NAT, the same posture as the Discord bridge. The universal `relay` channel can't reach QQ (it's
// WebSocket-inbound, not a webhook), so this is a native bridge. Allowlist-before-the-brain, fail-closed.
//
// STATUS: code-complete + unit-tested on the pure parse/allowlist core (parseEvent/buildIntents/nextMsgSeq); the
// live gateway op-code state machine is NOT battle-hardened against a real reviewed QQ app until certified —
// identical honest status to the Matrix/Signal/WhatsApp bridges. The allowlist key is the CONTEXT-SCOPED openid
// (user_openid in DM, member_openid per group), never a display name; enroll each surface separately.
//   node qq-bridge.js              run the bridge
//   node qq-bridge.js --notify "text"   one-way proactive push (consumes the small monthly quota)
const core = require('./bridge-core');

// ── PURE helpers (exported + unit-tested; no I/O) ──────────────────────────────────────────────────
// parseEvent(frame, botUserId) → { senderId, text, msgId, target } | null. Normalizes an op-0 dispatch across the
// four message surfaces; null for self (the loop guard), non-text, or an unknown event type.
function parseEvent(frame, botUserId) {
  if (!frame || frame.op !== 0 || typeof frame.t !== 'string') return null;
  const SURF = { C2C_MESSAGE_CREATE: 'c2c', GROUP_AT_MESSAGE_CREATE: 'group', AT_MESSAGE_CREATE: 'guild', DIRECT_MESSAGE_CREATE: 'guild' };
  const kind = SURF[frame.t]; if (!kind) return null;
  const d = frame.d || {}; const a = d.author || {};
  const senderId = a.user_openid || a.member_openid || a.id || '';
  if (!senderId) return null;
  if (botUserId && a.id && String(a.id) === String(botUserId)) return null;   // self-loop guard (the bot's own message)
  const text = String(d.content || '').replace(/<@!?\d+>/g, '').replace(/\s+/g, ' ').trim();   // strip an @mention token
  if (!text) return null;
  const target = kind === 'c2c' ? { kind: 'c2c', openid: a.user_openid }
    : kind === 'group' ? { kind: 'group', openid: d.group_openid }
      : { kind: 'guild', channelId: d.channel_id };
  return { senderId: String(senderId), text, msgId: d.id, target };
}
// buildIntents(opts) → the gateway intents bitmask. Default: group @-messages + C2C. opts.guildDm adds the guild
// surfaces. (The 1<<25 / 1<<30 / 1<<12 bits are the v2 GROUP_AND_C2C_EVENT / PUBLIC_GUILD_MESSAGES / DIRECT_MESSAGE.)
function buildIntents(opts = {}) {
  let intents = (1 << 25);                                              // GROUP_AND_C2C_EVENT
  if (opts.guildDm) intents |= (1 << 30) | (1 << 12);                  // public guild messages + guild direct messages
  return intents;
}
// nextMsgSeq(map, msgId) → an incrementing per-msg_id sequence (a passive reply needs a fresh msg_seq each time).
function nextMsgSeq(map, msgId) { const n = (map.get(msgId) || 0) + 1; map.set(msgId, n); return n; }

module.exports = { parseEvent, buildIntents, nextMsgSeq };

// ── LIVE SHELL (only when run directly) — the gateway state machine + token refresh + passive reply ──
if (require.main === module) {
  const cfg = core.loadEnv();
  const APP_ID = cfg.QQ_APP_ID, APP_SECRET = cfg.QQ_APP_SECRET, OWNER = cfg.QQ_OWNER_OPENID;
  const INTENTS = buildIntents({ guildDm: cfg.QQ_INTENTS_GUILD_DM === '1' });
  const bucket = new core.TokenBucket(8, 20);
  const seqMap = new Map();
  let ws, hb, seq = null, acked = true, backoff = 1000, accessToken = '', botUserId = '', sessionId = '', tokenTimer = null;

  const send = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };

  async function refreshToken() {
    try {
      const r = await core.httpsJson({ hostname: 'bots.qq.com', path: '/app/getAppAccessToken', method: 'POST', headers: { 'Content-Type': 'application/json' } }, { appId: APP_ID, clientSecret: APP_SECRET });
      const tok = r.json && r.json.access_token; const exp = (r.json && Number(r.json.expires_in)) || 7200;
      if (tok) { accessToken = tok; clearTimeout(tokenTimer); tokenTimer = setTimeout(refreshToken, Math.max(60, exp - 90) * 1000); }
    } catch { clearTimeout(tokenTimer); tokenTimer = setTimeout(refreshToken, 60000); }
  }
  async function handle(parsed, principal) {
    const t0 = Date.now();
    const reply = core.stripSpoken(await core.askDaemon(parsed.text, 'qq', principal));
    try { await core.qqSend(parsed.target, accessToken, reply, parsed.msgId, nextMsgSeq(seqMap, parsed.msgId)); } catch {}
    core.audit({ ev: 'qq_turn', principal: principal.name, role: principal.role, inLen: parsed.text.length, outLen: reply.length, ms: Date.now() - t0 });
  }
  function onMessage(p) {
    if (p.s != null) seq = p.s;
    if (p.op === 10) {
      if (!p.d || !p.d.heartbeat_interval) { try { ws.close(); } catch {} return; }
      clearInterval(hb);
      hb = setInterval(() => { if (!acked) { try { ws.close(); } catch {} return; } acked = false; send({ op: 1, d: seq }); }, p.d.heartbeat_interval);
      send({ op: 2, d: { token: 'QQBot ' + accessToken, intents: INTENTS, shard: [0, 1], properties: {} } });
    } else if (p.op === 11) { acked = true; }
    else if (p.op === 1) { send({ op: 1, d: seq }); }
    else if (p.op === 7 || p.op === 9) { try { ws.close(); } catch {} }
    else if (p.op === 0) {
      if (p.t === 'READY') { botUserId = (p.d && p.d.user && p.d.user.id) || ''; sessionId = (p.d && p.d.session_id) || ''; return; }
      const parsed = parseEvent(p, botUserId);
      if (!parsed) return;
      const principal = core.resolvePrincipal('qq', parsed.senderId);   // ALLOWLIST before the brain, fail-closed
      if (!principal) { core.audit({ ev: 'qq_drop', from: parsed.senderId }); return; }
      if (!bucket.take()) { core.audit({ ev: 'qq_ratelimited', principal: principal.name }); return; }
      handle(parsed, principal).catch(() => {});
    }
  }
  async function connect() {
    const g = await core.httpsJson({ hostname: 'api.sgroup.qq.com', path: '/gateway', method: 'GET', headers: { Authorization: 'QQBot ' + accessToken } }).catch(() => null);
    const url = g && g.json && g.json.url; if (!url) { setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 60000); return; }
    ws = new WebSocket(url);
    ws.addEventListener('open', () => { backoff = 1000; core.audit({ ev: 'qq_open' }); });
    ws.addEventListener('message', (ev) => { let p; try { p = JSON.parse(ev.data); } catch { return; } onMessage(p); });
    ws.addEventListener('close', () => { clearInterval(hb); acked = true; core.audit({ ev: 'qq_close', retryMs: backoff }); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 60000); });
    ws.addEventListener('error', () => { try { ws.close(); } catch {} });
  }
  (async () => {
    const i = process.argv.indexOf('--notify');
    if (!APP_ID || !APP_SECRET || !OWNER) { console.error('qq-bridge: set QQ_APP_ID, QQ_APP_SECRET, QQ_OWNER_OPENID in ~/.claude/urfael/bridge.env'); process.exit(1); }
    if (typeof WebSocket === 'undefined') { console.error('qq-bridge: needs Node 22+ (built-in WebSocket).'); process.exit(1); }
    await refreshToken();
    if (i >= 0) { try { await core.qqSend({ kind: 'c2c', openid: OWNER }, accessToken, process.argv[i + 1] || '', 'notify', 1); } catch {} process.exit(0); }
    core.audit({ ev: 'qq_boot' });
    connect();
  })().catch((e) => { console.error(e); process.exit(1); });
}
