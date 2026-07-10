'use strict';
// Email bridge — owner-allowlisted mail control of Urfael. Inbound IMAP IDLE, DRAFT-ONLY out (NEVER sends).
// We connect to IMAP over TLS (built-in tls, no deps), LOGIN, SELECT INBOX, then IDLE (poll fallback). New
// UNSEEN mail ONLY from an allowlisted From address is relayed to POST /ask with channel:'email', which the
// daemon forces into the sandboxed 'untrusted' profile. The reply is saved as an IMAP DRAFT (APPEND \Draft) —
// we open NO inbound port and we NEVER auto-send a single message. All mail content is treated as untrusted.
//   node email-bridge.js            run the bridge
//   node email-bridge.js --notify "text"   no-op for OUTBOUND (email is draft-only out; inbound PUSH uses EMAIL_TRIGGERS)
// EMAIL-PUSH TRIGGERS: EMAIL_TRIGGERS=[{from?,subject?,action:'notify'|'ask'}] — a matching inbound email fires a
// one-way push to the owner (the native "when email matching X arrives, do Y" primitive). The draft is unchanged.
const tls = require('tls');
const core = require('./bridge-core');
const { IdleGovernor } = require('./idle-governor'); // opt-in idle-suspend (URFAEL_IDLE_SUSPEND); gates ONLY the non-IDLE fallback sleep

