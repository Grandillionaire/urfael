'use strict';
// iMessage bridge — owner-allowlisted Mac/phone control of Urfael (macOS only, best-effort).
// REQUIRES Full Disk Access for the process that runs this (so it can read ~/Library/Messages/chat.db).
// We poll chat.db READ-ONLY (sqlite3 'file:…?mode=ro') for new INBOUND messages from the single allowlisted
// handle only, and relay each to POST /ask with channel:'imessage' (sandboxed by the daemon). Replies go out
// via AppleScript (`tell application "Messages"`) to that same handle. We NEVER read anyone else's messages.
//   node imessage-bridge.js            run the bridge
//   node imessage-bridge.js --notify "text"   one-way push (used by jobs/brief)
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const core = require('./bridge-core');
const { IdleGovernor } = require('./idle-governor'); // opt-in idle-suspend cadence (URFAEL_IDLE_SUSPEND); inert when the gate is null

const cfg = core.loadEnv();
const HANDLE = cfg.IMESSAGE_OWNER_HANDLE;             // allowlisted phone (+1…) or email
const POLL_SECS = Math.max(1, parseInt(cfg.IMESSAGE_POLL_SECS || '4', 10) || 4);
const DB = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
const bucket = new core.TokenBucket(8, 20); // 8 burst, ~20/min sustained — bounds a flood/injection loop
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run a read-only sqlite3 query against chat.db. Read-only URI + -readonly so we can never mutate the store.
function sqlite(query) {
  return new Promise((resolve, reject) => {
    execFile('sqlite3', ['-readonly', '-newline', '\x1e', '-separator', '\x1f', `file:${DB}?mode=ro`, query],
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}

// Newest inbound text (is_from_me=0) messages from the allowlisted handle with ROWID > sinceRowid.
// Bound to the owner handle in SQL — the bridge never even fetches other people's rows.
function rowsSince(sinceRowid) {
  // Apple stores the body in `text`, or in `attributedBody` for newer rows; we only read plain `text`.
  const q =
    "SELECT m.ROWID, m.text FROM message m "
    + "JOIN handle h ON m.handle_id = h.ROWID "
    + "WHERE m.is_from_me = 0 AND m.text IS NOT NULL AND m.text != '' "
    + "AND m.cache_roomnames IS NULL " // 1:1 only — never answer the owner's own messages relayed into a group
    + `AND h.id = '${String(HANDLE).replace(/'/g, "''")}' `
    + `AND m.ROWID > ${parseInt(sinceRowid, 10) || 0} ORDER BY m.ROWID ASC;`;
  return sqlite(q).then((out) =>
    out.split('\x1e').map((r) => r.replace(/\n$/, '')).filter(Boolean).map((r) => {
      const i = r.indexOf('\x1f');
      return { rowid: parseInt(r.slice(0, i), 10), text: r.slice(i + 1) };
    }).filter((r) => Number.isFinite(r.rowid)));
}

// Current max ROWID, so on startup we only react to messages that arrive AFTER we boot (no backlog replay).
async function maxRowid() {
  try { const out = await sqlite('SELECT IFNULL(MAX(ROWID),0) FROM message;'); return parseInt(out.trim(), 10) || 0; }
  catch { return 0; }
}

async function handle(text, principal) {
  const t0 = Date.now();
  const reply = core.stripSpoken(await core.askDaemon(text, 'imessage', principal)); // TEAM MODE: role-scoped + attributed
  try { await core.imessageSend(principal.id, reply); } catch (e) { core.audit({ ev: 'imessage_send_error', err: String((e && e.message) || e) }); }
  core.audit({ ev: 'imessage_turn', principal: principal.name, role: principal.role, inLen: text.length, outLen: reply.length, ms: Date.now() - t0 });
}

async function main() {
  const i = process.argv.indexOf('--notify');
  if (i >= 0) { if (process.platform === 'darwin' && HANDLE) { try { await core.imessageSend(HANDLE, process.argv[i + 1] || ''); } catch {} } process.exit(0); }
  if (process.platform !== 'darwin') { console.error('imessage-bridge: macOS only.'); process.exit(1); }
  if (!HANDLE) { console.error('imessage-bridge: set IMESSAGE_OWNER_HANDLE in ~/.claude/urfael/bridge.env'); process.exit(1); }
  try { fs.accessSync(DB, fs.constants.R_OK); await sqlite('SELECT 1;'); }
  catch { console.error('imessage-bridge: cannot read ' + DB + ' — grant Full Disk Access to the runner (System Settings > Privacy & Security > Full Disk Access) and ensure sqlite3 is installed.'); process.exit(1); }

  // start from the newest existing ROWID so we never replay the owner's whole history. A transient read
  // failure here returns 0 — retry a few times rather than default the cursor to 0 and backfill everything.
  let last = 0;
  for (let i = 0; i < 3 && !last; i++) { last = await maxRowid(); if (!last) await sleep(500); }
  core.audit({ ev: 'imessage_start', sinceRowid: last });
  // IDLE-SUSPEND (opt-in, default OFF): when the gate is null no governor exists and the poll cadence below is the
  // byte-identical original POLL_SECS. When on, the governor stretches the 4s hot cadence to the idle probe once the
  // owner has gone quiet, and snaps back on owner traffic or a notifyAll doorbell. It NEVER touches the allowlist.
  const idleCfg = core.idleSuspendGate();
  const gov = idleCfg ? new IdleGovernor({ activeMs: POLL_SECS * 1000, ...idleCfg }) : null;
  let wasSuspended = false;
  for (;;) {
    await sleep(gov ? gov.nextDelay() : POLL_SECS * 1000);
    if (gov && gov.suspended() && !wasSuspended) core.audit({ ev: 'idle_suspend' }); // audit ONCE on the active->suspended edge
    if (gov) wasSuspended = gov.suspended();
    gov && gov.wakeAt(core.wakeMtime()); // fold the doorbell (a heartbeat/scheduled push warms us; missing file => 0 => no change)
    let rows = [];
    try { rows = await rowsSince(last); } catch (e) { core.audit({ ev: 'imessage_poll_error', err: String((e && e.message) || e) }); continue; }
    // single-handle SQL (bound to HANDLE), so resolve the principal once. True multi-handle imessage = a SQL
    // follow-up; for now this gives imessage the role + attribution + audit plumbing for the configured handle.
    const principal = core.resolvePrincipal('imessage', HANDLE);
    if (!principal) { core.audit({ ev: 'imessage_drop', from: HANDLE }); continue; } // handle not in the roster
    for (const r of rows) {
      last = Math.max(last, r.rowid);
      if (!r.text) continue;
      if (!bucket.take()) { core.audit({ ev: 'imessage_ratelimited' }); core.imessageSend(principal.id, 'Rate limited — one sec.').catch(() => {}); continue; }
      handle(r.text, principal).catch(() => {});
    }
    if (gov && rows.length) { gov.markActivity(); core.audit({ ev: 'idle_wake' }); } // owner traffic => snap back to the hot cadence
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
