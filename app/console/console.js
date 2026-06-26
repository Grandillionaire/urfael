'use strict';
// Urfael Console — the desktop-app surface. Chat with streamed tool activity, the session archive,
// reminders, jobs, hearth, settings. Same daemon, same brain as the orb; this is just a bigger window
// onto it. Keyboard-first: ⌘1–6 views, ⌘K/⌘P command palette, ⌘F archive search, Enter sends, ↑ recalls.

const $ = (s) => document.querySelector(s);
const VIEWS = ['converse', 'archive', 'reminders', 'jobs', 'hearth', 'settings', 'chats'];

// ---- first-run onboarding (no terminal needed) -----------------------------
(function onboarding() {
  const ob = $('#onboard'); if (!ob) return;
  let mode = 'subscription';
  const note = $('#ob-note'), keyIn = $('#ob-key'), urlIn = $('#ob-url');
  function selectChoice(el) {
    mode = el.dataset.mode;
    ob.querySelectorAll('.ob-choice').forEach((c) => c.classList.toggle('sel', c === el));
    if (keyIn) keyIn.hidden = mode !== 'apikey';
    if (urlIn) urlIn.hidden = mode !== 'local';
    const focusEl = mode === 'apikey' ? keyIn : mode === 'local' ? urlIn : null;
    if (focusEl) setTimeout(() => focusEl.focus(), 0);
  }
  ob.querySelectorAll('.ob-choice').forEach((c) => c.addEventListener('click', () => selectChoice(c)));
  $('#ob-go').addEventListener('click', async () => {
    note.classList.remove('err'); note.textContent = '';
    const cfg = { mode };
    if (mode === 'apikey') { cfg.key = (keyIn.value || '').trim(); if (!cfg.key) { note.classList.add('err'); note.textContent = 'Paste your API key, or pick another option.'; return; } }
    if (mode === 'local') { cfg.url = (urlIn.value || '').trim(); if (!/^https?:\/\//.test(cfg.url)) { note.classList.add('err'); note.textContent = 'Enter a valid http(s) endpoint, or pick another option.'; return; } }
    $('#ob-go').disabled = true; note.textContent = 'Setting up…';
    const r = await window.urfael.saveProvider(cfg).catch(() => ({ ok: false }));
    $('#ob-go').disabled = false;
    if (r && r.ok) { ob.hidden = true; try { $('#input').focus(); } catch {} }
    else { note.classList.add('err'); note.textContent = 'Could not save. ' + ((r && r.error) || 'Try again.'); }
  });
  // show only on a fresh install (the marker / provider.env is absent)
  (async () => { try { const s = await window.urfael.providerStatus(); if (s && !s.onboarded) ob.hidden = false; } catch {} })();
})();

// ---- Settings: change provider re-opens the onboarding card (handlers already wired above) ----
(function providerSettings() {
  const btn = $('#change-provider');
  if (btn) btn.addEventListener('click', () => { const ob = $('#onboard'); if (ob) ob.hidden = false; });
  if (window.urfael && window.urfael.providerStatus) {
    window.urfael.providerStatus().then((s) => {
      const el = $('#provider-mode'); if (!el || !s) return;
      el.textContent = s.mode === 'apikey' ? 'an Anthropic API key' : s.mode === 'local' ? 'a local / custom model' : 'your Claude subscription';
    }).catch(() => {});
  }
})();

// ---- view switching --------------------------------------------------------
let view = 'converse';
function show(v) {
  view = v;
  for (const x of VIEWS) { $('#view-' + x).hidden = x !== v; }
  document.querySelectorAll('.nav').forEach((b) => b.setAttribute('aria-current', b.dataset.view === v ? 'true' : 'false'));
  if (v === 'archive') loadDays();
  if (v === 'reminders') loadReminders();
  if (v === 'jobs') loadJobs();
  if (v === 'hearth') loadHearth();
  if (v === 'settings') loadSettings();
  if (v === 'chats') initChats();
  if (v === 'converse') $('#input').focus();
}
document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if ((e.metaKey || e.ctrlKey) && (k === 'k' || k === 'p')) { e.preventDefault(); Palette.toggle(); return; } // ⌘K / ⌘P → command palette
  if (Palette.isOpen()) return;                                                                                // palette is modal — let it own the keys
  if ((e.metaKey || e.ctrlKey) && e.key >= '1' && e.key <= '7') { e.preventDefault(); show(VIEWS[+e.key - 1]); }
  if ((e.metaKey || e.ctrlKey) && k === 'f' && view === 'archive') { e.preventDefault(); $('#arch-search').focus(); } // ⌘F → archive search (when in view)
});

