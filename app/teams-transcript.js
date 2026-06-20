'use strict';
// app/teams-transcript.js — the Teams meeting-transcript runner. OUTBOUND-ONLY: it polls Microsoft Graph with the
// user's OWN delegated token and writes a vault note; Urfael opens no inbound port (run it on a cron/launchd timer).
// The transcript-shaping is the PURE, unit-tested teams-vtt.js; this file is the thin I/O shell (OAuth refresh,
// Graph fetch, idempotent state, vault write). STATUS: code-complete; the live Graph path needs a real M365 tenant
// + a recorded/transcribed meeting + admin-consented app to certify — not battle-hardened until then.
//   node teams-transcript.js          one poll pass (cron this)
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('./bridge/bridge-core');
const vtt = require('./teams-vtt');

const JDIR = path.join(os.homedir(), '.claude', 'urfael');
const VAULT = path.join(os.homedir(), process.env.URFAEL_VAULT_DIR || 'Urfael');
const NOTES_DIR = path.join(VAULT, '03_Resources', 'Teams-Transcripts');
const STATE = path.join(JDIR, 'teams-state.json');
const SESS_DIR = path.join(os.homedir(), process.env.URFAEL_MEMORY_DIR || 'Urfael-memory', 'sessions');

function loadState() { try { const j = JSON.parse(fs.readFileSync(STATE, 'utf8')); return (j && typeof j === 'object') ? j : { seen: [] }; } catch { return { seen: [] }; } }
function saveState(s) { try { fs.mkdirSync(JDIR, { recursive: true }); const t = STATE + '.tmp'; fs.writeFileSync(t, JSON.stringify(s, null, 2), { mode: 0o600 }); fs.renameSync(t, STATE); } catch {} }

// refresh the owner's delegated bearer (their own Entra app). Returns '' on failure (fail-soft).
async function accessToken(cfg) {
  const r = await core.httpsJson({ hostname: 'login.microsoftonline.com', path: '/' + cfg.TEAMS_TENANT + '/oauth2/v2.0/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    'client_id=' + encodeURIComponent(cfg.TEAMS_CLIENT_ID) + '&grant_type=refresh_token&refresh_token=' + encodeURIComponent(cfg.TEAMS_REFRESH_TOKEN) + '&scope=' + encodeURIComponent('OnlineMeetingTranscript.Read.All offline_access')).catch(() => null);
  if (r && r.json && r.json.refresh_token) { try { core.audit({ ev: 'teams_token_rotated' }); } catch {} }   // (rotating the stored refresh token is the runner's next-increment hardening)
  return (r && r.json && r.json.access_token) || '';
}
const graph = (token, p) => core.httpsJson({ hostname: 'graph.microsoft.com', path: p, method: 'GET', headers: { Authorization: 'Bearer ' + token } });

async function run() {
  const cfg = core.loadEnv();
  if (!cfg.TEAMS_TENANT || !cfg.TEAMS_CLIENT_ID || !cfg.TEAMS_REFRESH_TOKEN || !cfg.TEAMS_USER_ID) { console.error('teams-transcript: set TEAMS_TENANT, TEAMS_CLIENT_ID, TEAMS_REFRESH_TOKEN, TEAMS_USER_ID in ~/.claude/urfael/bridge.env'); return { error: 'env' }; }
  const token = await accessToken(cfg);
  if (!token) { core.audit({ ev: 'teams_auth_fail' }); return { error: 'auth' }; }
  const state = loadState(); const seen = new Set(state.seen || []);
  // enumerate the user's recent meeting transcripts (the organizer param is required by Graph)
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const list = await graph(token, "/v1.0/me/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='" + cfg.TEAMS_USER_ID + "',startDateTime=" + since + ')').catch(() => null);
  const items = (list && list.json && Array.isArray(list.json.value)) ? list.json.value : [];
  let wrote = 0;
  for (const it of items) {
    const id = it && it.id; const meetingId = (it && it.meetingId) || '';
    if (!id || seen.has(id)) continue;
    const vttRes = await graph(token, '/v1.0/me/onlineMeetings/' + meetingId + '/transcripts/' + id + '/content?$format=text/vtt').catch(() => null);
    const body = vttRes && (vttRes.raw || (typeof vttRes.json === 'string' ? vttRes.json : ''));
    const cues = vtt.parseVtt(body);
    if (!cues.length) continue;   // content lags the listing + transiently 404s — leave UNSEEN for the next poll (no false 'done')
    const meta = { title: it.subject || meetingId || 'Teams meeting', meetingId, transcriptId: id, organizer: cfg.TEAMS_USER_ID, start: it.createdDateTime || '', end: it.endDateTime || '', created: new Date().toISOString().slice(0, 10) };
    const note = vtt.buildNote(meta, cues);
    try {
      fs.mkdirSync(NOTES_DIR, { recursive: true });
      fs.writeFileSync(path.join(NOTES_DIR, vtt.noteFilename(meta)), note, { mode: 0o600 });
      // archive a recall row so `urfael sessions search` + BM25 surface it later (no new datastore)
      try { fs.mkdirSync(SESS_DIR, { recursive: true }); fs.appendFileSync(path.join(SESS_DIR, new Date().toISOString().slice(0, 10) + '.jsonl'), JSON.stringify({ t: new Date().toISOString(), channel: 'teams', user: meta.title, urfael: cues.map((c) => (c.speaker || '?') + ': ' + c.text).join('\n') }) + '\n'); } catch {}
      seen.add(id); wrote++; core.audit({ ev: 'teams_transcript', meetingId, cues: cues.length });
    } catch (e) { core.audit({ ev: 'teams_write_fail', err: String((e && e.message) || e) }); }
  }
  state.seen = [...seen].slice(-500); saveState(state);   // bounded seen-set
  return { wrote, scanned: items.length };
}

if (require.main === module) run().then((r) => { if (r && r.error) process.exit(1); if (r && r.wrote) console.log('teams: wrote ' + r.wrote + ' transcript note(s)'); }).catch((e) => { console.error(e); process.exit(1); });
module.exports = { run, accessToken, loadState };
