'use strict';
// Telegram bridge — TEAM-MODE allowlisted phone control of Urfael. Outbound long-poll only (NO inbound port).
// Each ALLOWLISTED principal's message is relayed to POST /ask with channel:'telegram' + their role, which the
// daemon maps to a sandbox profile (owner/member -> read+search; guest -> read-a-known-path only) and attributes
// the turn. A non-allowlisted sender is DROPPED before the brain ever sees it. Works on Node 18+.
//   node telegram-bridge.js            run the bridge
//   node telegram-bridge.js --notify "text"   one-way push to the primary owner (used by jobs/brief)
const core = require('./bridge-core');

const cfg = core.loadEnv();
const TOKEN = cfg.TELEGRAM_BOT_TOKEN;
const OWNER = cfg.TELEGRAM_OWNER_CHAT_ID; // primary owner, for one-way push (notify) only
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function notifyMode() {
  const i = process.argv.indexOf('--notify');
  if (i < 0) return false;
  if (TOKEN && OWNER) { try { await core.telegramSend(TOKEN, OWNER, process.argv[i + 1] || ''); } catch {} }
  process.exit(0);
}

// Relay one principal's message and reply to THAT principal's chat (not a fixed owner). The daemon scopes the
// turn by principal.role and attributes it to principal.name.
async function handle(text, principal) {
  const t0 = Date.now();
  const to = principal.id;
  const placeholder = await core.telegramSend(TOKEN, to, '…thinking');
  const mid = placeholder.json && placeholder.json.result && placeholder.json.result.message_id;
  const reply = core.stripSpoken(await core.askDaemon(text, 'telegram', principal));
  if (mid) {
    try {
      await core.httpsJson({ hostname: 'api.telegram.org', path: `/bot${TOKEN}/editMessageText`, method: 'POST', headers: { 'Content-Type': 'application/json' } },
        { chat_id: to, message_id: mid, text: reply.slice(0, 4000), disable_web_page_preview: true });
    } catch { await core.telegramSend(TOKEN, to, reply); }
  } else { await core.telegramSend(TOKEN, to, reply); }
  core.audit({ ev: 'telegram_turn', principal: principal.name, role: principal.role, inLen: text.length, outLen: reply.length, ms: Date.now() - t0 });
}

// Voice memo → local whisper transcript → normal scoped turn. The transcript is echoed back to the principal
// first so they can see what was heard. Degrades clearly if whisper-cpp isn't installed.
async function handleVoice(voice, principal) {
  const t0 = Date.now();
  const to = principal.id;
  if ((voice.duration || 0) > 300) { await core.telegramSend(TOKEN, to, 'Voice memo too long (5 min max).'); return; }
  let tmp = '';
  try {
    const meta = await core.httpsJson({ hostname: 'api.telegram.org', path: `/bot${TOKEN}/getFile?file_id=${encodeURIComponent(voice.file_id)}`, method: 'GET' });
    const fp = meta.json && meta.json.result && meta.json.result.file_path;
    if (!fp) throw new Error('getFile failed');
    tmp = require('os').tmpdir() + '/uf-voice-' + Date.now() + '.' + (fp.split('.').pop() || 'oga');
    await core.httpsDownload(`https://api.telegram.org/file/bot${TOKEN}/${fp}`, tmp);
    const said = core.transcribeLocal(tmp);
    if (!said) { await core.telegramSend(TOKEN, to, 'Could not transcribe (is whisper-cpp installed on the Mac?).'); return; }
    core.audit({ ev: 'telegram_voice', principal: principal.name, secs: voice.duration || 0, chars: said.length, ms: Date.now() - t0 });
    await core.telegramSend(TOKEN, to, 'heard: ' + said.slice(0, 500));
    await handle(said, principal);
  } catch (e) { core.audit({ ev: 'telegram_voice_error', err: String((e && e.message) || e) }); }
  finally { if (tmp) { try { require('fs').unlinkSync(tmp); } catch {} } }
}

async function main() {
  if (await notifyMode()) return;
  if (!TOKEN) { console.error('telegram-bridge: set TELEGRAM_BOT_TOKEN in ~/.claude/urfael/bridge.env'); process.exit(1); }
  let roster = core.loadRoster();
  if (!Array.isArray(roster.telegram) || !roster.telegram.length) {
    console.error('telegram-bridge: no telegram principals — set TELEGRAM_OWNER_CHAT_ID, or add a "telegram" roster to ~/.claude/urfael/team.json'); process.exit(1);
  }

  const bucket = new core.TokenBucket(8, 20); // 8 burst, ~20/min sustained — bounds a flood/injection loop
  const pairBucket = new core.TokenBucket(5, 5); // 5 burst, ~5/min — bounds anonymous /pair/redeem floods from non-roster senders
  let offset = 0;
  core.audit({ ev: 'telegram_start', principals: roster.telegram.length });
  for (;;) {
    let updates = [];
    try {
      const r = await core.httpsJson({ hostname: 'api.telegram.org', path: `/bot${TOKEN}/getUpdates?timeout=50&offset=${offset}`, method: 'GET' });
      updates = (r.json && r.json.result) || [];
    } catch { await sleep(3000); continue; }
    if (updates.length) roster = core.loadRoster(); // refresh so team.json edits take effect without a restart
    for (const u of updates) {
      offset = u.update_id + 1;
      const msg = u.message || u.edited_message;
      if (!msg || !msg.chat) continue;
      const principal = core.resolvePrincipal('telegram', msg.chat.id, roster); // ALLOWLIST, before the brain
      if (!principal) {
        if (!pairBucket.take()) continue; // throttle anonymous pairing-redeem attempts: drop silently when exhausted (no tryPair round-trip, no audit, no reply)
        // self-enroll: a non-roster sender's message might be a pairing code → enroll as guest (daemon-decided)
        if (msg.text) { const pr = await core.tryPair('telegram', msg.chat.id, msg.text); if (pr && pr.ok) { core.audit({ ev: 'telegram_pair', from: msg.chat.id }); try { await core.telegramSend(TOKEN, msg.chat.id, 'You are paired as a guest. Send a message to begin.'); } catch {} continue; } }
        core.audit({ ev: 'telegram_drop', from: msg.chat && msg.chat.id }); continue;
      }
      if (!msg.text && !msg.voice && !msg.audio) continue;
      if (!bucket.take()) { core.audit({ ev: 'telegram_ratelimited', principal: principal.name }); try { await core.telegramSend(TOKEN, principal.id, 'Rate limited — give me a second.'); } catch {} continue; }
      if (msg.text) handle(msg.text, principal).catch(() => {});
      else handleVoice(msg.voice || msg.audio, principal).catch(() => {});
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