// ---- converse ---------------------------------------------------------------
const thread = $('#thread');
const input = $('#input');
const sendBtn = $('#send');
let liveMsg = null, liveText = '', liveTools = [], lastSent = '', asking = false;

const TOOL_LABEL = (n) => {
  n = (n || '').toLowerCase();
  if (n.includes('event') || n.includes('calendar')) return 'Checking the calendar';
  if (n.includes('thread') || n.includes('mail') || n.includes('draft') || n.includes('label')) return 'Checking email';
  if (n.includes('search') || n.includes('vault') || n.includes('read') || n.includes('list') || n.includes('document') || n.includes('grep') || n.includes('glob')) return 'Searching the archive';
  if (n.includes('write') || n.includes('append') || n.includes('patch') || n.includes('create') || n.includes('edit')) return 'Writing to the vault';
  if (n.includes('navigate') || n.includes('browser') || n.includes('page') || n.includes('click') || n.includes('fetch')) return 'Reaching into the web';
  if (n.includes('bash') || n.includes('terminal')) return 'Working the forge';
  return 'Using ' + n;
};

// pin-to-bottom autoscroll: only follow the stream if the reader is already at the bottom (NN/g)
function nearBottom() { return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48; }
function follow(pinned) { if (pinned) thread.scrollTop = thread.scrollHeight; }

function addMsg(who, text) {
  $('#thread-empty')?.remove();
  const d = document.createElement('div'); d.className = 'msg ' + who;
  const w = document.createElement('div'); w.className = 'who'; w.textContent = who === 'you' ? 'You' : 'Urfael';
  const t = document.createElement('div'); t.className = 'text'; t.textContent = text;
  d.append(w, t); thread.appendChild(d);
  return d;
}
function splitSpoken(t) {
  const m = (t || '').match(/\[SPOKEN\]([\s\S]*?)\[\/SPOKEN\]/i);
  const remark = m ? m[1].trim() : '';
  const body = (t || '').replace(/\[SPOKEN\][\s\S]*?\[\/SPOKEN\]/i, '').replace(/\[\/?SPOKEN\]/gi, '').trim();
  return { remark, body: body || remark };
}
function renderLive() {
  if (!liveMsg) return;
  const pinned = nearBottom();
  const { remark, body } = splitSpoken(liveText);
  liveMsg.querySelector('.remark').textContent = remark;
  const t = liveMsg.querySelector('.text');
  t.textContent = body === remark && /\[SPOKEN\]/i.test(liveText) && !/\[\/SPOKEN\]/i.test(liveText) ? '' : body;
  t.appendChild(Object.assign(document.createElement('span'), { className: 'cursor', textContent: '▋' }));
  follow(pinned);
}
let renderQueued = false;
function queueRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; renderLive(); }); } }

// Send button doubles as Stop while a turn is in flight — one affordance, two states.
function setAsking(on) {
  asking = on;
  sendBtn.classList.toggle('stop', on);   // CSS swaps the arrow icon for the stop-square icon
  sendBtn.setAttribute('aria-label', on ? 'Stop' : 'Send');
}
async function abort() {
  if (!asking) return;
  try { await window.urfael.abort(); } catch {}
  // the daemon emits a {done, aborted} event which finishLive renders; this is a belt-and-braces fallback
}

