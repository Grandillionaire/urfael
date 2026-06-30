'use strict';
// Shared bridge plumbing: read bridge.env, relay to the daemon's /ask over the unix socket with a channel
// tag (which the daemon forces into the sandboxed 'untrusted' profile), rate-limit, audit, and one-way push.
// No third-party deps — built-in http/https only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const lib = require('../lib');

const JDIR = path.join(os.homedir(), '.claude', 'urfael');
const SOCK = path.join(JDIR, 'daemon.sock');
const ENVF = path.join(JDIR, 'bridge.env');
const TEAMF = path.join(JDIR, 'team.json');
const AUDIT = path.join(JDIR, 'bridge-audit.log');

// TEAM MODE — the roster: per-channel allowlist of principals (id/name/role). team.json is the source of truth
// when present; otherwise the legacy single-owner env id is the lone owner (so existing setups are unchanged).
const OWNER_ENV = { telegram: 'TELEGRAM_OWNER_CHAT_ID', discord: 'DISCORD_OWNER_USER_ID', slack: 'SLACK_OWNER_USER_ID', imessage: 'IMESSAGE_OWNER_HANDLE', matrix: 'MATRIX_OWNER_USER_ID', signal: 'SIGNAL_OWNER_UUID', whatsapp: 'WHATSAPP_OWNER_NUMBER', qq: 'QQ_OWNER_OPENID', simplex: 'SIMPLEX_OWNER_CONTACT_ID', phone: 'PHONE_OWNER_NUMBER', mattermost: 'MATTERMOST_OWNER_USER_ID', googlechat: 'GOOGLECHAT_OWNER_NAME', sms: 'SMS_OWNER_NUMBER', dingtalk: 'DINGTALK_OWNER_STAFF_ID', homeassistant: 'HOMEASSISTANT_OWNER', bluebubbles: 'BLUEBUBBLES_OWNER_HANDLE', feishu: 'FEISHU_OWNER_OPEN_ID', wecom: 'WECOM_OWNER_USER' };
function loadRoster() {
  const cfg = loadEnv();
  const envOwners = {};
  for (const ch in OWNER_ENV) if (cfg[OWNER_ENV[ch]]) envOwners[ch] = cfg[OWNER_ENV[ch]];
  if (cfg.SIGNAL_OWNER_NUMBER && !envOwners.signal) envOwners.signal = cfg.SIGNAL_OWNER_NUMBER;
  if (envOwners.whatsapp) envOwners.whatsapp = String(envOwners.whatsapp).replace(/[^\d]/g, ''); // match Meta's E.164 digits
  let teamJson = null;
  try { teamJson = JSON.parse(fs.readFileSync(TEAMF, 'utf8')); } catch {}
  return lib.buildRoster(teamJson, envOwners);
}
// Resolve a channel sender to an allowlisted principal, or null (=> DROP). Fail-closed (lib.resolvePrincipal).
function resolvePrincipal(channel, senderId, roster) { return lib.resolvePrincipal(roster || loadRoster(), channel, senderId); }

function loadEnv() {
  const cfg = {};
  try {
    for (const line of fs.readFileSync(ENVF, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#') || !s.includes('=')) continue;
      const i = s.indexOf('='); cfg[s.slice(0, i).trim()] = s.slice(i + 1).replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, ''); // strip inline comments
    }
  } catch {}
  return cfg;
}

function audit(o) { try { fs.appendFileSync(AUDIT, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n'); } catch {} }

// POST /ask over the unix socket with a channel tag (+ optional principal for TEAM MODE: the daemon maps the
// role to a sandbox profile and attributes the turn). collapse the NDJSON stream to the final 'done' text.
function askDaemon(text, channel, principal) {
  return new Promise((resolve) => {
    // principal.model is the owner-set per-principal MODEL CAP (a ceiling on auto-routing); sent ONLY when present,
    // so a roster with no cap produces a byte-identical payload. The daemon re-validates it (normPinModel) on receipt.
    const payload = JSON.stringify(principal ? { text, channel, role: principal.role, principal: principal.name, ...(principal.model ? { model: principal.model } : {}) } : { text, channel });
    const req = http.request({ socketPath: SOCK, method: 'POST', path: '/ask',
      headers: { 'Content-Type': 'application/json' }, timeout: 200000 }, (res) => {
      let buf = '', final = '';
      res.on('data', (d) => {
        buf += d.toString(); let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!ln) continue; try { const e = JSON.parse(ln); if (e.kind === 'done') final = e.text || ''; } catch {}
        }
      });
      res.on('end', () => resolve(final || '(no reply)'));
    });
    req.on('error', () => resolve('(brain unreachable — is the Urfael daemon running?)'));
    req.on('timeout', () => { req.destroy(); resolve('(timed out)'); });
    req.end(payload);
  });
}

// One-way push to the OWNER via the daemon (notification + spoken + the owner's push channels). Used by event
// triggers (e.g. an inbound email matching a rule) to fire an alert. Fail-soft: resolves false if the daemon is down.
function notifyDaemon(text) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ text: String(text || '').slice(0, 1000) });
    const req = http.request({ socketPath: SOCK, method: 'POST', path: '/notify', headers: { 'Content-Type': 'application/json' }, timeout: 15000 }, (res) => { res.resume(); res.on('end', () => resolve(true)); });
    req.on('error', () => resolve(false)); req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(payload);
  });
}

