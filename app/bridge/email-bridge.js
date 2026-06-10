'use strict';
// Email bridge — owner-allowlisted mail control of Urfael. Inbound IMAP IDLE, DRAFT-ONLY out (NEVER sends).
// We connect to IMAP over TLS (built-in tls, no deps), LOGIN, SELECT INBOX, then IDLE (poll fallback). New
// UNSEEN mail ONLY from an allowlisted From address is relayed to POST /ask with channel:'email', which the
// daemon forces into the sandboxed 'untrusted' profile. The reply is saved as an IMAP DRAFT (APPEND \Draft) —
// we open NO inbound port and we NEVER auto-send a single message. All mail content is treated as untrusted.
//   node email-bridge.js            run the bridge
//   node email-bridge.js --notify "text"   accepted but no-op (email has no one-way push; draft-only by design)
const tls = require('tls');
const core = require('./bridge-core');

const cfg = core.loadEnv();
const HOST = cfg.EMAIL_IMAP_HOST;
const PORT = parseInt(cfg.EMAIL_IMAP_PORT || '993', 10) || 993;
const USER = cfg.EMAIL_USER;
const PASS = cfg.EMAIL_PASS;                            // an APP-SPECIFIC password — see bridge.env.example
const DRAFTS = cfg.EMAIL_DRAFT_MAILBOX || 'Drafts';
const POLL_SECS = Math.max(10, parseInt(cfg.EMAIL_POLL_SECS || '60', 10) || 60); // IDLE fallback floor
// Allowlist of From addresses — ONLY mail from one of these is ever relayed. Parsed once, lowercased.
const ALLOWED = new Set(String(cfg.EMAIL_ALLOWED_SENDERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
const bucket = new core.TokenBucket(8, 20);            // 8 burst, ~20/min sustained — bounds a flood/injection loop
const processed = new Set();                            // uids fetched this session — so dropped/hostile mail is parsed once, not every poll
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull the bare addr-spec (foo@bar) out of a From header value like '"Name" <foo@bar>' or 'foo@bar'.
function addrOf(from) {
  const s = String(from || '');
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

// Minimal line-buffered IMAP client over one TLS socket. Tags every command, matches the tagged completion
// (OK/NO/BAD), and surfaces untagged ('* …') lines to a watcher so IDLE can react to EXISTS/RECENT.
class Imap {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0); // raw bytes (NOT utf8-decoded) so IMAP {N} literals are counted by BYTE
    this.tag = 0;
    this.lit = 0;               // remaining literal bytes to fold into the current logical line
    this.cur = Buffer.alloc(0); // logical line under assembly (may span literals)
    this.pending = null;     // { tag, lines, resolve, reject } for the in-flight tagged command
    this.untagged = null;    // optional (line) => void watcher for '* …' lines (used during IDLE)
    sock.on('data', (d) => this._onData(d)); // no setEncoding — we need bytes for literal accounting
  }
  // Literal-aware framing: a server line ending in {N}/{N+} means the next N BYTES are opaque literal data
  // (which may contain CRLFs and even text that looks like a tagged completion). We fold those bytes into the
  // current logical line instead of parsing them as protocol — so message bodies can NEVER inject a fake
  // '* …' / 'U7 OK …' line and desync the connection (or slip past the From allowlist).
  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.lit > 0) {
        if (this.buf.length === 0) return;
        const take = Math.min(this.lit, this.buf.length);
        this.cur = Buffer.concat([this.cur, this.buf.subarray(0, take)]);
        this.buf = this.buf.subarray(take); this.lit -= take;
        if (this.lit > 0) return;
      }
      const i = this.buf.indexOf('\r\n');
      if (i < 0) return;
      const full = this.cur.length ? Buffer.concat([this.cur, this.buf.subarray(0, i)]) : this.buf.subarray(0, i);
      this.buf = this.buf.subarray(i + 2);
      const m = /\{(\d+)\+?\}$/.exec(full.toString('latin1')); // a trailing literal declaration?
      if (m) { this.cur = Buffer.concat([full, Buffer.from('\r\n')]); this.lit = parseInt(m[1], 10); continue; }
      this.cur = Buffer.alloc(0);
      this._onLine(full.toString('utf8'));
    }
  }
  _onLine(line) {
    const p = this.pending;
    if (p && line.startsWith(p.tag + ' ')) {
      const code = (line.split(' ')[1] || '').toUpperCase();
      this.pending = null;
      if (code === 'OK') p.resolve(p.lines);
      else p.reject(new Error(line));
      return;
    }
    if (p) p.lines.push(line);
    if (line.startsWith('* ') && this.untagged) { try { this.untagged(line); } catch {} }
  }
  // Send a tagged command and resolve with the collected response lines (rejecting on NO/BAD). One in flight.
  cmd(text) {
    const tag = 'U' + (++this.tag);
    return new Promise((resolve, reject) => {
      if (this.pending) { reject(new Error('imap: command already in flight')); return; }
      this.pending = { tag, lines: [], resolve, reject };
      try { this.sock.write(tag + ' ' + text + '\r\n'); } catch (e) { this.pending = null; reject(e); }
    });
  }
  // Raw write (continuation lines, IDLE, literals) — bypasses the tag machinery.
  raw(text) { try { this.sock.write(text); } catch {} }
}