async function send() {
  const text = input.value.trim();
  if (asking) { abort(); return; }   // clicking Send while asking = Stop
  if (!text) return;
  lastSent = text; input.value = ''; autosize();
  setAsking(true);
  addMsg('you', text);
  const pinned = nearBottom();
  liveMsg = document.createElement('div'); liveMsg.className = 'msg urfael';
  liveMsg.innerHTML = '<div class="who">Urfael</div><div class="remark"></div><div class="text"><span class="cursor">▋</span></div><div class="meta"></div>';
  thread.appendChild(liveMsg); follow(pinned);
  liveText = ''; liveTools = [];
  const r = await window.urfael.ask(text).catch(() => null);
  finishLive(r);
}
function finishLive(r) {
  const wasMine = asking;
  setAsking(false);
  if (!liveMsg) return;
  const pinned = nearBottom();
  // the done event carries aborted:true; the awaited ask() resolves without it, so also detect '(stopped)' text
  const stopped = !!(r && (r.aborted || r.text === '(stopped)'));
  const { remark, body } = splitSpoken((r && r.text) || liveText);
  if (wasMine && !stopped) speak(remark || (body || '').split(/(?<=[.!?])\s/)[0]);
  liveMsg.querySelector('.remark').textContent = stopped ? '' : remark;
  liveMsg.classList.toggle('stopped', stopped);
  liveMsg.querySelector('.text').textContent = stopped ? (body || '(stopped)') : (body || '(no reply — is the brain awake?)');
  for (const tr of liveTools) tr.classList.add('done');
  if (r && r.model && !stopped) liveMsg.querySelector('.meta').textContent = r.model;
  liveMsg = null; liveText = '';
  follow(pinned);
  if (stopped && wasMine && view === 'converse') input.focus();   // return the cursor after a Stop
}

// live events from the daemon (also mirrors voice turns started at the orb)
window.urfael.onThinking((p) => {
  if (p.reset) {
    if (!liveMsg && view === 'converse') { // a turn started elsewhere (voice/CLI) — mirror it
      const pinned = nearBottom();
      liveMsg = document.createElement('div'); liveMsg.className = 'msg urfael';
      liveMsg.innerHTML = '<div class="who">Urfael</div><div class="remark"></div><div class="text"></div><div class="meta"></div>';
      $('#thread-empty')?.remove(); thread.appendChild(liveMsg); follow(pinned);
    }
    liveText = ''; liveTools = [];
  } else if (p.tool && liveMsg) {
    const pinned = nearBottom();
    const tr = document.createElement('div'); tr.className = 'toolrow'; tr.textContent = TOOL_LABEL(p.tool);
    liveMsg.before(tr); liveTools.push(tr); follow(pinned);
  } else if (p.delta && liveMsg) {
    liveText += p.delta; queueRender();
  }
});
window.urfael.onDone((p) => { if (liveMsg && !asking) finishLive(p); });

