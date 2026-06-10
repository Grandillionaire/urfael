'use strict';
// Shared bridge plumbing: read bridge.env, relay to the daemon's /ask over the unix socket with a channel
// tag (which the daemon forces into the sandboxed 'untrusted' profile), rate-limit, audit, and one-way push.
// No third-party deps — built-in http/https only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const JDIR = path.join(os.homedir(), '.claude', 'urfael');
const SOCK = path.join(JDIR, 'daemon.sock');
const ENVF = path.join(JDIR, 'bridge.env');
const AUDIT = path.join(JDIR, 'bridge-audit.log');

function loadEnv() {
  const cfg = {};
  try {
    for (const line of fs.readFileSync(ENVF, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#') || !s.includes('=')) continue;
      const i = s.indexOf('='); cfg[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
  return cfg;
}

function audit(o) { try { fs.appendFileSync(AUDIT, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n'); } catch {} }

// POST /ask over the unix socket with a channel tag; collapse the NDJSON stream to the final 'done' text.
function askDaemon(text, channel) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ text, channel });
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

// One-way owner push to whichever channels are configured (single fixed destination each — no recipient param).
async function notifyAll(text) {
  const cfg = loadEnv();
  if (cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_OWNER_CHAT_ID) { try { await telegramSend(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_OWNER_CHAT_ID, text); } catch {} }
  if (cfg.DISCORD_BOT_TOKEN && cfg.DISCORD_OWNER_USER_ID) { try { await discordDM(cfg.DISCORD_BOT_TOKEN, cfg.DISCORD_OWNER_USER_ID, text); } catch {} }
}

module.exports = { JDIR, SOCK, ENVF, AUDIT, loadEnv, audit, askDaemon, stripSpoken, TokenBucket, httpsJson, telegramSend, discordDM, notifyAll };
