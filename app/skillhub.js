'use strict';
// Skill hub — share and (paranoidly) install Urfael skill files for VAULT/_urfael/skills/.
// The OpenClaw ClawHub equivalent, but install-paranoid: their hub shipped ~20% malware, so we
// NEVER execute an installed skill (we only store the markdown), we REFUSE anything that isn't
// text/markdown, we static-scan every file for dangerous content, we print the full body + the
// flags, and we only write after the user confirms. Slugs are validated and we never write
// outside the skills dir. No third-party deps — built-in https/fs/path/os only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const VAULT = path.join(os.homedir(), process.env.URFAEL_VAULT_DIR || 'Urfael');
const SKILLS_DIR = path.join(VAULT, '_urfael', 'skills');
const MAX_BYTES = 256 * 1024; // a skill is terse markdown; cap hard so a hostile URL can't flood us

const gold = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

// name+desc for one skill markdown: prefer YAML-ish frontmatter (name:/description:), else derive
// from the first heading / first prose line. Pure string work — never executes anything.
function meta(text, fallbackName) {
  let name = '', desc = '';
  const fm = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    for (const ln of fm[1].split('\n')) {
      const m = ln.match(/^\s*([A-Za-z_]+)\s*:\s*(.+?)\s*$/);
      if (!m) continue;
      const k = m[1].toLowerCase(), v = m[2].replace(/^["']|["']$/g, '').trim();
      if (k === 'name' && !name) name = v;
      else if ((k === 'description' || k === 'desc') && !desc) desc = v;
    }
  }
  const lines = text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').split('\n');
  if (!name) { const h = lines.find((l) => /^#+\s+\S/.test(l)); if (h) name = h.replace(/^#+\s+/, '').trim(); }
  if (!desc) { const p = lines.find((l) => l.trim() && !/^#+\s/.test(l)); if (p) desc = p.trim(); }
  return { name: (name || fallbackName || '').slice(0, 80), desc: (desc || '').replace(/\s+/g, ' ').slice(0, 200) };
}

// kebab slug from a name/url: lowercase, [a-z0-9-] only, collapse/trim dashes. Returns '' if nothing
// usable survives (caller refuses to write). The ONLY source of the on-disk filename.
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

// Local skills: every *.md under SKILLS_DIR with its derived name+desc. [] if the dir is missing.
function listLocal() {
  let files = [];
  try { files = fs.readdirSync(SKILLS_DIR).filter((f) => f.toLowerCase().endsWith('.md')); } catch { return []; }
  const out = [];
  for (const f of files.sort()) {
    let text = ''; try { text = fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8'); } catch { continue; }
    const m = meta(text, f.replace(/\.md$/i, ''));
    out.push({ slug: f.replace(/\.md$/i, ''), file: f, name: m.name, desc: m.desc });
  }
  return out;
}

// Print one skill file verbatim to stdout so it can be piped/shared. Returns true if found.
function exportSkill(name) {
  const slug = slugify(name);
  // accept the given name, its slug, or the raw filename — but only ever read inside SKILLS_DIR
  const candidates = [name, name + '.md', slug + '.md'];
  for (const c of candidates) {
    const base = path.basename(String(c)); // defang any path traversal in the requested name
    const p = path.join(SKILLS_DIR, base);
    if (path.dirname(p) === SKILLS_DIR && fs.existsSync(p) && fs.statSync(p).isFile()) {
      process.stdout.write(fs.readFileSync(p, 'utf8'));
      return true;
    }
  }
  return false;
}

// Static safety scan of a skill markdown. Pure pattern matching — NEVER executes the content.
// Returns { flags:[{level,why,sample}] }. Errs toward flagging; the human makes the final call.
function scan(text) {
  const flags = [];
  const add = (level, why, sample) => flags.push({ level, why, sample: (sample || '').replace(/\s+/g, ' ').trim().slice(0, 120) });
  const s = String(text || '');

  // 1) embedded shell that runs a remote download — the classic dropper, plus its common evasions
  let m;
  if ((m = s.match(/\b(?:curl|wget|fetch)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b/i))) add('danger', 'pipes a network download into a shell (curl|sh dropper)', m[0]);
  if ((m = s.match(/\b(?:bash|sh|zsh|source|\.)\b\s*<\(\s*(?:curl|wget|fetch)\b/i))) add('danger', 'process-substitution dropper (bash <(curl ...))', m[0]);
  if ((m = s.match(/\b(?:curl|wget|fetch)\b[^\n|]*\|\s*(?:xargs[^\n|]*\b(?:ba|z)?sh\b|(?:ba|z)?sh\b|nc\b|node\b|python3?\b|perl\b|ruby\b)/i))) add('danger', 'pipes a download into an interpreter/xargs/nc (dropper variant)', m[0]);
  if ((m = s.match(/\bbase64\b[^\n|]*(?:-d|--decode|-D)[^\n|]*\|\s*(?:sudo\s+)?\w*sh\b/i))) add('danger', 'decodes base64 and pipes it into a shell (obfuscated payload)', m[0]);
  if ((m = s.match(/\beval\b\s*[("'`$]/i))) add('danger', 'eval of dynamic content', m[0]);
  if ((m = s.match(/\b(?:python3?|node|perl|ruby|php)\b\s+-(?:e|c)\b/i))) add('warn', 'inline interpreter one-liner (-e/-c)', m[0]);

  // 2) destructive filesystem ops
  if ((m = s.match(/\brm\s+-[rf]{1,2}\b[^\n]*/i))) add('danger', 'recursive/forced delete (rm -rf)', m[0]);
  if ((m = s.match(/\b(?:mkfs|dd\s+if=|:\(\)\s*\{|chmod\s+-R\s+777)\b/i))) add('danger', 'destructive or fork-bomb / world-writable op', m[0]);
  if ((m = s.match(/>\s*\/dev\/sd[a-z]/i))) add('danger', 'writes to a raw disk device', m[0]);

  // 3) reading secrets / sensitive paths
  if ((m = s.match(/[~/.]*\/?\.ssh\/(?:id_[a-z0-9]+|authorized_keys|config)?/i))) add('danger', 'touches ~/.ssh (private keys)', m[0]);
  if ((m = s.match(/\/etc\/(?:passwd|shadow|sudoers|hosts)\b/i))) add('danger', 'reads system files under /etc', m[0]);
  // credential / secret stores — incl. URFAEL'S OWN secrets (a skill is run with full local power, so it could
  // read these and send them out). Matches ~/.claude (the Claude login), bridge.env/api-keys.env, the dashboard/
  // api tokens, ssh/aws/gcloud/npm/netrc/git creds, keychains.
  const SECRET_PATH = /\.aws\/credentials|\.config\/gcloud|\.npmrc|\.netrc|\.git-credentials|\.env\b|keychain|Keychains|\.claude\/(?:\.credentials|urfael)|\.credentials\.json|(?:dashboard|api)\.token|bridge\.env|api-keys\.env/i;
  let sensitiveRead = false;
  if ((m = s.match(SECRET_PATH))) { add('danger', 'targets a credentials/secret store', m[0]); sensitiveRead = true; }
  if ((m = s.match(/\b(?:AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{20,})\b/))) add('warn', 'looks like a hardcoded API key/token', m[0]);

  // 4) exfiltration — sending data out. ANY send/post/upload counts; a known callback service is DANGER.
  const EXFIL_HOST = /https?:\/\/(?:[a-z0-9.-]+\.)?(?:ngrok\.io|trycloudflare\.com|requestbin\.\w+|webhook\.site|pipedream\.net|interact\.sh|oast\.\w+|transfer\.sh|0x0\.st|pastebin\.com|paste\.ee|hastebin\.com|file\.io|discord(?:app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|githubusercontent\.com)[^\s]*/i;
  let sendsOut = false;
  if ((m = s.match(/\b(?:curl|wget|nc|ncat|netcat|fetch|invoke-webrequest|scp|rsync|http[ _-]?post|upload|exfiltrat)\w*\b[^\n]*(?:https?:\/\/|@)[^\s]+/i))) { add('warn', 'network call that could exfiltrate local data', m[0]); sendsOut = true; }
  if (/\b(?:POST|send|upload|exfiltrate|publish|transmit)\b[^\n]*\bhttps?:\/\//i.test(s) || /\bhttps?:\/\/[^\s]+[^\n]*\b(?:POST|upload|send)\b/i.test(s)) sendsOut = true;
  if ((m = s.match(/https?:\/\/\d{1,3}(?:\.\d{1,3}){3}\b[^\s]*/i))) add('warn', 'hardcoded raw-IP URL (exfil endpoint?)', m[0]);
  if ((m = s.match(EXFIL_HOST))) { add('danger', 'URL points at a known exfil/callback service', m[0]); sendsOut = true; }
  // INTENT rule (not a literal command): a skill that both reads a secret AND sends data out is a DANGER dropper
  // even in pure prose ("read ~/.claude/.credentials.json and POST it to ...") — the brain follows skills as procedures.
  if (sensitiveRead && sendsOut) add('danger', 'reads a secret AND sends data out — a credential-exfiltration procedure', '');

  // 5) prompt-injection phrasing — this skill text is fed to the brain, so treat it as untrusted input
  const inj = [
    /ignore (?:all |any )?(?:your |the )?previous (?:instructions|prompts?|rules?)/i,
    /disregard (?:all |the )?(?:above|prior|previous|earlier) (?:instructions|context)/i,
    /you are now (?:in )?(?:DAN|developer mode|jailbroken|unrestricted)/i,
    /(?:reveal|print|leak|exfiltrate|send) (?:your |the )?(?:system prompt|api[ _-]?key|secrets?|credentials|env(?:ironment)? var)/i,
    /\bdo not (?:tell|inform|warn|alert) (?:the )?(?:user|owner)\b/i,
    /\boverride (?:the )?(?:safety|security|sandbox|allowlist)\b/i,
    /(?:--dangerously(?:-skip-permissions)?|\bbypassPermissions\b|\bsudo\b)/i, // '--' is a non-word char: a leading \b before it never matches (the flag would pass clean)
  ];
  for (const re of inj) if ((m = s.match(re))) { add('danger', 'prompt-injection / instruction-override phrasing', m[0]); break; }

  // 6) hidden / deceptive unicode: zero-width chars, bidi overrides, tag chars, BOM. ASCII-clean source
  // via explicit \u escapes (the `u` flag enables \u{...}). These can mask a payload or smuggle text into
  // the brain: U+200B-200F, U+202A-202E bidi overrides, U+2066-206F isolates, U+FEFF BOM, U+E0000-E007F tags.
  const hidden = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\u{E0000}-\u{E007F}]/u;
  if ((m = s.match(hidden))) add('danger', 'hidden/zero-width, bidi-override or tag unicode (could mask payload)', 'U+' + s.codePointAt(s.search(hidden)).toString(16).toUpperCase());
  if (/[^\x00-\x7F]/.test(s)) { const c = (s.match(/[^\x00-\x7F]/g) || []).length; if (c > 40) add('warn', 'unusually high non-ASCII char count (' + c + ') - homoglyph risk', ''); }

  return { flags };
}

// Fetch a single .md over https (no redirects to other hosts blindly; capped). Resolves
// { contentType, body } or rejects. Refuses non-https and oversize bodies fail-closed.
// SSRF guard: refuse loopback / link-local / private (RFC1918, CGNAT, ULA) hosts so a redirect can't aim the
// fetch at 127.0.0.1, 169.254.169.254 (cloud metadata), or an internal box.
function isPrivateHost(h) {
  h = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) { const [a, b] = [+m[1], +m[2]];
    return a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127); }
  if (/^(::1|fe80:|fc|fd)/.test(h)) return true; // IPv6 loopback / link-local / ULA
  return false;
}
function fetchMd(url, depth = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('invalid url')); }
    if (u.protocol !== 'https:') return reject(new Error('refusing non-https url (got ' + u.protocol + ')'));
    if (isPrivateHost(u.hostname)) return reject(new Error('refusing private/loopback host (SSRF): ' + u.hostname));
    if (depth > 3) return reject(new Error('too many redirects'));
    const req = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', timeout: 30000, headers: { 'User-Agent': 'urfael-skillhub', Accept: 'text/markdown, text/plain' } }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) { // follow redirects, but re-validate each hop (https-only, depth-capped)
        res.resume();
        return resolve(fetchMd(new URL(res.headers.location, u).toString(), depth + 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error('http ' + code)); }
      const ct = String(res.headers['content-type'] || '').toLowerCase();
      // REFUSE anything that isn't text/markdown or text/plain — no html, no octet-stream, no scripts
      if (!/^text\/(?:markdown|x-markdown|plain)\b/.test(ct) && ct !== '') {
        res.resume(); return reject(new Error('refusing content-type "' + ct + '" (only text/markdown or text/plain)'));
      }
      let n = 0; const chunks = [];
      res.on('data', (d) => { n += d.length; if (n > MAX_BYTES) { req.destroy(); reject(new Error('file too large (> ' + (MAX_BYTES / 1024) + 'KB)')); return; } chunks.push(d); });
      res.on('end', () => resolve({ contentType: ct, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// Install from a URL: fetch -> refuse non-markdown -> scan -> PRINT body + flags -> confirm -> write.
// NEVER executes the skill; only stores the markdown into SKILLS_DIR/<safe-slug>.md. opts.yes skips
// the prompt (cli --yes); opts.confirm lets a caller inject a confirmation fn (defaults to a TTY prompt).
async function installFromUrl(url, opts = {}) {
  let fetched;
  try { fetched = await fetchMd(url); } catch (e) { console.error('✗ ' + (e && e.message || e)); return { ok: false, error: String(e && e.message || e) }; }
  const body = fetched.body;
  if (!body.trim()) { console.error('✗ empty file'); return { ok: false, error: 'empty' }; }

  // derive slug from a name in the file if present, else from the URL's basename
  let u; try { u = new URL(url); } catch {}
  const urlBase = u ? path.basename(u.pathname).replace(/\.md$/i, '') : '';
  const m = meta(body, urlBase);
  const slug = slugify(m.name) || slugify(urlBase);
  if (!slug) { console.error('✗ could not derive a safe slug from the skill name or url'); return { ok: false, error: 'no slug' }; }
  if (!/^[a-z0-9-]+$/.test(slug)) { console.error('✗ slug failed validation'); return { ok: false, error: 'bad slug' }; }

  const dest = path.join(SKILLS_DIR, slug + '.md');
  // belt-and-suspenders: the resolved path MUST live directly inside SKILLS_DIR — never escape it
  if (path.dirname(path.resolve(dest)) !== path.resolve(SKILLS_DIR)) { console.error('✗ refusing to write outside the skills dir'); return { ok: false, error: 'path escape' }; }
  const overwrite = fs.existsSync(dest); // a slug collision could overwrite an existing TRUSTED skill — flag it loudly, never under --yes

  const { flags } = scan(body);

  // ALWAYS show the full content the human is being asked to trust, then the scan verdict.
  // The body is UNTRUSTED: strip terminal control/ANSI escapes so it can't spoof the display (hide the verdict,
  // move the cursor, recolor text) — what you see is the literal bytes that would be stored.
  const safeBody = String(body).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-_]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  process.stdout.write(gold('── skill: ' + (m.name || slug)) + dim('  (' + slug + '.md)') + '\n');
  if (m.desc) process.stdout.write(dim('   ' + String(m.desc).replace(/\x1b/g, '')) + '\n');
  process.stdout.write(dim('─'.repeat(60)) + '\n');
  process.stdout.write(safeBody.endsWith('\n') ? safeBody : safeBody + '\n');
  process.stdout.write(dim('─'.repeat(60)) + '\n');
  reportFlags(flags);

  const danger = flags.some((f) => f.level === 'danger');
  if (opts.yes) {
    // --yes only auto-installs a CLEAN skill: ANY flag (danger OR warn) forces interactive review, so a
    // dropper that evades the DANGER tier but trips a WARN (e.g. an unusual interpreter pipe) can't slip through.
    if (flags.length) { console.error('✗ refusing --yes auto-install: this skill tripped ' + flags.length + ' safety flag(s). Review and install interactively.'); return { ok: false, error: 'flags block --yes', flags }; }
    if (overwrite) { console.error('✗ refusing --yes: a skill named ' + slug + '.md already exists. Overwriting an installed skill needs interactive confirmation.'); return { ok: false, error: 'would overwrite', flags }; }
  } else {
    const warn = (danger ? gold(' (DANGER flags present!)') : '') + (overwrite ? gold(' (OVERWRITES the existing ' + slug + '.md!)') : '');
    const ok = await (opts.confirm || promptYesNo)('Install this skill to ' + dest + '?' + warn);
    if (!ok) { console.log(dim('aborted — nothing written')); return { ok: false, error: 'declined', flags }; }
  }

  try { fs.mkdirSync(SKILLS_DIR, { recursive: true }); fs.writeFileSync(dest, body, { encoding: 'utf8', mode: 0o600 }); } // 0600: data, never executable
  catch (e) { console.error('✗ write failed: ' + (e && e.message || e)); return { ok: false, error: String(e && e.message || e), flags }; }
  console.log(gold('✓ installed ') + dest + dim('  (stored as markdown — never executed)'));
  return { ok: true, path: dest, slug, flags };
}

// Pretty-print scan flags (shared by install + the standalone `skills scan` command).
function reportFlags(flags) {
  if (!flags.length) { console.log(gold('✓ scan clean') + dim(' — no dangerous patterns found (still your call)')); return; }
  const dangers = flags.filter((f) => f.level === 'danger').length;
  console.log((dangers ? gold('⚠ ' + dangers + ' DANGER') + dim(' + ' + (flags.length - dangers) + ' warn') : gold('⚠ ' + flags.length + ' warning')) + dim(' flag(s):'));
  for (const f of flags) {
    const tag = f.level === 'danger' ? gold('[DANGER]') : dim('[warn]  ');
    console.log('  ' + tag + ' ' + f.why + (f.sample ? dim('  «' + f.sample + '»') : ''));
  }
}

// Minimal TTY yes/no. Defaults to NO on EOF/non-tty (fail-closed). Not used when --yes is passed.
function promptYesNo(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { console.log(dim('(no tty — pass --yes to install non-interactively)')); return resolve(false); }
    process.stdout.write(question + ' [y/N] ');
    process.stdin.setEncoding('utf8'); process.stdin.resume();
    const onData = (d) => { process.stdin.pause(); process.stdin.removeListener('data', onData); resolve(/^\s*y(es)?\s*$/i.test(String(d))); };
    process.stdin.on('data', onData);
  });
}

module.exports = { listLocal, exportSkill, scan, installFromUrl, slugify, meta, SKILLS_DIR };