// Connect + greeting + LOGIN + SELECT INBOX. Returns the ready Imap and whether the server advertised IDLE.
function connect() {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: HOST, port: PORT, servername: HOST }, () => {});
    sock.setTimeout(90000); // a stuck socket (no IDLE traffic) is torn down and reconnected by the caller
    let greeted = false;
    const onErr = (e) => { sock.destroy(); reject(e instanceof Error ? e : new Error('imap socket')); };
    sock.once('error', onErr);
    sock.once('timeout', () => onErr(new Error('imap connect timeout')));
    const imap = new Imap(sock);
    // The server speaks first with an untagged greeting ('* OK …'); wait for it before LOGIN.
    imap.untagged = async (line) => {
      if (greeted) return; greeted = true; imap.untagged = null;
      try {
        const caps = await imap.cmd('CAPABILITY');
        const hasIdle = caps.join(' ').toUpperCase().includes('IDLE');
        // CRITICAL: the password only ever touches this TLS socket. Never logged, never handed to a child.
        await imap.cmd('LOGIN ' + lit(USER) + ' ' + lit(PASS));
        await imap.cmd('SELECT INBOX');
        sock.removeListener('error', onErr);
        resolve({ imap, sock, hasIdle });
      } catch (e) { onErr(e); }
    };
  });
}

