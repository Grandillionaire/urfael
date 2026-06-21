'use strict';
// app/bridge/webhook-lib.js — PURE adapter layer for the native webhook channels (Mattermost, Google Chat, SMS via
// Twilio, DingTalk, Home Assistant, BlueBubbles, Feishu/Lark, WeCom). One small adapter per platform: verify the
// inbound request (timing-safe), parse out { senderId, text }, and format a reply for the platforms that answer in
// the HTTP response. No I/O, no sockets, no daemon (webhook-bridge.js is the thin shell). Unit-tested + never throws.
//
// Why this beats Hermes's channel layer (verified against their gateway/platforms/*.py, June 2026): their base
// adapter is ~5000 lines and a single platform is ~1000; authorization is DISTRIBUTED across adapters that default
// to `dm_policy: open` (forward every sender) with a central mixin reasoning about which adapter actually restricted.
// Here every channel is a few pure lines, and authorization is NOT the adapter's job at all: the bridge runs the one
// fail-closed allowlist (resolvePrincipal -> null -> DROP) before the brain, uniformly, for every platform. An
// adapter can only ever extract a sender id and text; it can never grant access.

const crypto = require('crypto');

// timing-safe string compare that never leaks length (mismatched lengths are compared against themselves → false).
function tsEqual(a, b) {
  const x = Buffer.from(String(a == null ? '' : a));
  const y = Buffer.from(String(b == null ? '' : b));
  if (x.length !== y.length) { try { crypto.timingSafeEqual(x, x); } catch {} return false; }
  try { return crypto.timingSafeEqual(x, y); } catch { return false; }
}
const hmac = (alg, key, data, enc) => { try { return crypto.createHmac(alg, String(key)).update(String(data)).digest(enc || 'base64'); } catch { return ''; } };
const sha1Hex = (data) => { try { return crypto.createHash('sha1').update(String(data)).digest('hex'); } catch { return ''; } };
const str = (v) => (v == null ? '' : String(v));
const get = (o, p) => { let c = o; for (const k of p.split('.')) { if (c == null || typeof c !== 'object') return undefined; c = c[k]; } return c; };

// Twilio request-signature base string: the full URL with POST params appended sorted by key (Twilio's documented
// scheme). The bridge passes the exact public URL it was reached at.
function twilioBase(url, params) {
  const p = params && typeof params === 'object' ? params : {};
  return str(url) + Object.keys(p).sort().map((k) => k + str(p[k])).join('');
}