// ---- voice in the Console: push-to-talk in, spoken remark out ------------------
const micBtn = $('#mic'), muteBtn = $('#mute');
let recState = null, voiceOn = true, actx = null;
async function toggleMic() {
  if (recState) { try { recState.stop(); } catch {} return; }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).catch(() => null);
  if (!stream) { micBtn.title = 'Mic blocked — allow it in System Settings'; return; }
  let recorder;
  try { recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' }); }   // the constructor throws NotSupportedError if the encoder is unavailable; release the mic + reset rather than leave it hot
  catch { try { stream.getTracks().forEach((t) => t.stop()); } catch {} recState = null; micBtn.classList.remove('rec'); micBtn.title = 'Recording is not supported here'; return; }
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    recState = null; micBtn.classList.remove('rec');
    const buf = await new Blob(chunks, { type: 'audio/webm' }).arrayBuffer();
    const said = (await window.urfael.stt(buf).catch(() => '')) || '';
    const clean = said.replace(/[\(\[][^)\]]*[\)\]]/g, '').trim();
    if (clean.length > 1) { input.value = clean; send(); }
  };
  recorder.start(); recState = recorder; micBtn.classList.add('rec');
}
micBtn.addEventListener('click', toggleMic);
async function speak(text) {
  if (!voiceOn || !text) return;
  try {
    const clean = text.replace(/[#>*_~|`\\]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const u8 = await window.urfael.tts(clean);
    actx = actx || new AudioContext();
    const audio = await actx.decodeAudioData(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
    const src = actx.createBufferSource(); src.buffer = audio; src.connect(actx.destination); src.start();
  } catch {}
}
function toggleVoice() {
  voiceOn = !voiceOn;
  muteBtn.classList.toggle('off', !voiceOn);
  window.urfael.setConfig('CONSOLE_VOICE', voiceOn ? '1' : '0');
}
muteBtn.addEventListener('click', toggleVoice);

function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  else if (e.key === 'ArrowUp' && !input.value) { input.value = lastSent; autosize(); }
});
sendBtn.addEventListener('click', send);

// ---- archive ----------------------------------------------------------------
async function loadDays() {
  const days = await window.urfael.sessionsDays();
  const el = $('#arch-days'); el.innerHTML = '';
  if (!days.length) { el.innerHTML = '<div class="hint" style="padding:8px 10px">Nothing yet — every conversation will land here.</div>'; return; }
  for (const d of days) {
    const b = document.createElement('button'); b.className = 'day'; b.textContent = d; b.setAttribute('role', 'listitem');
    b.onclick = () => { document.querySelectorAll('.day').forEach((x) => x.removeAttribute('aria-current')); b.setAttribute('aria-current', 'true'); renderDay(d); };
    el.appendChild(b);
  }
}
function archTurn(e) {
  const d = document.createElement('div'); d.className = 'arch-turn';
  const { body } = splitSpoken(e.urfael || '');
  d.innerHTML = '<div class="t"></div><div class="u"></div><div class="a"></div>';
  d.querySelector('.t').textContent = (e.t || '').slice(0, 16).replace('T', '  ') + (e.channel && e.channel !== 'local' ? '  · ' + e.channel : '');
  d.querySelector('.u').textContent = e.user || '';
  d.querySelector('.a').textContent = body;
  return d;
}
async function renderDay(day) {
  const body = $('#arch-body'); body.innerHTML = '';
  const entries = await window.urfael.sessionRead(day);
  if (!entries.length) { body.innerHTML = '<div class="empty"><p>Nothing recorded that day.</p></div>'; return; }
  for (const e of entries) body.appendChild(archTurn(e));
}
// Inline BM25 (k1=1.5,b=0.75) mirroring app/recall.js: the daemon's sessionsSearch returns substring
// matches in archive order; we re-rank them so the most RELEVANT turns float to the top in the Console.
function bm25rank(entries, query, k = 60) {
  if (!entries || !entries.length) return entries || [];
  const tok = (s) => String(s == null ? '' : s).toLowerCase().match(/[a-z0-9]+/g) || [];
  const qUniq = [...new Set(tok(query))];
  if (!qUniq.length) return entries;
  const K1 = 1.5, B = 0.75, N = entries.length;
  const docs = entries.filter((e) => e && typeof e === 'object').map((e) => {   // a non-object row must not throw on (e.user || '')
    const toks = tok(((e.user || '') + ' ' + (e.urfael || '').replace(/\[\/?SPOKEN\]/gi, ' ')));
    const tf = new Map(); for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return { e, tf, len: toks.length };
  });
  const avgdl = docs.reduce((a, d) => a + d.len, 0) / N || 1;
  const df = new Map(); for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const idf = new Map(); for (const t of qUniq) { const n = df.get(t) || 0; idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5))); }
  const scored = [];
  for (const d of docs) {
    let s = 0;
    for (const t of qUniq) { const f = d.tf.get(t); if (!f) continue; s += idf.get(t) * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / avgdl))); }
    if (s > 0) scored.push({ e: d.e, s }); // drop non-matching docs (mirror recall.js's score>0 gate) — no irrelevant trailing rows
  }
  scored.sort((a, b) => (b.s - a.s) || (String(b.e.t || '') < String(a.e.t || '') ? -1 : 1)); // BM25 desc, recency tiebreak
  return scored.slice(0, k).map((x) => x.e);
}
let searchT = null;
$('#arch-search').addEventListener('input', () => {
  clearTimeout(searchT);
  searchT = setTimeout(async () => {
    const q = $('#arch-search').value.trim();
    if (!q) { $('#arch-body').innerHTML = '<div class="empty"><p>Pick a day — or search. Every word is kept.</p></div>'; return; }
    const hits = bm25rank(await window.urfael.sessionsSearch(q), q); // re-rank by relevance, not archive order
    const body = $('#arch-body'); body.innerHTML = '';
    if (!hits.length) { body.innerHTML = '<div class="empty"><p>No trace of that.</p></div>'; return; }
    for (const e of hits) body.appendChild(archTurn(e));
  }, 220);
});

