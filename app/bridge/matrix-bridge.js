'use strict';
// Matrix bridge — owner-allowlisted control of Urfael via the pure HTTPS client-server API (NO inbound port).
// We long-poll GET /_matrix/client/v3/sync; m.room.message events from MATRIX_OWNER_USER_ID ONLY are relayed to
// POST /ask with channel:'matrix', which the daemon forces into the sandboxed 'untrusted' profile. Replies go
// out via PUT /_matrix/client/v3/rooms/{room}/send/m.room.message/{txnId}. Outbound only — no port is opened.
// Works on Node 18+ (built-in https only).
//   node matrix-bridge.js            run the bridge
//   node matrix-bridge.js --notify "text"   one-way push (used by jobs/brief) to MATRIX_ROOM_ID
const core = require('./bridge-core');

const cfg = core.loadEnv();
const HS = String(cfg.MATRIX_HOMESERVER || '').replace(/\/+$/, ''); // https url, no trailing slash
const TOKEN = cfg.MATRIX_TOKEN;
const OWNER = cfg.MATRIX_OWNER_USER_ID;       // @you:server — only this sender is ever answered
const ONLY_ROOM = cfg.MATRIX_ROOM_ID || '';   // optional: restrict to this one room id
const bucket = new core.TokenBucket(8, 20);   // 8 burst, ~20/min sustained — bounds a flood/injection loop
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let txn = Date.now();                          // monotonic-ish transaction id for idempotent sends

// One client-server API call against the homeserver. Bearer token in the Authorization header only — never logged.
function api(method, apiPath, body) {
  const u = new URL(HS + apiPath);
  return core.httpsJson({
    hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
  }, body);
}

// Send a plain-text m.room.message into a room. PUT with a unique txnId so retries can't double-post.
function send(roomId, text) {
  const tid = 'urfael' + (++txn);
  return api('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(tid)}`,
    { msgtype: 'm.text', body: (text || '(empty)').slice(0, 4000) });
}

async function handle(roomId, text, principal) {
  const t0 = Date.now();
  const reply = core.stripSpoken(await core.askDaemon(text, 'matrix', principal)); // TEAM MODE: role-scoped + attributed
  try { await send(roomId, reply); } catch {}                                     // reply to the room the message came from
  core.audit({ ev: 'matrix_turn', principal: principal.name, role: principal.role, inLen: text.length, outLen: reply.length, ms: Date.now() - t0 });
}

// Walk one /sync response: for each joined room's timeline, relay owner m.text messages. Returns next_batch.
function drain(sync) {
  const rooms = (sync.rooms && sync.rooms.join) || {};
  for (const roomId of Object.keys(rooms)) {
    if (ONLY_ROOM && roomId !== ONLY_ROOM) continue;       // optional single-room restriction
    const events = (rooms[roomId].timeline && rooms[roomId].timeline.events) || [];
    for (const e of events) {
      if (e.type !== 'm.room.message') continue;
      const principal = core.resolvePrincipal('matrix', e.sender); // ALLOWLIST (roster: team.json + env fallback), before the brain
      if (!principal) { core.audit({ ev: 'matrix_drop', from: e.sender }); continue; }
      const c = e.content || {};
      if (c.msgtype !== 'm.text' || !c.body) continue;     // text only — ignore media/notice
      const rel = c['m.relates_to'] || {};
      if (rel.rel_type === 'm.replace' || c['m.new_content']) continue; // skip EDITS — they re-arrive as m.text and would re-run a past command
      if (typeof c.body === 'string' && c.body.startsWith(' * ')) continue; // edit fallback body
      if (!bucket.take()) { core.audit({ ev: 'matrix_ratelimited', principal: principal.name }); send(roomId, 'Rate limited — one sec.').catch(() => {}); continue; }
      handle(roomId, c.body, principal).catch(() => {});
    }
  }
  return sync.next_batch;
}

async function main() {
  const i = process.argv.indexOf('--notify');
  if (i >= 0) { if (HS && TOKEN && ONLY_ROOM) { try { await send(ONLY_ROOM, process.argv[i + 1] || ''); } catch {} } process.exit(0); }
  if (!HS || !TOKEN || !OWNER) { console.error('matrix-bridge: set MATRIX_HOMESERVER, MATRIX_TOKEN and MATRIX_OWNER_USER_ID in ~/.claude/urfael/bridge.env'); process.exit(1); }
  if (!/^https:\/\//i.test(HS)) { console.error('matrix-bridge: MATRIX_HOMESERVER must be an https url (no inbound port is ever opened).'); process.exit(1); }
  core.warnExperimental('matrix');
  core.audit({ ev: 'matrix_boot', room: ONLY_ROOM || '(all joined)' });

  let since = '';        // sync cursor (next_batch); empty on first call
  let backoff = 1000;
  // Prime the cursor with a non-blocking sync so we only react to messages that arrive AFTER boot. The prime is
  // MANDATORY and retried with backoff: if we ever entered the long-poll loop with since='' we would receive the
  // FULL room history and replay every past owner message to the brain (backlog flood). Never start without a cursor.
  while (!since) {
    try { const r = await api('GET', '/_matrix/client/v3/sync?timeout=0'); if (r.json && r.json.next_batch) { since = r.json.next_batch; break; } }
    catch (e) { core.audit({ ev: 'matrix_prime_error', err: String((e && e.message) || e), retryMs: backoff }); }
    await sleep(backoff); backoff = Math.min(backoff * 2, 60000);
  }
  backoff = 1000;

  for (;;) {
    let r;
    try {
      r = await api('GET', `/_matrix/client/v3/sync?timeout=30000${since ? '&since=' + encodeURIComponent(since) : ''}`);
    } catch (e) { core.audit({ ev: 'matrix_sync_error', err: String((e && e.message) || e), retryMs: backoff }); await sleep(backoff); backoff = Math.min(backoff * 2, 60000); continue; }
    if (r.status === 429) { core.audit({ ev: 'matrix_429' }); await sleep(backoff); backoff = Math.min(backoff * 2, 60000); continue; }
    if (r.status !== 200 || !r.json) { core.audit({ ev: 'matrix_sync_bad', status: r.status, retryMs: backoff }); await sleep(backoff); backoff = Math.min(backoff * 2, 60000); continue; }
    backoff = 1000;                                          // reset on a clean sync
    try { const nb = drain(r.json); if (nb) since = nb; } catch (e) { core.audit({ ev: 'matrix_drain_error', err: String((e && e.message) || e) }); }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
