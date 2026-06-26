'use strict';
// SimpleX bridge — owner-allowlisted control of Urfael over SimpleX Chat's queue-based, no-identity network.
// OUTBOUND ONLY: it dials a co-located `simplex-chat -p 5225` CLI on LOOPBACK (the CLI holds the SMP queue
// subscriptions; the bridge binds/listens on nothing). The universal `relay` can't reach SimpleX (no HTTP webhook),
// so this is a native bridge. Allowlist-before-the-brain, fail-closed; the decision logic is the PURE
// lib.parseSimplexEvent (unit-tested) — this file is the decision-free I/O shell.
//
// HARD OPERATIONAL REQUIREMENT: the control WS (ws://localhost:5225) is plaintext + UNAUTHENTICATED by design, so
// whoever reaches it owns the bot's identity. The `-p` port MUST stay loopback-bound + firewalled. Auto-accept ON
// means anyone may CONNECT via the public address; the allowlist gates who is SERVED. The allowlist key is the
// LOCAL integer contactId (captured at a trusted first connect via `urfael team add simplex <id>`), never a name.
// STATUS: code-complete + unit-tested on parse/allowlist; NOT battle-hardened until certified against a live CLI.
//   node simplex-bridge.js              run the bridge (needs the CLI running)
//   node simplex-bridge.js --notify "text"   one-way push to the owner's contactId
const core = require('./bridge-core');
const lib = require('../lib');

const cfg = core.loadEnv();
const WS_URL = cfg.SIMPLEX_WS_URL || 'ws://localhost:5225';
const OWNER = cfg.SIMPLEX_OWNER_CONTACT_ID;
const bucket = new core.TokenBucket(8, 20);
let ws, corr = 0, backoff = 1000, userId = '';
const pending = new Map();   // corrId -> resolve (for our own command round-trips)

function cmd(c) { const id = 'c' + (++corr); return new Promise((resolve) => { pending.set(id, resolve); try { ws.send(JSON.stringify({ corrId: id, cmd: c })); } catch { resolve(null); } setTimeout(() => { if (pending.delete(id)) resolve(null); }, 15000); }); }

async function handle(parsed, principal) {
  const t0 = Date.now();
  const reply = core.stripSpoken(await core.askDaemon(parsed.text, 'simplex', principal));
  try { ws.send(JSON.stringify({ corrId: 'c' + (++corr), cmd: `@${parsed.contactId} ${reply.slice(0, 4000)}` })); } catch {}
  core.audit({ ev: 'simplex_turn', principal: principal.name, role: principal.role, inLen: parsed.text.length, outLen: reply.length, ms: Date.now() - t0 });
}

function onResp(msg) {
  if (!msg || typeof msg !== 'object') return;   // a control-WS frame of JSON `null`/string must not crash the listener
  // a response to OUR OWN command carries our corrId → resolve it and DROP (it's an ack/own-send, never an inbound)
  if (msg.corrId && pending.has(msg.corrId)) { const r = pending.get(msg.corrId); pending.delete(msg.corrId); r(msg.resp || msg); return; }
  if (msg.corrId) return;                                              // any other corrId-tagged frame = our own echo → drop
  const resp = msg.resp || msg;
  if (resp.type === 'contactConnected') {                              // owner-capture: surface the new contactId to enroll
    const id = resp.contact && resp.contact.contactId;
    core.audit({ ev: 'simplex_connected', contactId: id != null ? String(id) : '?' });
    return;
  }
  const parsed = lib.parseSimplexEvent(resp);                          // PURE parse (self-loop + group + no-text guards)
  if (!parsed) return;
  const principal = core.resolvePrincipal('simplex', parsed.contactId); // ALLOWLIST before the brain, fail-closed
  if (!principal) { core.audit({ ev: 'simplex_drop', from: parsed.contactId }); return; }
  if (!bucket.take()) { core.audit({ ev: 'simplex_ratelimited', principal: principal.name }); return; }
  handle(parsed, principal).catch(() => {});
}

async function bootstrap() {
  const u = await cmd('/_get user'); userId = (u && u.user && u.user.userId) || (u && u.userId) || '1';
  await cmd('/_address ' + userId).catch(() => {});                    // ensure an address exists (create if needed)
  await cmd('/_auto_accept ' + userId + ' on').catch(() => {});        // accept connections; the allowlist gates who is served
  core.audit({ ev: 'simplex_ready', userId });
}

function connect() {
  ws = new WebSocket(WS_URL);
  ws.addEventListener('open', () => { backoff = 1000; core.audit({ ev: 'simplex_open' }); bootstrap().catch(() => {}); });
  ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } onResp(m); });
  ws.addEventListener('close', () => { core.audit({ ev: 'simplex_close', retryMs: backoff }); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 60000); });   // can only re-dial; cannot revive a dead CLI
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}

async function main() {
  const i = process.argv.indexOf('--notify');
  if (typeof WebSocket === 'undefined') { console.error('simplex-bridge: needs Node 22+ (built-in WebSocket).'); process.exit(1); }
  if (i >= 0) {
    if (OWNER) { const w = new WebSocket(WS_URL); w.addEventListener('open', () => { try { w.send(JSON.stringify({ corrId: 'n1', cmd: `@${OWNER} ${process.argv[i + 1] || ''}` })); } catch {} setTimeout(() => process.exit(0), 500); }); w.addEventListener('error', () => process.exit(0)); }
    else process.exit(0);
    return;
  }
  core.audit({ ev: 'simplex_boot' });
  connect();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { onResp };   // exported for the shell wiring test (parse→allowlist→handle), with I/O faked