// ---- reminders ----------------------------------------------------------------
async function loadReminders() {
  const list = await window.urfael.reminders() || [];
  const el = $('#rem-list'); el.innerHTML = '';
  if (!list.length) { el.innerHTML = '<p class="hint">Nothing scheduled. Set one above, or just ask Urfael.</p>'; return; }
  for (const r of list) {
    const d = document.createElement('div'); d.className = 'row';
    d.innerHTML = '<span class="when"></span><span class="grow"></span><span class="state"></span><button class="row-act small">Cancel</button>';
    d.querySelector('.when').textContent = (r.at || '').slice(0, 16).replace('T', ' ');
    d.querySelector('.grow').textContent = r.text;
    d.querySelector('.state').textContent = r.repeat ? (typeof r.repeat === 'string' ? r.repeat : 'every ' + r.repeat.everyMins + 'm') : '';
    d.querySelector('button').onclick = async () => { await window.urfael.reminderCancel(r.id); loadReminders(); };
    el.appendChild(d);
  }
}
// surface a rejected / unreachable reminder inline instead of letting it vanish (status node created lazily)
function showRemError(msg) {
  let err = $('#rem-err');
  if (!err) { err = document.createElement('p'); err.className = 'hint'; err.id = 'rem-err'; $('#rem-form').insertAdjacentElement('afterend', err); }
  err.textContent = msg; err.hidden = false;
}
$('#rem-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const spec = { text: $('#rem-text').value.trim(), inMins: Number($('#rem-mins').value || 0) };
  const rep = $('#rem-repeat').value; if (rep) spec.repeat = rep;
  if (!spec.text) return;
  const r = await window.urfael.remind(spec);   // inspect the daemon's result; a rejected reminder must not silently disappear
  if (r && r.id) { const err = $('#rem-err'); if (err) err.hidden = true; $('#rem-text').value = ''; $('#rem-mins').value = ''; loadReminders(); }
  else { showRemError((r && r.error) || 'Could not reach Urfael. Reminder not set.'); }   // keep typed values so the owner can fix and retry
});

// ---- jobs ----------------------------------------------------------------------
async function loadJobs() {
  const jobs = await window.urfael.jobs() || [];
  const el = $('#job-list'); el.innerHTML = ''; $('#job-log').hidden = true;
  if (!jobs.length) { el.innerHTML = '<p class="hint">No background work. Ask Urfael to research something “in the background”.</p>'; return; }
  for (const j of jobs.slice(0, 30)) {
    const d = document.createElement('div'); d.className = 'row';
    d.innerHTML = '<span class="when"></span><span class="grow"></span><span class="state"></span><button class="row-act small">Log</button><button class="row-act small">Cancel</button>';
    d.querySelector('.when').textContent = (j.createdAt || '').slice(5, 16).replace('T', ' ');
    d.querySelector('.grow').textContent = j.kind + '  ·  ' + j.id;
    const st = d.querySelector('.state'); st.textContent = j.state; st.classList.add(j.state);
    const [logBtn, cancelBtn] = d.querySelectorAll('button');
    logBtn.onclick = async () => { const full = await window.urfael.job(j.id); $('#job-log').textContent = (full && full.log) || '(no log)'; $('#job-log').hidden = false; };
    cancelBtn.onclick = async () => { await window.urfael.jobCancel(j.id); loadJobs(); };
    if (j.state !== 'running') cancelBtn.remove();
    el.appendChild(d);
  }
}