// Quote a string as an IMAP quoted-string (escape backslash and dquote). Used for LOGIN args / mailbox names.
function lit(s) { return '"' + String(s).replace(/([\\"])/g, '\\$1') + '"'; }

// Parse a UID SEARCH response ('* SEARCH 12 15 18') into a numeric uid array.
function parseSearch(lines) {
  const out = [];
  for (const l of lines) {
    const m = l.match(/^\* SEARCH\b(.*)$/i);
    if (m) for (const n of m[1].trim().split(/\s+/)) { const u = parseInt(n, 10); if (Number.isFinite(u)) out.push(u); }
  }
  return out;
}

// Pure parse of stitched FETCH lines -> { from, subject, body, inReplyTo }. Extracted so the allowlist-critical
// header parsing is unit-testable without a live server.
// SECURITY: the allowlist decision rides on From, so headers are matched ONLY against the header block (up to the
// first blank line) — NEVER the attacker-controlled body. Otherwise a body line `From: owner@allowed.com` would
// forge an allowed sender and bypass the owner allowlist.
function parseFetch(lines) {
  const text = lines.join('\r\n');
  const bi = text.indexOf('\r\n\r\n');
  const head = bi >= 0 ? text.slice(0, bi) : text;
  const hdr = (re) => { const m = head.match(re); return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : ''; };
  const from = hdr(/^From:\s*(.+)$/im);
  const subject = hdr(/^Subject:\s*(.+)$/im) || '(no subject)';
  const inReplyTo = hdr(/^Message-ID:\s*(.+)$/im); // the incoming Message-ID becomes our In-Reply-To
  let body = '';
  if (bi >= 0) body = text.slice(bi + 4);
  body = body.replace(/^\)\s*$/m, '').replace(/^.*\bFETCH\b.*$/im, '').replace(/\)\s*$/, '').trim();
  return { from, subject, body: body.slice(0, 8000), inReplyTo };
}

// FETCH one uid's From/Subject headers + a text body part. Returns { from, subject, body } as plain strings.
async function fetchMail(imap, uid) {
  // BODY.PEEK[...] does NOT set \Seen — we decide seen-state explicitly, and never mark dropped mail.
  const lines = await imap.cmd('UID FETCH ' + uid
    + ' (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT IN-REPLY-TO MESSAGE-ID)] BODY.PEEK[TEXT])');
  return parseFetch(lines);
}

// Mark a uid \Seen (so we don't re-relay it). Only ever called for ALLOWED mail we actually processed.
function markSeen(imap, uid) { return imap.cmd('UID STORE ' + uid + ' +FLAGS (\\Seen)').catch(() => {}); }

// Build an RFC822 message and APPEND it to the Drafts mailbox with the \Draft flag. This is the ONLY write we
// ever do to mail — we never connect to SMTP and never send. To = original sender, Subject = 'Re: …'.
async function saveDraft(imap, to, subject, body, inReplyTo) {
  const date = new Date().toUTCString().replace(/GMT$/, '+0000');
  const subj = /^re:/i.test(subject) ? subject : 'Re: ' + subject;
  const headers = [
    'From: ' + USER,
    'To: ' + to,
    'Subject: ' + subj,
    'Date: ' + date,
    inReplyTo ? 'In-Reply-To: ' + inReplyTo : '',
    inReplyTo ? 'References: ' + inReplyTo : '',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ].filter(Boolean).join('\r\n');
  // Normalize the body to CRLF and dot-safe (no SMTP, but keep it clean RFC822).
  const msg = headers + '\r\n\r\n' + String(body).replace(/\r?\n/g, '\r\n') + '\r\n';
  const bytes = Buffer.byteLength(msg, 'utf8');
  // APPEND uses a literal {N}; the server replies with a '+ ' continuation, then we stream the message.
  return new Promise((resolve, reject) => {
    const tag = 'U' + (++imap.tag);
    let phase = 'literal';
    const prev = imap.untagged;
    imap.untagged = (line) => { if (line.startsWith('+')) { phase = 'body'; imap.raw(msg + '\r\n'); } };
    imap.pending = {
      tag, lines: [],
      resolve: (l) => { imap.untagged = prev; resolve(l); },
      reject: (e) => { imap.untagged = prev; reject(e); },
    };
    // A bare '+ ' continuation line does not start with '* ', so route it explicitly too.
    const onCont = (d) => {
      if (phase === 'literal' && /(^|\r\n)\+/.test(String(d))) { phase = 'body'; imap.raw(msg + '\r\n'); imap.sock.removeListener('data', onCont); }
    };
    imap.sock.on('data', onCont);
    setTimeout(() => imap.sock.removeListener('data', onCont), 30000);
    try { imap.sock.write(tag + ' APPEND ' + lit(DRAFTS) + ' (\\Draft) {' + bytes + '}\r\n'); }
    catch (e) { imap.pending = null; imap.untagged = prev; reject(e); }
  });
}

// One pass: find UNSEEN uids, and for each allowlisted one relay + draft. Returns nothing; logs via audit.
async function drain(imap) {
  const uids = parseSearch(await imap.cmd('UID SEARCH UNSEEN'));
  for (const uid of uids) {
    if (processed.has(uid)) continue;       // fetch each UNSEEN uid at most once per session (no re-parsing hostile mail every poll)
    processed.add(uid);
    if (processed.size > 5000) processed.clear(); // bound the set; a reconnect re-derives state anyway
    let mail;
    try { mail = await fetchMail(imap, uid); } catch (e) { core.audit({ ev: 'email_fetch_error', uid, err: String((e && e.message) || e) }); continue; }
    const sender = addrOf(mail.from);
    // ALLOWLIST, BEFORE the brain. Not allowed => skip, audit, and DO NOT mark seen (we never touched it).
    if (!ALLOWED.has(sender)) { core.audit({ ev: 'email_drop', from: sender }); continue; }
    if (!bucket.take()) { core.audit({ ev: 'email_ratelimited', from: sender }); continue; } // leave UNSEEN; retried next pass
    const t0 = Date.now();
    try {
      const reply = core.stripSpoken(await core.askDaemon('Subject: ' + mail.subject + '\n\n' + mail.body, 'email'));
      await saveDraft(imap, sender, mail.subject, reply, mail.inReplyTo);
      await markSeen(imap, uid); // only after a draft is safely stored
      core.audit({ ev: 'email_turn', from: sender, inLen: mail.body.length, outLen: reply.length, ms: Date.now() - t0 });
    } catch (e) { core.audit({ ev: 'email_turn_error', from: sender, err: String((e && e.message) || e) }); }
  }
}

// IDLE loop: arm IDLE, on an untagged EXISTS/RECENT send DONE and re-drain; fall back to POLL_SECS re-drain so
// a server without IDLE still works. Resolves (returns) on any socket error so the caller can reconnect.
async function serve({ imap, sock, hasIdle }) {
  await drain(imap); // catch anything that arrived before we armed IDLE
  for (;;) {
    if (hasIdle) {
      await new Promise((resolve) => {
        let done = false;
        // Send DONE so the server completes the IDLE command; only resolve once that tagged OK settles, so
        // imap.pending is clear before drain() issues its next command (no 'command already in flight').
        const finish = () => { if (done) return; done = true; clearTimeout(timer); sock.removeListener('error', finish); imap.untagged = null; imap.raw('DONE\r\n'); };
        const timer = setTimeout(finish, POLL_SECS * 1000); // re-check + re-arm before the server's ~29-min IDLE cap
        imap.untagged = (line) => { if (/\* \d+ (EXISTS|RECENT)/i.test(line)) finish(); };
        sock.once('error', finish);
        imap.cmd('IDLE').then(resolve, resolve); // tagged completion arrives after DONE (or socket error)
      });
    } else {
      await sleep(POLL_SECS * 1000);
    }
    if (sock.destroyed) return;
    try { await drain(imap); } catch (e) { core.audit({ ev: 'email_drain_error', err: String((e && e.message) || e) }); if (sock.destroyed) return; }
  }
}

async function main() {
  const i = process.argv.indexOf('--notify');
  if (i >= 0) { core.audit({ ev: 'email_notify_noop' }); process.exit(0); } // no one-way push: draft-only by design
  if (!HOST || !USER || !PASS || ALLOWED.size === 0) {
    console.error('email-bridge: set EMAIL_IMAP_HOST, EMAIL_USER, EMAIL_PASS (app-specific password) and EMAIL_ALLOWED_SENDERS in ~/.claude/urfael/bridge.env');
    process.exit(1);
  }
  core.audit({ ev: 'email_boot', allowed: ALLOWED.size, drafts: DRAFTS });
  let backoff = 1000;
  for (;;) {
    let conn;
    try { conn = await connect(); }
    catch (e) { core.audit({ ev: 'email_connect_error', err: String((e && e.message) || e), retryMs: backoff }); await sleep(backoff); backoff = Math.min(backoff * 2, 60000); continue; }
    core.audit({ ev: 'email_open', idle: conn.hasIdle });
    backoff = 1000; // reset on a successful connect
    try { await serve(conn); } catch (e) { core.audit({ ev: 'email_serve_error', err: String((e && e.message) || e) }); }
    try { conn.sock.destroy(); } catch {}
    core.audit({ ev: 'email_close', retryMs: backoff });
    await sleep(backoff); backoff = Math.min(backoff * 2, 60000);
  }
}

module.exports = { Imap, parseFetch, addrOf, parseSearch }; // pure pieces, for tests
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
