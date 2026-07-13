'use strict';
// idle-governor.js — a pure, zero-dependency cadence state machine for the OUTBOUND bridge pollers.
//
// Scale-to-zero idle suspension for the outbound bridge pollers. Where Hermes suspends the inbound,
// auth-bearing gateway (on the trust boundary), this governor ONLY decides how long an outbound self-timed poller
// sleeps between polls. It is structurally incapable of touching the security path: it never requires the brain
// socket, never speaks the brain request protocol, and never consults the allowlist. It holds no credentials and
// does no I/O.
//
// nextDelay() returns the hot (active) cadence while the owner has been recently active, and stretches to the low
// frequency idle probe once idle — floored so the idle probe is NEVER faster than the hot cadence. Every timestamp
// fold is max()-guarded, so a backward clock jump or a stale/hostile doorbell mtime can only keep the poller HOT
// (poll MORE often), never suspend it longer and never drop or fast-path a message. All methods never throw on junk.

// Coerce to a finite number strictly greater than zero, else fall back to `def` (never throws).
function posNum(v, def) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : def; }
// Coerce to a finite, non-negative number, else fall back to `def` (never throws).
function nonNegNum(v, def) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : def; }

class IdleGovernor {
  // { activeMs: hot poll cadence, idleAfterMs: no-owner-activity window before dropping to the probe,
  //   probeMs: low-frequency idle probe cadence } — all sanitized, so junk falls back to safe defaults.
  constructor(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    this.activeMs = posNum(o.activeMs, 1000);
    this.idleAfterMs = nonNegNum(o.idleAfterMs, 300000);
    // Floor the probe so idle is NEVER faster than hot (the whole point is fewer polls when idle).
    this.probeMs = Math.max(this.activeMs, posNum(o.probeMs, 60000));
    // Seed lastActivity to construction time so a fresh boot stays HOT for idleAfterMs (no cold start on launch).
    this.last = Date.now();
    // Cached suspension state from the most recent nextDelay(), for cheap state()/suspended() audit reads.
    this._suspended = false;
  }

  // The delay (ms) to sleep before the next poll: activeMs while recently active, else the floored probeMs.
  nextDelay(now) {
    const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    this._suspended = (t - this.last) >= this.idleAfterMs;
    return this._suspended ? this.probeMs : this.activeMs;
  }

  // Owner-traffic snap-back: fold real owner activity so the poller returns to the hot cadence. max()-guarded.
  markActivity(now) {
    const t = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    this.last = Math.max(this.last, t);
  }

  // Doorbell fold: a scheduled/heartbeat push bumps the wake file's mtime; warm the poller for the conversation
  // that follows. 0/absent/negative => no change. max()-guarded, so a stale/hostile mtime can only keep us HOT.
  wakeAt(mtimeMs) {
    const t = Number(mtimeMs);
    if (Number.isFinite(t) && t > 0) this.last = Math.max(this.last, t);
  }

  // Cheap audit reads reflecting the last nextDelay() decision.
  suspended() { return this._suspended; }
  state() { return this._suspended ? 'suspended' : 'active'; }
}

module.exports = { IdleGovernor };