// ---- hearth ---------------------------------------------------------------------
let hearthTimer = null;
async function loadHearth() {
  const v = await window.urfael.vitals();
  const el = $('#hearth-grid'); el.innerHTML = '';
  if (!v) { el.innerHTML = '<p class="hint">The brain is asleep — send a message to wake it.</p>'; return; }
  const tok = v.tokToday >= 1000 ? Math.round(v.tokToday / 1000) + 'k' : (v.tokToday || 0);
  // costToday is an env-overridable ESTIMATE from the daemon (may be absent on an older daemon — show '—').
  const cost = (typeof v.costToday === 'number') ? '$' + v.costToday.toFixed(2) : '—';
  const cells = [['model', v.model], ['warm sessions', (v.warm || []).length], ['turns today', v.turnsToday],
    ['tokens today', tok], ['cost (est. today)', cost], ['avg latency', v.avgMs ? v.avgMs + 'ms' : '—'], ['memory commits', v.memCommits],
    ['uptime', v.uptimeS < 3600 ? Math.round(v.uptimeS / 60) + 'm' : Math.round(v.uptimeS / 3600) + 'h'], ['brain restarts', v.errors]];
  for (const [k, val] of cells) {
    const d = document.createElement('div'); d.className = 'vital';
    d.innerHTML = '<label></label><span></span>';
    d.querySelector('label').textContent = k.toUpperCase(); d.querySelector('span').textContent = val;
    el.appendChild(d);
  }
  loadLearn(); loadAudit();
  clearInterval(hearthTimer);
  hearthTimer = setInterval(() => { if (view === 'hearth') loadHearth(); else clearInterval(hearthTimer); }, 5000);
}
// the verify-before-trust learning ledger: trusted / proposed / retired, with confidence.
async function loadLearn() {
  const el = $('#learn-list'); const d = await window.urfael.learn().catch(() => null);
  const s = d && d.stats;
  if (!s || !s.total) { el.innerHTML = '<span class="empty">nothing learned yet</span>'; return; }
  const ord = { trusted: 0, proposed: 1, retired: 2 };
  const items = (d.items || []).slice().sort((a, b) => (ord[a.status] - ord[b.status]) || (b.confidence - a.confidence)).slice(0, 25);
  el.innerHTML = `<div class="ledger-head">${s.trusted} trusted · ${s.proposed} proposed · ${s.retired} retired · avg confidence ${s.avgConfidence}</div>`;
  for (const i of items) {
    const row = document.createElement('div'); row.className = 'ledger-row ' + i.status;
    const conf = i.status === 'retired' ? '' : Number(i.confidence || 0).toFixed(2);
    row.innerHTML = '<span class="lst"></span><span class="lcf"></span><span class="lrf"></span>';
    row.querySelector('.lst').textContent = i.status; row.querySelector('.lcf').textContent = conf;
    row.querySelector('.lrf').textContent = String(i.ref || '').slice(0, 100);
    el.appendChild(row);
  }
}
// the team-mode activity trail: who / when / channel / role / sandbox profile.
async function loadAudit() {
  const el = $('#audit-list'); const d = await window.urfael.audit().catch(() => null);
  const a = d && d.activity;
  if (!a || !a.length) { el.innerHTML = '<span class="empty">no remote (principal) activity yet</span>'; return; }
  el.innerHTML = '';
  for (const e of a.slice(0, 25)) {
    const row = document.createElement('div'); row.className = 'ledger-row';
    row.innerHTML = '<span class="lst"></span><span class="lcf"></span><span class="lrf"></span>';
    row.querySelector('.lst').textContent = e.channel || '?'; row.querySelector('.lcf').textContent = (e.t || '').slice(11, 16);
    row.querySelector('.lrf').textContent = (e.principal || '—') + '  ·  ' + (e.role || '') + ' / ' + (e.profile || '');
    el.appendChild(row);
  }
}
$('#distill').addEventListener('click', () => { window.urfael.conversationEnd(); $('#distill .label').textContent = 'Distilling…'; setTimeout(() => ($('#distill .label').textContent = 'Distill memory'), 2500); });

