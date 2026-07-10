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
const crypto = require('crypto');

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
// Cap each line before pattern-scanning: several danger patterns are quadratic on a single very long line
// (`…[^\n]*…[^\s]+`), so a hostile skill could wedge the scanner before the user ever sees the verdict. A real
// dropper/exfil command fits in well under 2KB; a 100k-char line is an attack on the scanner itself, not content.
function boundLines(t, maxLine) {
  if (t.length > (1 << 20)) t = t.slice(0, 1 << 20);                  // a skill is text, not a megabyte payload
  if (t.length <= maxLine) return t;
  return t.split('\n').map((l) => (l.length > maxLine ? l.slice(0, maxLine) : l)).join('\n');
}
// Decode the obfuscation runs in a string (\xNN escapes, String.fromCharCode/chr sequences, and base64 blobs that
// sit next to a base64 decoder) so scan() can be re-run on the PLAINTEXT a single encoding layer was hiding. This
// is the differentiator no competitor closes: they flag the PRESENCE of encoding; we read what's inside. Hard-
// bounded (≤6 fragments, ≤4KB each, ≤16KB total) so it can never be a decode-bomb, and base64 is only decoded when
// a decoder is actually present so we don't unpack benign embedded data.
function decodePayloads(s) {
  const out = []; let budget = 16384;
  const push = (d) => { if (d && d.length && out.length < 6 && budget > 0) { const t = d.slice(0, 4096); out.push(t); budget -= t.length; } };
  for (const mm of s.match(/(?:\\x[0-9a-fA-F]{2}){4,}/g) || []) { try { push(mm.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))); } catch {} }
  for (const mm of s.match(/(?:(?:String\.fromCharCode|chr)\s*\(?\s*\d{1,3}\s*[,)]\s*){4,}/g) || []) { try { push((mm.match(/\d{1,3}/g) || []).map((n) => String.fromCharCode(+n)).join('')); } catch {} }
  if (/\batob\s*\(|Buffer\.from\s*\([^)\n]{0,200}base64|\bbase64\b[^\n|]{0,40}(?:-d|--decode|-D)/i.test(s)) {
    for (const mm of s.match(/[A-Za-z0-9+/]{24,}={0,2}/g) || []) { try { const d = Buffer.from(mm, 'base64').toString('utf8'); if (/[\x20-\x7e]{4,}/.test(d) && (d.match(/�/g) || []).length < d.length / 4) push(d); } catch {} }
  }
  return out;
}

