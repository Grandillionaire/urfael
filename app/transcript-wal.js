'use strict';
// app/transcript-wal.js — a tiny, crash-safe write-ahead journal for the IN-FLIGHT local turn. PURE + never-throws.
//
// Today the daemon holds the conversation transcript in memory; only the durable jobstore survives a restart, so a
// daemon that dies mid-turn (SIGKILL / OOM / power loss) silently loses the last exchange. This module records the
// user's in-flight message to one small 0600 side file as the turn STARTS and drops it on clean completion; on the
// next boot a surviving entry means the daemon crashed mid-turn, and the user's message is recovered rather than lost.
//
// It is a SIDE journal only: it never touches the turn assembly or the model input, and every function fails SAFE
// (any I/O or parse error is swallowed and turns into a false / null, never a throw), so a broken journal can neither
// block a turn nor wedge a future boot. Single-slot by design: the warm local session is serialized, so at most one
// turn is ever in flight. Zero dependencies (Node built-ins only). Recovery is EXACTLY-ONCE: recover() removes the
// entry as it reads it, so a recovered turn can never double-fire.
//
// Reliability journaling is a common agent pattern. This is a fresh, Urfael-idiomatic module.

const fs = require('fs');
const path = require('path');

const WAL_NAME = '.transcript-wal.json';                 // a dot-file under MEMORY_DIR; normally absent (cleared per turn)
function pathFor(dir) { return path.join(String(dir == null ? '.' : dir), WAL_NAME); }

// record(dir, entry): persist the in-flight turn as it STARTS. Fail-safe — returns true on write, false on any error,
// never throws. Writes to a temp sibling then renames so a crash can never leave a half-written journal; 0600 mode so
// only the owner can read it. Stores exactly the fields the transcript already holds (no extra redaction — same data).
function record(dir, entry) {
  try {
    if (dir == null || typeof dir !== 'string' || !dir) return false;
    const e = entry || {};
    const rec = {
      user: typeof e.user === 'string' ? e.user : '',
      urfael: typeof e.urfael === 'string' ? e.urfael : '',   // usually '' at start; the reply is not yet known
      turnId: Number.isFinite(e.turnId) ? e.turnId : 0,
      t: typeof e.t === 'string' && e.t ? e.t : new Date().toISOString(),
    };
    fs.mkdirSync(dir, { recursive: true });
    const p = pathFor(dir);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
    fs.renameSync(tmp, p);
    return true;
  } catch { return false; }
}

// clear(dir): drop the journal on CLEAN completion (the turn resolved, whether it finished or the owner stopped it).
// Fail-safe — an absent file is not an error worth surfacing; never throws.
function clear(dir) {
  try { fs.unlinkSync(pathFor(dir)); return true; } catch { return false; }
}

// recover(dir): on boot, read a SURVIVING entry (=> the daemon died mid-turn) and REMOVE it, so recovery is
// exactly-once and a corrupt journal can never wedge every future boot. Returns the recovered entry, or null when
// there is nothing usable (absent / garbage / no user message). Never throws on any input.
function recover(dir) {
  let raw;
  try { raw = fs.readFileSync(pathFor(dir), 'utf8'); } catch { return null; }
  // remove the file BEFORE parsing, so even an unparseable journal is consumed exactly once and cannot survive a boot.
  try { fs.unlinkSync(pathFor(dir)); } catch {}
  let e;
  try { e = JSON.parse(raw); } catch { return null; }
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  const user = typeof e.user === 'string' ? e.user : '';
  if (!user) return null;                                 // nothing worth recovering without the user's message
  return {
    user,
    urfael: typeof e.urfael === 'string' ? e.urfael : '',
    turnId: Number.isFinite(e.turnId) ? e.turnId : 0,
    t: typeof e.t === 'string' ? e.t : '',
  };
}

module.exports = { pathFor, record, clear, recover, WAL_NAME };