// ---- settings ---------------------------------------------------------------------
const SETTINGS = [
  ['URFAEL_THEME', 'Orb look', ['sigil', 'rune', 'ember', 'eye']],
  ['TTS_PROVIDER', 'Voice (TTS)', ['say', 'kokoro', 'elevenlabs']],
  ['SAY_VOICE', 'macOS voice', null],
  ['SAY_RATE', 'Speech rate (wpm)', null],
  ['URFAEL_ACKS', 'Spoken acknowledgments', ['1', '0']],
  ['WAKE_KEYWORD', 'Wake word (built-in)', null],
  ['WAKE_WORD_LABEL', 'Wake word label', null],
  ['WHISPER_MODEL', 'Whisper model', ['base.en', 'small.en', 'tiny.en']],
];
async function loadSettings() {
  const cfg = await window.urfael.config();
  const cur = { URFAEL_THEME: cfg.theme, TTS_PROVIDER: cfg.ttsProvider, SAY_VOICE: cfg.sayVoice, SAY_RATE: cfg.sayRate,
    URFAEL_ACKS: cfg.acks ? '1' : '0', WAKE_KEYWORD: cfg.wakeKeyword, WAKE_WORD_LABEL: cfg.wakeLabel, WHISPER_MODEL: cfg.whisperModel };
  const grid = $('#settings-grid'); grid.innerHTML = '';
  for (const [key, label, opts] of SETTINGS) {
    const l = document.createElement('label'); l.textContent = label; l.htmlFor = 's-' + key;
    let f;
    if (opts) {
      f = document.createElement('select');
      for (const o of opts) { const op = document.createElement('option'); op.value = o; op.textContent = o; f.appendChild(op); }
      f.value = opts.includes(String(cur[key])) ? String(cur[key]) : opts[0];
    } else { f = document.createElement('input'); f.type = 'text'; f.value = cur[key] || ''; }
    f.id = 's-' + key;
    f.addEventListener('change', () => window.urfael.setConfig(key, f.value));
    grid.append(l, f);
  }
}

// ---- multi-chat manager: open independent provider-bound chats, each its own tile (like new terminal windows) ----
let chatsInit = false;
function escC(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function renderHLC(text) { return escC(text).replace(/==([^=]+?)==/g, '<mark class="hl">$1</mark>'); } // gold key-point marker (escape first → XSS-safe)
async function initChats() {
  if (chatsInit) return; chatsInit = true;
  // populate the provider picker once (the subscription default is already in the markup)
  try { const d = await window.urfael.providers(); const sel = $('#c-provider');
    ((d && d.providers) || []).forEach((p) => { if (!p || !p.id) return; const o = document.createElement('option');
      o.value = p.id; o.textContent = (p.label || p.id) + (p.verified === false ? ' (needs key)' : ''); sel.appendChild(o); }); } catch {}
  $('#c-new').addEventListener('click', newChatC);
}
async function newChatC() {
  const b = $('#c-new'); b.disabled = true;
  try {
    const c = await window.urfael.chatOpen({ model: $('#c-model').value, providerId: $('#c-provider').value });
    if (c && c.chatId) addTileC(c); else alert('Could not open the chat' + (c && c.error ? ': ' + c.error : '') + '.');
  } catch {} finally { b.disabled = false; }
}
function addTileC(c) {
  const provLabel = c.providerId ? c.providerId : 'subscription';
  const tile = document.createElement('div'); tile.className = 'ctile';
  tile.innerHTML = '<div class="cth"><span class="cdot"></span>'
    + '<span class="ctt">' + escC(c.model || 'sonnet') + ' <span class="cpr">· ' + escC(provLabel) + '</span></span>'
    + '<button class="cbtn cmin" title="minimize">–</button><button class="cbtn cclose" title="close chat">✕</button></div>'
    + '<div class="cbody"></div>'
    + '<div class="cfoot"><input type="text" placeholder="message this chat…" autocomplete="off"><button>send</button></div>';
  $('#c-grid').appendChild(tile);
  const body = tile.querySelector('.cbody'), input = tile.querySelector('.cfoot input'),
        sendb = tile.querySelector('.cfoot button'), dot = tile.querySelector('.cdot');
  async function doSend() {
    const t = input.value.trim(); if (!t) return; input.value = '';
    const u = document.createElement('div'); u.className = 'cmsg u'; u.textContent = t; body.appendChild(u);
    const a = document.createElement('div'); a.className = 'cmsg a'; a.textContent = '…'; body.appendChild(a);
    body.scrollTop = body.scrollHeight; dot.className = 'cdot busy'; sendb.disabled = true; input.disabled = true;
    try { const r = await window.urfael.chatAsk(c.chatId, t); a.innerHTML = renderHLC((r && r.text) || '(no reply)'); }
    catch { a.textContent = '(error)'; }
    dot.className = 'cdot'; sendb.disabled = false; input.disabled = false; body.scrollTop = body.scrollHeight; input.focus();
  }
  sendb.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });
  tile.querySelector('.cmin').addEventListener('click', () => tile.classList.toggle('min'));
  tile.querySelector('.cclose').addEventListener('click', () => { try { window.urfael.chatClose(c.chatId); } catch {} tile.remove(); });
  input.focus();
}