function scan(text, depth = 0, opts = {}) {
  const flags = [];
  const caps = { network: false, fsWrite: false, shellExec: false, secretRead: false, persistence: false, pkgInstall: false, clipboard: false };
  const add = (level, why, sample, cap) => { flags.push({ level, why, sample: (sample || '').replace(/\s+/g, ' ').trim().slice(0, 120) }); if (cap) caps[cap] = true; };
  const s = boundLines(String(text || ''), 2000);                    // linear-bounded: every line ≤ 2KB before scanning

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

  // ===== EXTENDED COVERAGE — closes the gaps competitor scanners share. Every heuristic is per-line bounded. =====
  // reverse shells (no prior rule caught /dev/tcp or nc -e)
  if ((m = s.match(/\/dev\/(?:tcp|udp)\/[\w.$-]+\/\d{1,5}|\b(?:bash|sh|zsh)\b[^\n]{0,40}-i\b[^\n]{0,40}(?:>&|0>&1|<&)/i))) { add('danger', 'reverse shell (/dev/tcp socket or interactive-shell fd redirection)', m[0], 'shellExec'); caps.network = true; }
  if ((m = s.match(/\bnc(?:at)?\b[^\n]{0,40}\s-e\b|\bmkfifo\b[^\n]{0,60}\|\s*(?:ba|z)?sh\b|\bpty\.spawn\s*\(|import\s+socket\s*,\s*subprocess|\bsocat\b[^\n]{0,60}exec:[^\n]{0,20}(?:bash|sh)/i))) { add('danger', 'reverse shell (nc -e / mkfifo / pty.spawn / socat exec)', m[0], 'shellExec'); caps.network = true; }
  if ((m = s.match(/!`[^`]*\b(?:socat|nc|ncat|bash|sh|zsh|python3?|perl|ruby|node|osascript|powershell|curl|wget)\b[^`]*`/i))) add('danger', 'Claude-Code dynamic exec (!`...`) wrapping a shell binary', m[0], 'shellExec');
  if ((m = s.match(/\bchmod\b[^\n]{0,40}\+x\b[^\n]{0,40}(?:&&|;|\|\|)[^\n]{0,40}(?:\.\/|\bbash\b|\bsh\b|\bpython3?\b|\bnode\b)|\bchmod\b[^\n]{0,20}\+x\b[^\n]{0,40}(?:\/tmp\/|\/var\/tmp\/|~\/)/i))) add('danger', 'two-step dropper (chmod +x then run, or +x on a temp path)', m[0], 'shellExec');
  if ((m = s.match(/\b(?:python3?|node|perl|ruby|php|bash|sh|zsh)\b[^\n|]{0,40}(?:<<-?\s*['"]?[A-Z_]{2,}\b|<\s*\/dev\/stdin\b)/i))) add('warn', 'interpreter fed by a heredoc / stdin', m[0], 'shellExec');

  // persistence / autostart — fires OUTSIDE the never-execute guarantee at next boot/session
  if ((m = s.match(/(?:>>?|\btee\b|\bcat\b[^\n]{0,40}>>?)[^\n]{0,40}(?:~|\$HOME|\/home\/[\w.-]+|\/Users\/[\w.-]+)?\/?\.(?:bashrc|zshrc|bash_profile|zprofile|profile|zshenv|bash_login|config\/fish\/config\.fish)\b/i))) { add('danger', 'persistence: writes a shell rc/login file', m[0], 'persistence'); caps.fsWrite = true; }
  if ((m = s.match(/\bcrontab\b\s+-|\/etc\/cron|\bsystemctl\b\s+(?:--user\s+)?(?:enable|start)\b|\/etc\/init\.d\/|\bLaunch(?:Agents|Daemons)\b|\blaunchctl\b\s+(?:load|bootstrap|enable)|com\.apple\.loginitems|\.git\/hooks\/(?:pre-commit|post-checkout|post-merge|pre-push)/i))) add('danger', 'persistence: cron/launchd/systemd/login-item/git-hook autostart', m[0], 'persistence');
  if ((m = s.match(/(?:>>?|\b(?:tee|cp|mv|echo|printf|cat|append|write)\b)[^\n]{0,80}(?:CLAUDE\.md|MEMORY\.md|SOUL\.md|AGENTS?\.md|\.cursorrules|\.claude\/(?:settings(?:\.local)?\.json|hooks|agents|commands)|\.github\/copilot-instructions)/i))) { add('danger', 'persistence: writes an agent identity/config file (re-injects instructions every session)', m[0], 'persistence'); caps.fsWrite = true; }

  // non-HTTP exfil + credential/config theft (these also feed the secret-read AND sends-out INTENT rule)
  if ((m = s.match(/\b(?:dig|nslookup|host|drill|kdig)\b[^\n]{0,80}(?:\$\(|`|\$\{?[A-Za-z_])[^\n]{0,80}\.[a-z0-9-]+\.[a-z]{2,}/i))) { add('danger', 'DNS-tunnel exfiltration (resolver query with a shell-substituted hostname)', m[0], 'network'); sendsOut = true; }
  if ((m = s.match(/\b(?:append|add|attach|concat\w*|include)\b[^\n]{0,40}\b(?:process\.env|\$\{?[A-Z_]*(?:KEY|TOKEN|SECRET)|env(?:ironment)?\s*var\w*|api[ _-]?keys?|credentials?)\b[^\n]{0,40}\b(?:url|query|endpoint|request|link|param\w*)\b/i))) { add('danger', 'instruction to attach a secret/env var to an outbound URL (prose exfil)', m[0], 'secretRead'); sensitiveRead = true; sendsOut = true; }
  if ((m = s.match(/JSON\.stringify\s*\(\s*process\.env|Object\.(?:keys|entries|assign)\s*\(\s*process\.env|\bos\.environ(?:\.copy\(\))?\b|\b(?:printenv|env|set)\b[^\n|]{0,40}\|[^\n]{0,40}?(?:curl|wget|nc|base64)/i))) { add('warn', 'serializes the whole environment (credential-harvest source)', m[0], 'secretRead'); sensitiveRead = true; }
  if ((m = s.match(/\b(?:trufflehog|gitleaks|git-secrets)\b|\b(?:env|printenv|set)\b\s*\|\s*(?:grep|egrep|rg|awk)[^\n]{0,40}\b(?:KEY|TOKEN|SECRET|PASS|CRED|AWS|GITHUB|NPM)\b/i))) { add('warn', 'bulk credential-sweep tooling', m[0], 'secretRead'); sensitiveRead = true; }
  if ((m = s.match(/\b(?:ANTHROPIC_BASE_URL|OPENAI_BASE_URL|OPENAI_API_BASE|ANTHROPIC_AUTH_TOKEN|[A-Z_]*_BASE_URL)\b\s*[=:]\s*["']?(https?:\/\/[^\s"']+)/i)) && !/^https?:\/\/(?:api\.anthropic\.com|api\.openai\.com)\b/i.test(m[1])) add('danger', 'overrides the LLM provider base URL / auth token (routes prompts + traffic through a proxy)', m[0], 'network');
  if ((m = s.match(/\bgit\s+config\b[^\n]{0,80}\b(?:http\.proxy|https\.proxy|credential\.helper|url\.[^\n]{0,40}\.insteadof|core\.hookspath|core\.sshcommand)\b|\b(?:LD_PRELOAD|DYLD_INSERT_LIBRARIES|NODE_OPTIONS|GIT_SSH_COMMAND|http_proxy|https_proxy|ALL_PROXY)\s*=\s*\S/i))) add('danger', 'hijacks git/process traffic (proxy / credential-helper / LD_PRELOAD / NODE_OPTIONS)', m[0]);
  if ((m = s.match(/\bosascript\b[^\n]{0,80}display dialog[^\n]{0,80}(?:hidden answer|password)|\bsecurity\b[^\n]{0,40}\b(?:find-generic-password|dump-keychain|unlock-keychain)\b|\bchainbreaker\b/i))) { add('danger', 'macOS password phishing / keychain extraction', m[0], 'secretRead'); sensitiveRead = true; }

  // obfuscation / evasion (paired with decode-and-rescan below)
  if ((m = s.match(/\b(?:eval|exec(?:Sync)?|spawn(?:Sync)?|Function)\s*\(\s*(?:[\w.$]{0,40}\(\s*)?(?:atob|unescape|decodeURIComponent)\s*\(|Buffer\.from\s*\([^)\n]{0,200}?,\s*['"]base64['"]\s*\)[^\n]{0,80}?\.toString\s*\(/i))) add('danger', 'decode-then-execute (base64/escape decoder feeding eval/Function/exec)', m[0], 'shellExec');
  if ((m = s.match(/(?:\\x[0-9a-fA-F]{2}){4,}|(?:\\[0-3][0-7]{2}){4,}|(?:\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})){4,}|(?:(?:String\.fromCharCode|chr)\s*\(?\s*\d{2,3}\s*[,)]\s*){4,}/))) add('danger', '4+ consecutive byte-escapes / char-code assembly (obfuscated payload)', m[0]);
  if ((m = s.match(/(?:[a-z]['"`]\s*\+\s*['"`][a-z]){2,}/i))) add('warn', 'string-split concatenation (obfuscation)', m[0]);
  if ((m = s.match(/\b(?:import|require)\s*\(\s*[`'"]https?:\/\/[^`'")\n]{1,300}/i))) add('danger', 'imports/requires a remote URL module (pulls unseen attacker code at run time)', m[0], 'network');

  // cross-platform LOLBins, miners, anti-forensics
  if ((m = s.match(/\bpowershell(?:\.exe)?\b[^\n]{0,80}(?:-e(?:nc(?:odedcommand)?)?\s+[A-Za-z0-9+\/]{40,}={0,2}|-ep?\s*bypass|-executionpolicy\s+bypass|(?:IEX|Invoke-Expression)\b[^\n]{0,80}(?:DownloadString|Invoke-(?:WebRequest|RestMethod)))|\bcertutil\b[^\n]{0,40}-decode/i))) add('danger', 'PowerShell encoded / IEX-downloader / certutil stager', m[0], 'shellExec');
  if ((m = s.match(/\b(?:xmrig|minerd|cpuminer|ccminer|ethminer|nbminer|lolminer|phoenixminer|coinhive|cryptonight|randomx)\b|\bstratum(?:\+(?:tcp|ssl))?:\/\/|--donate-level\b/i))) add('danger', 'cryptocurrency miner (binary / stratum pool / donate-level)', m[0]);
  if ((m = s.match(/\bhistory\s+-c\b|\b(?:rm|truncate)[^\n]{0,40}\.(?:bash|zsh)_history\b|\bunset\s+HISTFILE\b|export\s+HISTFILE=\/dev\/null|\b(?:pkill|killall|kill\s+-9)\b[^\n]{0,40}(?:Little\s*Snitch|LuLu|santad?|crowdstrike|falcon|wdav|defender|osquery|auditd)|\b(?:spctl\s+--master-disable|csrutil\s+disable|ufw\s+disable|setenforce\s+0)\b/i))) add('danger', 'anti-forensics / disables a security agent, Gatekeeper, SIP, or firewall', m[0]);

  // resource/clipboard + conditional evasion (WARN, escalates in combination below)
  if ((m = s.match(/\b(?:pbpaste|pbcopy|xclip|xsel|wl-(?:paste|copy)|clip\.exe|Get-Clipboard|Set-Clipboard|clipboardy|navigator\.clipboard\.(?:readText|writeText))\b/i))) add('warn', 'clipboard access (crypto-address swap?)', m[0], 'clipboard');
  if ((m = s.match(/\b(?:date\s+\+|new Date\(\)|Date\.now\(\)|time\.time\(\)|datetime\.(?:now|utcnow)|\$\(date\b)[^\n]{0,60}(?:[<>]=?|-(?:gt|lt|ge|le)\b|getTime\(\)|>\s*\d{8}|20\d{2}[-\/]?[01]\d)/i))) add('warn', 'time-gated logic (possible time bomb)', m[0]);
  if ((m = s.match(/\bioreg\b[^\n]{0,40}(?:VirtualBox|VMware|QEMU)|hv_vmm_present|sysctl[^\n]{0,20}kern\.hv|\/\.dockerenv|systemd-detect-virt|VBoxGuest/i))) add('warn', 'VM/sandbox-detection probe (payload may hide from analysis)', m[0]);

  // manifest / frontmatter-scoped (structural location reduces false positives vs. prose that merely mentions these)
  const fmEnd = s.startsWith('---') ? s.indexOf('\n---', 3) : -1;
  if (fmEnd > 0 && (m = s.slice(0, fmEnd).match(/^\s*(?:allowed[-_]?tools|permission[-_]?mode|permissions?)\s*:\s*.*(?:Bash\s*\(\s*\*|Write\s*\(\s*\*|Edit\s*\(\s*\*|\bbypass(?:Permissions)?\b|acceptEdits)/im))) add('danger', 'frontmatter pre-authorizes broad tool access (no prompt)', m[0]);
  if (/"scripts"\s*:\s*\{/.test(s) && (m = s.match(/"(?:pre|post)?(?:install|prepare|prepublish|publish)"\s*:\s*"[^"\n]{0,300}?(?:curl|wget|fetch|node\s+-e|bash|sh\b|python|eval|base64|\.\/)/i))) add('danger', 'package manifest install-script shells out (postinstall attack)', m[0], 'pkgInstall');
  if ((m = s.match(/\b(?:npm|yarn|pnpm|pip3?|uv|cargo|gem)\b[^\n]{0,80}\s--(?:registry|index-url|extra-index-url|default-index)[=\s]+https?:\/\/(?!(?:registry\.npmjs\.org|pypi\.org|files\.pythonhosted\.org|crates\.io)\b)[^\s]+/i))) add('danger', 'installs from a non-canonical package registry (dependency-confusion / backdoor)', m[0], 'pkgInstall');

  // broadened hardcoded-secret + opaque-payload formats
  if ((m = s.match(/-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/))) add('danger', 'hardcoded private key (PEM block)', m[0]);
  else if ((m = s.match(/\bAIza[0-9A-Za-z_\-]{35}\b|\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,64}\b|\bglpat-[0-9A-Za-z_\-]{20}\b|\bnpm_[0-9A-Za-z]{36}\b|\bsk-ant-api03-[0-9A-Za-z_\-]{80,120}\b|https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]{8,12}\/[A-Z0-9]{8,12}\/[A-Za-z0-9]{20,30}/))) add('warn', 'looks like a hardcoded provider key/token/webhook', m[0]);
  if ((m = s.match(/\bunzip\b[^\n]{0,40}-P\s*\S|\b7z[ar]?\b\s+x?[^\n]{0,40}-p\S|\bopenssl\s+enc\s+-d\b|\bgpg\b[^\n]{0,40}(?:--passphrase|-d)\b/i))) add('warn', 'password-protected / encrypted archive extraction (contents uninspectable)', m[0]);

  // INTENT (generalized): a secret SOURCE + an outbound SINK anywhere in the body is an exfil procedure
  if (sensitiveRead && sendsOut && !flags.some((f) => /credential-exfiltration procedure/.test(f.why))) add('danger', 'reads a secret AND sends data out — a credential-exfiltration procedure', '');

  // ESCALATIONS: weak signals become DANGER in combination
  const has = (re) => flags.some((f) => re.test(f.why));
  if (has(/clipboard/) && (sendsOut || /\b0x[a-fA-F0-9]{40}\b|\bbc1[a-z0-9]{20,60}\b/.test(s))) add('danger', 'clipboard access combined with network egress or a crypto address (wallet-swap)', '');
  if (has(/time bomb|sandbox-detection/) && has(/dropper|reverse shell|exfiltrat|decode-then-execute|miner/)) add('danger', 'a payload is gated behind time/anti-analysis logic (conditional malware)', '');

  // DECODE-AND-RESCAN — read what one encoding layer was hiding, then re-run the FULL scanner on it (the move no
  // competitor makes; they flag the presence of encoding, we read inside it). Depth- and byte-bounded → no decode-bomb.
  if (depth < 2) {
    for (const dec of decodePayloads(s)) {
      for (const f of scan(dec, depth + 1, opts).flags) if (f.level === 'danger') add('danger', 'inside an encoded/obfuscated payload: ' + f.why, f.sample);
    }
  }

  // capability summary + severity score + structured verdict (pure folds over the flags)
  if (sendsOut || has(/network call|exfil|reverse shell|remote URL|base URL|DNS-tunnel/i)) caps.network = true;
  if (sensitiveRead || has(/secret|credential|\.ssh|keychain|private key/i)) caps.secretRead = true;
  if (has(/dropper|interpreter|eval|reverse shell|shells out|decode-then-execute|powershell|miner/i)) caps.shellExec = true;
  if (has(/rm -rf|raw disk|writes a shell|writes an agent|world-writable/i)) caps.fsWrite = true;
  const dangers = flags.filter((f) => f.level === 'danger').length;
  const warns = flags.length - dangers;
  const score = dangers * 10 + warns * 3;
  const verdict = (dangers > 0 || score >= 9) ? 'block' : score >= 3 ? 'review' : 'clean';
  const capabilities = Object.keys(caps).filter((k) => caps[k]);
  return { flags, score, verdict, capabilities };
}

// Owner-facing capability footprint: map scan()'s already-computed capabilities to fixed, plain-English labels.
// Pure fold over a FROZEN key->label table in a deterministic order (so a test can freeze the preview); [] when the
// skill touches nothing. NEVER derive a label from a flag .why string — the labels are the contract, the flags rot.
// Owner copy, so no em/en dashes (the labels use a comma or a slash, never a dash).
const CAPABILITY_LABELS = Object.freeze({
  network: 'reaches the network',
  secretRead: 'reads credentials/secrets',
  shellExec: 'shells out / executes code',
  fsWrite: 'writes files',
  persistence: 'installs autostart/persistence',
  pkgInstall: 'installs packages',
  clipboard: 'reads/writes the clipboard',
});
function capabilityLines(result) {
  const caps = (result && result.capabilities) || [];
  return Object.keys(CAPABILITY_LABELS).filter((k) => caps.includes(k)).map((k) => CAPABILITY_LABELS[k]);
}

// Fetch a single .md over https (no redirects to other hosts blindly; capped). Resolves
// { contentType, body } or rejects. Refuses non-https and oversize bodies fail-closed.
// SSRF guard: refuse loopback / link-local / private (RFC1918, CGNAT, ULA) hosts so a redirect can't aim the
// fetch at 127.0.0.1, 169.254.169.254 (cloud metadata), or an internal box. Single source of truth in lib.js
// (shared with the webhook-relay reply sender), so the guard can't drift between the two outbound paths.
const { isPrivateHost } = require('./lib');
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

  // PROVENANCE/INTEGRITY (hub installs): if the registry pins a sha256, the fetched bytes MUST match it, or the
  // skill is refused before it's even shown — so a registry entry can't be swapped for a different payload at its URL.
  if (opts.sha256) {
    const got = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
    if (got.toLowerCase() !== String(opts.sha256).toLowerCase()) { console.error('✗ integrity check FAILED — sha256 mismatch (expected ' + String(opts.sha256).slice(0, 12) + '…, got ' + got.slice(0, 12) + '…). Refusing.'); return { ok: false, error: 'integrity', got, expected: opts.sha256 }; }
    process.stdout.write(gold('✓ integrity') + dim(' — sha256 matches the registry (' + got.slice(0, 12) + '…)') + '\n');
  }

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

  const result = scan(body);
  const { flags } = result;

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
  // Capability footprint + structured verdict — the SAME block `urfael skills scan` prints, so the install preview
  // and the standalone scan agree. Purely additive: it only surfaces what scan() already computed; the
  // confirm/--yes/overwrite/never-execute logic below is untouched.
  const caps = capabilityLines(result);
  process.stdout.write(gold('  capabilities ') + dim(caps.length ? caps.join(', ') : 'none - inert markdown, runs nothing on its own') + '\n');
  process.stdout.write(gold('  verdict      ') + (result.verdict === 'block' ? gold(result.verdict) : dim(result.verdict)) + '\n');

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

// ---- SKILL HUB --------------------------------------------------------------------------------------
// A registry of shareable skills where every install passes the SAME gate as a direct URL install — the static
// safety scanner, an integrity (sha256) check, a full-content preview, and the agent NEVER executes a skill.
// "the app store with a security guarantee." The registry is a plain JSON index in a curated git repo; set
// URFAEL_HUB_INDEX to point at yours (default below). A poisoned listing is still caught by the scanner; a
// swapped payload at a listed URL is caught by the sha256 pin.
const DEFAULT_INDEX = 'https://raw.githubusercontent.com/Grandillionaire/urfael-skills/main/index.json';
function hubIndexUrl() { return process.env.URFAEL_HUB_INDEX || DEFAULT_INDEX; }

// Parse + validate a registry index. Pure, fail-soft: [] on junk; drops any entry without a safe slug or an
// https url. Each kept entry: {slug, title, description, url, author, sha256, tags}.
function parseIndex(text) {
  let j; try { j = JSON.parse(text); } catch { return []; }
  const list = Array.isArray(j) ? j : (j && Array.isArray(j.skills) ? j.skills : []);
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const slug = slugify(e.slug || e.name || '');
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) continue;
    if (typeof e.url !== 'string' || !/^https:\/\//i.test(e.url)) continue; // https only
    out.push({ slug, title: String(e.title || e.name || slug).slice(0, 80), description: String(e.description || '').slice(0, 200), url: e.url, author: String(e.author || '').slice(0, 60), sha256: typeof e.sha256 === 'string' ? e.sha256 : '', tags: Array.isArray(e.tags) ? e.tags.map((t) => String(t).slice(0, 24)).slice(0, 8) : [] });
  }
  return out;
}
async function fetchIndex(url) { const f = await fetchMd(url || hubIndexUrl()); return parseIndex(f.body); } // SSRF-guarded via fetchMd
function searchEntries(entries, q) {
  const s = String(q || '').toLowerCase().trim();
  if (!s) return entries;
  return entries.filter((e) => (e.slug + ' ' + e.title + ' ' + e.description + ' ' + (e.tags || []).join(' ')).toLowerCase().includes(s));
}
function findEntry(entries, slug) { const k = slugify(slug); return (entries || []).find((e) => e.slug === k) || null; }
// Install a skill BY SLUG from the registry → the same scan + integrity + preview + never-execute install path.
async function hubInstall(slug, opts = {}) {
  let entries; try { entries = await fetchIndex(opts.index); } catch (e) { console.error('✗ ' + (e && e.message || e)); return { ok: false, error: 'index' }; }
  const e = findEntry(entries, slug);
  if (!e) { console.error('✗ no skill "' + slug + '" in the registry. Try: urfael hub search <term>'); return { ok: false, error: 'not found' }; }
  process.stdout.write(dim('registry entry: ' + e.slug + (e.author ? ' · by ' + e.author : '') + (e.sha256 ? ' · sha256-pinned' : ' · UNPINNED')) + '\n');
  return installFromUrl(e.url, { yes: opts.yes, sha256: e.sha256 });
}
// Produce the registry index entry for a LOCAL skill file (so an author can PR it to the registry).
function entryFor(file) {
  let body; try { body = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const m = meta(body, path.basename(String(file)).replace(/\.md$/i, ''));
  const slug = slugify(m.name) || slugify(path.basename(String(file)).replace(/\.md$/i, ''));
  if (!slug) return null;
  return { slug, title: m.name || slug, description: m.desc || '', url: 'https://YOUR-HOST/skills/' + slug + '.md', author: '', sha256: crypto.createHash('sha256').update(body, 'utf8').digest('hex'), tags: [] };
}

module.exports = { listLocal, exportSkill, scan, capabilityLines, installFromUrl, slugify, meta, SKILLS_DIR, hubIndexUrl, parseIndex, fetchIndex, fetchMd, searchEntries, findEntry, hubInstall, entryFor };