// SELF-ENROLL: a non-roster sender's message MIGHT be a pairing code. Forward it to the daemon's /pair/redeem;
// on success the sender is enrolled as a GUEST (the daemon hard-codes the role). Returns { ok } | { error }.
function tryPair(channel, senderId, text) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ channel, senderId: String(senderId), code: String(text || '').trim() });
    const r = http.request({ socketPath: SOCK, method: 'POST', path: '/pair/redeem', headers: { 'Content-Type': 'application/json' }, timeout: 15000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({ error: 'bad' }); } });
    });
    r.on('error', () => resolve({ error: 'unreachable' })); r.on('timeout', () => { r.destroy(); resolve({ error: 'timeout' }); });
    r.end(payload);
  });
}

function stripSpoken(t) { return (t || '').replace(/\[\/?SPOKEN\]/gi, '').trim(); }

// Token bucket: `capacity` burst, refilling `refillPerMin` per minute. take() => boolean.
class TokenBucket {
  constructor(capacity, refillPerMin) { this.capacity = capacity; this.tokens = capacity; this.refillPerMs = refillPerMin / 60000; this.last = Date.now(); }
  take() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs); this.last = now;
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
}

function httpsJson(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ timeout: 70000, ...opts }, (res) => { // timeout so a stuck long-poll can't hang the bridge forever
      let b = ''; res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }); } catch { resolve({ status: res.statusCode, json: null, raw: b }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function telegramSend(token, chatId, text) {
  return httpsJson({ hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST', headers: { 'Content-Type': 'application/json' } },
    { chat_id: chatId, text: (text || '(empty)').slice(0, 4000), disable_web_page_preview: true });
}

async function discordDM(token, userId, text) {
  const ch = await httpsJson({ hostname: 'discord.com', path: '/api/v10/users/@me/channels', method: 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' } }, { recipient_id: userId });
  const channelId = ch.json && ch.json.id;
  if (!channelId) return { status: 0 };
  return httpsJson({ hostname: 'discord.com', path: `/api/v10/channels/${channelId}/messages`, method: 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' } }, { content: (text || '(empty)').slice(0, 1900) });
}

// QQ Bot passive reply (outbound HTTPS REST, no WS send) — echoes the inbound msg_id within the reply window.
// target = { kind:'c2c'|'group'|'guild', openid?, channelId? } from qq-bridge.parseEvent.
function qqSend(target, accessToken, text, msgId, msgSeq) {
  const body = { content: (text || '(empty)').slice(0, 1900), msg_type: 0, msg_id: msgId, msg_seq: msgSeq };
  let p;
  if (target && target.kind === 'c2c') p = `/v2/users/${target.openid}/messages`;
  else if (target && target.kind === 'group') p = `/v2/groups/${target.openid}/messages`;
  else if (target && target.kind === 'guild') p = `/channels/${target.channelId}/messages`;
  else return Promise.resolve({ status: 0 });
  return httpsJson({ hostname: 'api.sgroup.qq.com', path: p, method: 'POST', headers: { Authorization: 'QQBot ' + accessToken, 'Content-Type': 'application/json' } }, body);
}

// Slack Web API call with a bearer token (app-level token for apps.connections.open, bot token for chat.postMessage).
function slackApi(token, method, body) {
  return httpsJson({ hostname: 'slack.com', path: '/api/' + method, method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' } }, body || {});
}

// Post a Slack message. `channel` may be a DM channel id or a user id (Slack opens the DM either way).
function slackPost(botToken, channel, text) {
  return slackApi(botToken, 'chat.postMessage', { channel, text: (text || '(empty)').slice(0, 3900) });
}

// Send an iMessage to the owner handle via AppleScript (macOS only). Best-effort; rejects if osascript fails.
function imessageSend(handle, text) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    const script = 'on run argv\n'
      + 'set h to item 1 of argv\n'
      + 'set m to item 2 of argv\n'
      + 'tell application "Messages"\n'
      + 'set svc to 1st account whose service type = iMessage\n'
      + 'set bud to participant h of svc\n'
      + 'send m to bud\n'
      + 'end tell\n'
      + 'end run';
    execFile('osascript', ['-e', script, handle, (text || '(empty)').slice(0, 3900)], { timeout: 30000 }, (err) => err ? reject(err) : resolve());
  });
}

// Download a small file over https to a temp path (voice memos). Capped size, fail-closed.
function httpsDownload(url, dest, maxBytes = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', timeout: 60000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error('download ' + res.statusCode)); return; }
      let n = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', (d) => { n += d.length; if (n > maxBytes) { req.destroy(); out.destroy(); reject(new Error('too large')); } });
      res.pipe(out);
      out.on('finish', () => resolve(dest));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

// Transcribe an audio file locally: ffmpeg → 16k mono wav → whisper-cli (brew whisper-cpp).
// Returns '' if the local toolchain isn't installed — callers degrade gracefully.
function transcribeLocal(audioPath) {
  const { execFileSync } = require('child_process');
  const wav = audioPath + '.wav';
  const tts = (() => { try { return fs.readFileSync(path.join(JDIR, 'tts.env'), 'utf8'); } catch { return ''; } })();
  const model = path.join(JDIR, 'models', 'ggml-' + ((tts.match(/^WHISPER_MODEL=(.+)$/m) || [])[1] || 'base.en').trim() + '.bin');
  const whisper = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'].find((p) => { try { fs.accessSync(p); return true; } catch { return false; } });
  if (!whisper || !fs.existsSync(model)) return '';
  try {
    execFileSync('ffmpeg', ['-y', '-i', audioPath, '-ar', '16000', '-ac', '1', wav], { stdio: 'ignore' });
    const out = execFileSync(whisper, ['-m', model, '-f', wav, '--no-timestamps', '-np'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return out.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  } catch { return ''; }
  finally { try { fs.unlinkSync(wav); } catch {} }
}

// One-way owner push to whichever channels are configured (single fixed destination each — no recipient param).
async function notifyAll(text) {
  const cfg = loadEnv();
  if (cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_OWNER_CHAT_ID) { try { await telegramSend(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_OWNER_CHAT_ID, text); } catch {} }
  if (cfg.DISCORD_BOT_TOKEN && cfg.DISCORD_OWNER_USER_ID) { try { await discordDM(cfg.DISCORD_BOT_TOKEN, cfg.DISCORD_OWNER_USER_ID, text); } catch {} }
  if (cfg.SLACK_BOT_TOKEN && cfg.SLACK_OWNER_USER_ID) { try { await slackPost(cfg.SLACK_BOT_TOKEN, cfg.SLACK_OWNER_USER_ID, text); } catch {} }
  if (process.platform === 'darwin' && cfg.IMESSAGE_OWNER_HANDLE) { try { await imessageSend(cfg.IMESSAGE_OWNER_HANDLE, text); } catch {} }
}

// channels that are code-complete + unit-tested but NOT yet certified against live accounts or a real device.
// Warn the owner loudly at startup so a first session can't fail silently on the least-exercised surface.
const EXPERIMENTAL = new Set(['matrix', 'signal', 'whatsapp', 'discord-voice', 'termux']);
function warnExperimental(channel) {
  if (!EXPERIMENTAL.has(channel)) return;
  try { process.stderr.write('\n  [!] ' + channel + ' is EXPERIMENTAL: code-complete and unit-tested, but not yet certified against live accounts, so it may not work end-to-end yet. Please report what you hit at https://github.com/Grandillionaire/urfael/issues\n\n'); } catch {}
}

module.exports = { JDIR, SOCK, ENVF, TEAMF, AUDIT, loadEnv, loadRoster, resolvePrincipal, tryPair, audit, askDaemon, notifyDaemon, stripSpoken, TokenBucket, httpsJson, telegramSend, discordDM, qqSend, slackApi, slackPost, imessageSend, notifyAll, httpsDownload, transcribeLocal, EXPERIMENTAL, warnExperimental };