// Each adapter: verify(ctx) -> bool · parse(ctx) -> { senderId, text } | null · reply(text) -> { body, type } | null
//   ctx = { body (parsed JSON or form object), raw (string), headers (lowercased map), query (object), url, cfg }
const ADAPTERS = {
  // Mattermost outgoing webhook: a shared token in the form post; replies in the HTTP response.
  mattermost: {
    verify: (c) => !!c.cfg.MATTERMOST_TOKEN && tsEqual(get(c.body, 'token') || c.headers['authorization'], c.cfg.MATTERMOST_TOKEN),
    parse: (c) => { const text = str(get(c.body, 'text')).trim(); const senderId = str(get(c.body, 'user_id') || get(c.body, 'user_name')); return text && senderId ? { senderId, text } : null; },
    reply: (t) => ({ body: JSON.stringify({ text: str(t) }), type: 'application/json' }),
  },

  // Google Chat: a configured shared token (query/header). Replies in the HTTP response. (Full Bearer-JWT
  // verification against Google's certs is the documented hardening step; shared-token mode is supported + simpler.)
  googlechat: {
    verify: (c) => !!c.cfg.GOOGLECHAT_TOKEN && tsEqual(c.query.token || c.headers['x-goog-token'], c.cfg.GOOGLECHAT_TOKEN),
    parse: (c) => { const text = str(get(c.body, 'message.text') || get(c.body, 'text')).trim(); const senderId = str(get(c.body, 'message.sender.name') || get(c.body, 'user.name')); return text && senderId ? { senderId, text } : null; },
    reply: (t) => ({ body: JSON.stringify({ text: str(t) }), type: 'application/json' }),
  },

  // SMS via Twilio: HMAC-SHA1 over (url + sorted form params), base64, against X-Twilio-Signature. TwiML reply.
  sms: {
    verify: (c) => !!c.cfg.TWILIO_AUTH_TOKEN && tsEqual(hmac('sha1', c.cfg.TWILIO_AUTH_TOKEN, twilioBase(c.url, c.body), 'base64'), c.headers['x-twilio-signature']),
    parse: (c) => { const text = str(get(c.body, 'Body')).trim(); const senderId = str(get(c.body, 'From')); return text && senderId ? { senderId, text } : null; },
    reply: (t) => ({ body: '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + str(t).replace(/[<>&]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[m])) + '</Message></Response>', type: 'text/xml' }),
  },

  // DingTalk outgoing robot: HMAC-SHA256(timestamp, secret) base64 against the `sign` query param, with a freshness
  // window on the timestamp; replies in the HTTP response (sessionWebhook is the async path, the cert step).
  dingtalk: {
    verify: (c) => {
      if (!c.cfg.DINGTALK_SECRET) return false;
      const ts = Number(c.query.timestamp || c.headers['timestamp']);
      if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 3600000) return false;     // ±1h freshness
      return tsEqual(hmac('sha256', c.cfg.DINGTALK_SECRET, ts + '\n' + c.cfg.DINGTALK_SECRET, 'base64'), c.query.sign);
    },
    parse: (c) => { const text = str(get(c.body, 'text.content')).trim(); const senderId = str(get(c.body, 'senderStaffId') || get(c.body, 'senderId') || get(c.body, 'senderNick')); return text && senderId ? { senderId, text } : null; },
    reply: (t) => ({ body: JSON.stringify({ msgtype: 'text', text: { content: str(t) } }), type: 'application/json' }),
  },

  // Home Assistant: a shared token (header/query) gating an inbound conversation webhook; replies in the response.
  homeassistant: {
    verify: (c) => !!c.cfg.HOMEASSISTANT_TOKEN && tsEqual(c.query.token || (str(c.headers['authorization']).replace(/^Bearer\s+/i, '')), c.cfg.HOMEASSISTANT_TOKEN),
    parse: (c) => { const text = str(get(c.body, 'text') || get(c.body, 'message')).trim(); const senderId = str(get(c.body, 'sender') || get(c.body, 'device_id') || 'home'); return text ? { senderId, text } : null; },
    reply: (t) => ({ body: JSON.stringify({ speech: { plain: { speech: str(t) } } }), type: 'application/json' }),
  },

  // BlueBubbles (self-hosted iMessage server): a shared password gates the inbound webhook; outbound goes back to the
  // BB server (the live-cert step), so here we acknowledge after the allowlist + brain.
  bluebubbles: {
    verify: (c) => !!c.cfg.BLUEBUBBLES_PASSWORD && tsEqual(c.query.password || c.headers['password'], c.cfg.BLUEBUBBLES_PASSWORD),
    parse: (c) => { const text = str(get(c.body, 'data.text') || get(c.body, 'text')).trim(); const senderId = str(get(c.body, 'data.handle.address') || get(c.body, 'data.handle') || get(c.body, 'handle')); return text && senderId ? { senderId, text } : null; },
    reply: null,                                                        // async send back to the BB server (cert step)
  },

  // Feishu / Lark: a configured verification token gates the event callback (the encrypt+signature mode is the cert
  // step). The url_verification challenge is handled by the bridge before the adapter. Outbound via API (cert step).
  feishu: {
    verify: (c) => !!c.cfg.FEISHU_VERIFY_TOKEN && tsEqual(get(c.body, 'token') || get(c.body, 'header.token'), c.cfg.FEISHU_VERIFY_TOKEN),
    parse: (c) => {
      let content = get(c.body, 'event.message.content'); let text = '';
      try { text = str(JSON.parse(str(content)).text); } catch { text = str(content); }
      const senderId = str(get(c.body, 'event.sender.sender_id.open_id') || get(c.body, 'event.sender.sender_id.user_id'));
      return text.trim() && senderId ? { senderId, text: text.trim() } : null;
    },
    reply: null,
  },

  // WeCom (WeChat Work): msg_signature = sha1(sorted(token, timestamp, nonce, encrypt)). We verify the SIGNATURE
  // here (fail-closed); AES-CBC decryption of the payload is the documented cert step (outbound via API too).
  wecom: {
    verify: (c) => {
      if (!c.cfg.WECOM_TOKEN) return false;
      const sig = c.query.msg_signature, ts = c.query.timestamp, nonce = c.query.nonce;
      const enc = c.query.echostr || get(c.body, 'Encrypt') || get(c.body, 'xml.Encrypt') || '';
      if (!sig || !ts || !nonce) return false;
      return tsEqual(sha1Hex([c.cfg.WECOM_TOKEN, str(ts), str(nonce), str(enc)].sort().join('')), sig);
    },
    parse: (c) => { const text = str(get(c.body, 'text') || get(c.body, 'Content')).trim(); const senderId = str(get(c.body, 'from') || get(c.body, 'FromUserName')); return text && senderId ? { senderId, text } : null; },
    reply: null,
  },
};

const CHANNELS = Object.keys(ADAPTERS);
function isChannel(ch) { return Object.prototype.hasOwnProperty.call(ADAPTERS, ch); }

// dispatch(channel, ctx) → { ok, senderId, text } | { ok:false, reason }. Verifies THEN parses; both fail-closed.
// Authorization is NOT done here — the bridge runs resolvePrincipal on the returned senderId before the brain.
function dispatch(channel, ctx) {
  const a = ADAPTERS[channel];
  if (!a) return { ok: false, reason: 'unknown-channel' };
  const c = { body: ctx.body || {}, raw: str(ctx.raw), headers: ctx.headers || {}, query: ctx.query || {}, url: str(ctx.url), cfg: ctx.cfg || {} };
  if (!a.verify(c)) return { ok: false, reason: 'bad-signature' };
  const m = a.parse(c);
  if (!m || !m.senderId || !m.text) return { ok: false, reason: 'unparseable' };
  return { ok: true, senderId: m.senderId, text: m.text };
}
function formatReply(channel, text) { const a = ADAPTERS[channel]; return (a && a.reply) ? a.reply(text) : null; }

module.exports = { ADAPTERS, CHANNELS, isChannel, dispatch, formatReply, tsEqual, hmac, twilioBase };