// jump-to-latest appears whenever the reader is scrolled away from the live tail (NN/G)
const jump = $('#jump');
thread.addEventListener('scroll', () => { jump.hidden = nearBottom(); });
jump.addEventListener('click', () => { thread.scrollTop = thread.scrollHeight; jump.hidden = true; });
function wireSuggestions() { document.querySelectorAll('.sug').forEach((b) => { b.onclick = () => { input.value = b.textContent; send(); }; }); }
wireSuggestions();
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (Palette.isOpen()) return;                 // palette owns Escape while open
  if (asking) { e.preventDefault(); abort(); return; }   // abort the live turn before any blur
  document.activeElement?.blur?.();
});

// the empty-state node, captured before the first message removes it, so New conversation can restore it
const emptyHTML = $('#thread-empty') ? $('#thread-empty').outerHTML : '';
function newConversation() {
  if (asking) abort();
  thread.innerHTML = emptyHTML;
  wireSuggestions();
  liveMsg = null; liveText = ''; liveTools = [];
  show('converse'); input.focus();
}

// ---- command palette + menu ------------------------------------------------------
function focusArchiveSearch() { show('archive'); setTimeout(() => $('#arch-search').focus(), 0); }
function focusReminder() { show('reminders'); setTimeout(() => $('#rem-text').focus(), 0); }
function distillNow() { $('#distill').click(); }
Palette.init([
  { title: 'Converse', hint: '⌘1', run: () => show('converse') },
  { title: 'Archive', hint: '⌘2', run: () => show('archive') },
  { title: 'Reminders', hint: '⌘3', run: () => show('reminders') },
  { title: 'Jobs', hint: '⌘4', run: () => show('jobs') },
  { title: 'Hearth', hint: '⌘5', run: () => show('hearth') },
  { title: 'Settings', hint: '⌘6', run: () => show('settings') },
  { title: 'New conversation', hint: '⌘N', run: newConversation },
  { title: 'Search the archive…', run: focusArchiveSearch },
  { title: 'New reminder…', run: focusReminder },
  { title: 'Toggle spoken replies', run: toggleVoice },
  { title: 'Distill memory now', run: distillNow },
  { title: 'Stop generation', run: abort },
  { title: 'Quit Urfael', run: () => window.urfael.quit() },
]);

// menu bar / dock actions forwarded from main.js (preload may not expose onMenu yet — consume defensively)
if (window.urfael.onMenu) window.urfael.onMenu((a) => {
  if (typeof a !== 'string') return;
  if (a.startsWith('view:')) { const v = a.slice(5); if (VIEWS.includes(v)) show(v); }
  else if (a === 'new') newConversation();
  else if (a === 'settings') show('settings');
  else if (a === 'stop') abort();
  // 'toggle-orb' is owned by the main process / orb; nothing for the Console to do here
});

// ---- boot -----------------------------------------------------------------------
(async () => {
  const cfg = await window.urfael.config().catch(() => ({}));
  voiceOn = cfg.consoleVoice !== false;
  muteBtn.classList.toggle('off', !voiceOn);
})();
show('converse');