const cfg = core.loadEnv();
const HOST = cfg.EMAIL_IMAP_HOST;
const PORT = parseInt(cfg.EMAIL_IMAP_PORT || '993', 10) || 993;
const USER = cfg.EMAIL_USER;
const PASS = cfg.EMAIL_PASS;                            // an APP-SPECIFIC password — see bridge.env.example
const DRAFTS = cfg.EMAIL_DRAFT_MAILBOX || 'Drafts';
const POLL_SECS = Math.max(10, parseInt(cfg.EMAIL_POLL_SECS || '60', 10) || 60); // IDLE fallback floor
// Allowlist of From addresses — ONLY mail from one of these is ever relayed. Parsed once, lowercased.
const ALLOWED = new Set(String(cfg.EMAIL_ALLOWED_SENDERS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
// Inbound EMAIL-PUSH event triggers: rules that fire an ACTION when an allowlisted email matches — distinct from
// the draft reply. EMAIL_TRIGGERS is a JSON array, e.g. [{"from":"boss@","action":"notify"},{"subject":"invoice","action":"ask"}].
// 'notify' pushes the owner an alert (subject + sender); 'ask' also pushes the brain's short take. Fail-soft to none.
let TRIGGERS = [];
try { const t = JSON.parse(cfg.EMAIL_TRIGGERS || '[]'); if (Array.isArray(t)) TRIGGERS = t; } catch {}
const bucket = new core.TokenBucket(8, 20);            // 8 burst, ~20/min sustained — bounds a flood/injection loop
const processed = new Set();                            // uids fetched this session — so dropped/hostile mail is parsed once, not every poll
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull the bare addr-spec (foo@bar) out of a From header value like '"Name" <foo@bar>' or 'foo@bar'.
function addrOf(from) {
  const s = String(from || '');
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

// Match a mail against the trigger rules. Returns the first matching {action} or null. A rule must specify at
// least one of from/subject (so an empty rule never matches everything); every specified criterion (substring,
// case-insensitive) must match. Pure + fail-closed — unit-tested without a live server.
function matchTrigger(mail, rules) {
  if (!Array.isArray(rules)) return null;
  const from = addrOf(mail && mail.from);
  const subject = String((mail && mail.subject) || '').toLowerCase();
  for (const r of rules) {
    if (!r || typeof r !== 'object') continue;
    const f = typeof r.from === 'string' ? r.from.toLowerCase().trim() : '';
    const s = typeof r.subject === 'string' ? r.subject.toLowerCase().trim() : '';
    if (!f && !s) continue;                                  // a rule with no criteria never matches (no fire-on-everything)
    if ((!f || from.includes(f)) && (!s || subject.includes(s))) return { action: r.action === 'ask' ? 'ask' : 'notify' };
  }
  return null;
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

// --- MIME decoding (pure JS, no deps) ----------------------------------------------------------------------
// Inbound mail is rarely plain text on the wire: it is quoted-printable / base64 / multipart. We decode it to
// clean text so the brain reads what a human reads, not raw transfer framing. ALL of this is best-effort and
// MUST NEVER throw — a garbled MIME structure falls back to the raw text. None of this touches the allowlist:
// the From decision still rides ONLY on the isolated header block (see parseFetch), never on decoded body bytes.
const BODY_CAP = 8000;

// Read one header value out of a header block (folded continuation lines unwrapped). '' if absent.
function headerVal(headerBlock, name) {
  const m = String(headerBlock || '').match(new RegExp('^' + name + ':\\s*(.+(?:\\r?\\n[ \\t]+.+)*)', 'im'));
  return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : '';
}

// Pull a parameter (e.g. boundary, charset) out of a structured header value like 'text/plain; charset="utf-8"'.
function paramOf(headerValue, name) {
  const m = String(headerValue || '').match(new RegExp(name + '\\s*=\\s*"([^"]*)"|' + name + '\\s*=\\s*([^;\\s]+)', 'i'));
  return m ? (m[1] !== undefined ? m[1] : m[2]) : '';
}

// Decode quoted-printable: =XX hex octets and soft line breaks (a trailing '=' before CRLF joins the lines).
// Bytes are reassembled then UTF-8 decoded so multi-byte chars split across =XX=XX survive (=E2=80=99 -> ').
function decodeQP(s) {
  const src = String(s).replace(/=\r?\n/g, '');           // soft breaks: drop '=' + the newline
  const out = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '=' && /[0-9A-Fa-f]{2}/.test(src.substr(i + 1, 2))) { out.push(parseInt(src.substr(i + 1, 2), 16)); i += 2; }
    else out.push(src.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

// Decode a transfer-encoded part body to a Buffer per its CTE. Unknown/7bit/8bit/binary => raw bytes.
function decodeCTE(cte, raw) {
  const e = String(cte || '').trim().toLowerCase();
  try {
    if (e === 'base64') return Buffer.from(String(raw).replace(/\s+/g, ''), 'base64');
    if (e === 'quoted-printable') return decodeQP(raw);
  } catch {}
  return Buffer.from(String(raw), 'latin1');
}

// Latin-1-safe Buffer -> string honoring a charset where Node supports it trivially (utf-8 default).
function bufToText(buf, charset) {
  const cs = String(charset || 'utf-8').trim().toLowerCase();
  try {
    if (cs === 'us-ascii' || cs === 'ascii' || cs === 'iso-8859-1' || cs === 'latin1') return buf.toString('latin1');
    return buf.toString('utf8'); // utf-8 and unknown: best-effort utf8
  } catch { return buf.toString('latin1'); }
}

// Crude HTML -> text: drop script/style, tags to spaces, decode a handful of entities, collapse whitespace.
function htmlToText(s) {
  return String(s)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>(?=)/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

// Decode a single non-multipart entity (its own MIME headers + raw body) to clean, charset-aware text.
function decodePart(partHeaders, rawPartBody) {
  const ct = headerVal(partHeaders, 'Content-Type');
  const cte = headerVal(partHeaders, 'Content-Transfer-Encoding');
  const buf = decodeCTE(cte, rawPartBody);
  const text = bufToText(buf, paramOf(ct, 'charset'));
  return /text\/html/i.test(ct) ? htmlToText(text) : text;
}

// Split a multipart body on its boundary into parts, each as { headers, body } (the part's MIME headers split
// from its body at the first blank line). Boundary lines are '--boundary'; the closing one is '--boundary--'.
function splitMultipart(rawBody, boundary) {
  const parts = [];
  const delim = '--' + boundary;
  // RFC 2046: a boundary is delimited by a line — it must be followed by CRLF (a part) or '--' (the close).
  // The trailing lookahead stops a boundary that is a PREFIX of real body text ('--Xtra') from mis-splitting it.
  const segs = String(rawBody).split(new RegExp('\\r?\\n?' + delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\r?\\n|--|$)'));
  for (const seg of segs) {
    if (!seg || /^--/.test(seg.trim())) continue;          // preamble/empty or the closing '--' marker
    const body = seg.replace(/^\r?\n/, '');
    const bi = body.search(/\r?\n\r?\n/);
    if (bi < 0) { parts.push({ headers: '', body }); continue; }
    parts.push({ headers: body.slice(0, bi), body: body.slice(bi).replace(/^\r?\n\r?\n/, '') });
  }
  return parts;
}

// Decode a message body to clean text using its top-level headers. Picks the FIRST text/plain part of a
// multipart (else the first text/html, stripped). Best-effort and NEVER throws; falls back to the raw body.
function decodeBody(headers, rawBody) {
  const raw = String(rawBody == null ? '' : rawBody);
  try {
    const ct = headerVal(headers, 'Content-Type');
    if (/^multipart\//i.test(ct)) {
      const boundary = paramOf(ct, 'boundary');
      if (boundary) {
        const parts = splitMultipart(raw, boundary);
        let html = '';
        for (const p of parts) {
          const pct = headerVal(p.headers, 'Content-Type') || 'text/plain';
          // Nested multipart (e.g. multipart/alternative inside multipart/mixed): recurse into it.
          if (/^multipart\//i.test(pct)) { const inner = decodeBody(p.headers, p.body); if (inner) return inner.slice(0, BODY_CAP); continue; }
          if (/text\/plain/i.test(pct)) return decodePart(p.headers, p.body).slice(0, BODY_CAP);
          if (!html && /text\/html/i.test(pct)) html = decodePart(p.headers, p.body);
        }
        if (html) return html.slice(0, BODY_CAP);
      }
      return raw.slice(0, BODY_CAP); // garbled multipart: raw fallback
    }
    return decodePart(headers, raw).slice(0, BODY_CAP);
  } catch { return raw.slice(0, BODY_CAP); }
}

// Pure parse of stitched FETCH lines -> { from, subject, body, inReplyTo }. Extracted so the allowlist-critical
// header parsing is unit-testable without a live server.
// SECURITY: the allowlist decision rides on From, so headers are matched ONLY against the header block (up to the
// first blank line) — NEVER the attacker-controlled body. Otherwise a body line `From: owner@allowed.com` would
// forge an allowed sender and bypass the owner allowlist. decodeBody touches ONLY the body, never the From read.
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
  // Strip the IMAP FETCH framing that wraps the body part(s) before MIME-decoding the real payload. Anchor the
  // untagged-response strip to the actual '* <n> FETCH …' protocol line — NOT any body line containing the word
  // 'FETCH' (the old /\bFETCH\b/im deleted legitimate body lines that merely mention it).
  body = body.replace(/^.*BODY\[TEXT\][^\r\n]*\r?\n/i, '').replace(/^\)\s*$/m, '').replace(/^\* \d+ FETCH\b.*$/im, '').replace(/\)\s*$/, '').trim();
  // Decode quoted-printable / base64 / multipart using the isolated HEADER block (NOT the body) for Content-Type/CTE.
  body = decodeBody(head, body);
  return { from, subject, body: body.slice(0, BODY_CAP), inReplyTo };
}

// FETCH one uid's From/Subject headers + a text body part. Returns { from, subject, body } as plain strings.
async function fetchMail(imap, uid) {
  // BODY.PEEK[...] does NOT set \Seen — we decide seen-state explicitly, and never mark dropped mail.
  // Pull the MIME framing headers (Content-Type/Content-Transfer-Encoding) alongside the allowlist headers so
  // decodeBody can decode quoted-printable / base64 / multipart from the SAME isolated header block.
  const lines = await imap.cmd('UID FETCH ' + uid
    + ' (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT IN-REPLY-TO MESSAGE-ID CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT])');
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
async function drain(imap, gov) {
  const uids = parseSearch(await imap.cmd('UID SEARCH UNSEEN'));
  const seen = (uid) => { processed.add(uid); if (processed.size > 5000) processed.clear(); }; // bound; reconnect re-derives
  for (const uid of uids) {
    if (processed.has(uid)) continue;       // a terminal decision was already made for this uid this session
    let mail;
    try { mail = await fetchMail(imap, uid); } catch (e) { core.audit({ ev: 'email_fetch_error', uid, err: String((e && e.message) || e) }); seen(uid); continue; }
    const sender = addrOf(mail.from);
    // ALLOWLIST, BEFORE the brain (EMAIL_ALLOWED_SENDERS — already multi-sender). Not allowed => drop, audit,
    // mark processed (fetch hostile mail ONCE, never again).
    if (!ALLOWED.has(sender)) { core.audit({ ev: 'email_drop', from: sender }); seen(uid); continue; }
    // TEAM MODE: assign a role via team.json (channel "email", id = the From address). FAIL-CLOSED like every
    // other channel: an allowlisted-but-unrostered sender defaults to the MOST-restricted 'guest' (NEVER 'member'),
    // so a spoofed From on a known allowlisted address can't reach a web-egress/vault-search brain turn. The owner
    // grants member/owner power deliberately by listing their address in team.json (or via EMAIL_OWNER_ADDRESS).
    const principal = core.resolvePrincipal('email', sender) || { id: sender, name: sender, role: 'guest' };
    // Rate-limited: do NOT mark processed — it's allowlisted mail; leave it to retry once the bucket refills.
    if (!bucket.take()) { core.audit({ ev: 'email_ratelimited', from: sender }); continue; }
    const t0 = Date.now();
    try {
      const reply = core.stripSpoken(await core.askDaemon('Subject: ' + mail.subject + '\n\n' + mail.body, 'email', principal));
      await saveDraft(imap, sender, mail.subject, reply, mail.inReplyTo);
      await markSeen(imap, uid); seen(uid); // only after a draft is safely stored
      // EVENT TRIGGER: if this mail matches a rule, fire a one-way PUSH to the owner (the email-push primitive) —
      // 'notify' pushes sender+subject; 'ask' also pushes the brain's short take. The draft (above) is unchanged.
      const trig = matchTrigger(mail, TRIGGERS);
      if (trig) {
        const alert = '[email · ' + sender + '] ' + mail.subject + (trig.action === 'ask' ? ' — ' + reply.replace(/\s+/g, ' ').slice(0, 200) : '');
        await core.notifyDaemon(alert);
        core.audit({ ev: 'email_trigger', from: sender, action: trig.action });
      }
      core.audit({ ev: 'email_turn', from: sender, principal: principal.name, role: principal.role, inLen: mail.body.length, outLen: reply.length, ms: Date.now() - t0 });
      gov && gov.markActivity(); // owner mail processed => snap the non-IDLE fallback cadence back to hot
    } catch (e) { core.audit({ ev: 'email_turn_error', from: sender, err: String((e && e.message) || e) }); } // a failed turn stays UNSEEN+unprocessed → retried
  }
}

// IDLE loop: arm IDLE, on an untagged EXISTS/RECENT send DONE and re-drain; fall back to POLL_SECS re-drain so
// a server without IDLE still works. Resolves (returns) on any socket error so the caller can reconnect.
async function serve({ imap, sock, hasIdle }, gov) {
  await drain(imap, gov); // catch anything that arrived before we armed IDLE
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
      // NON-IDLE fallback ONLY (the IMAP IDLE push branch above is untouched). At default knobs the idle probe
      // equals email's native 60s floor, so ON==OFF here until URFAEL_IDLE_PROBE_SECS is raised — honest by design.
      await sleep(gov ? gov.nextDelay() : POLL_SECS * 1000);
    }
    if (sock.destroyed) return;
    try { await drain(imap, gov); } catch (e) { core.audit({ ev: 'email_drain_error', err: String((e && e.message) || e) }); if (sock.destroyed) return; }
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
  // IDLE-SUSPEND (opt-in, default OFF; SECONDARY to imessage — a no-op at default knobs since email's fallback is
  // already 60s). Construct the governor ONCE here, OUTSIDE the reconnect loop, so it survives serve() reconnects
  // rather than resetting to hot on every reconnect. Null when the gate is off => byte-identical fallback sleep.
  const idleCfg = core.idleSuspendGate();
  const gov = idleCfg ? new IdleGovernor({ activeMs: POLL_SECS * 1000, ...idleCfg }) : null;
  let backoff = 1000;
  for (;;) {
    let conn;
    try { conn = await connect(); }
    catch (e) { core.audit({ ev: 'email_connect_error', err: String((e && e.message) || e), retryMs: backoff }); await sleep(backoff); backoff = Math.min(backoff * 2, 60000); continue; }
    core.audit({ ev: 'email_open', idle: conn.hasIdle });
    backoff = 1000; // reset on a successful connect
    try { await serve(conn, gov); } catch (e) { core.audit({ ev: 'email_serve_error', err: String((e && e.message) || e) }); }
    try { conn.sock.destroy(); } catch {}
    core.audit({ ev: 'email_close', retryMs: backoff });
    await sleep(backoff); backoff = Math.min(backoff * 2, 60000);
  }
}

module.exports = { Imap, parseFetch, addrOf, parseSearch, decodeBody, matchTrigger }; // pure pieces, for tests
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
