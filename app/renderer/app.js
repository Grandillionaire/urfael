'use strict';
// Urfael Mk II overlay. Voice: idle until "Urfael"/tap → conversation (listen→answer→listen),
// streaming TTS, barge-in. HUD: an altitude-based Urfael console that deploys on activity,
// shows live reasoning/response/vitals, and retracts when idle.

const EL = { base: 'https://api.elevenlabs.io/v1' };
let cfg = { apiKey: '', voiceId: '', model: 'eleven_flash_v2_5' };
const wakeLabel = () => cfg.wakeLabel || 'Computer';

const canvas = document.getElementById('orb');
const caption = document.getElementById('caption');
const orb = new UrfaelOrb(canvas);

let ctx, analyser, micAnalyser, td;
let micStream = null, micSource = null, recorder = null, chunks = [];
let state = 'idle';
let convo = false, loopRunning = false, manualRec = false, handsFree = false;
let recording = false, speechAt = 0, lastVoice = 0, bargeFrames = 0;
let liveTurn = 0, mutedTurn = -1, audioQ = [], pendingFetches = 0, playing = false, curSource = null, streamEnded = false;
let finished = false, finishTimer = null;

const START_RMS = 0.05, KEEP_RMS = 0.03, SILENCE_MS = 700, MAX_MS = 12000;  // 700ms end-of-speech (was 850) — snappier without clipping
const BARGE_RMS = 0.085, BARGE_FRAMES = 10;

// Robust to both aliases ('sonnet'/'opus') and full ids ('claude-opus-4-8') so the HUD label
// keeps working whatever the daemon reports.
const isOpus = (m) => /opus/i.test(m || '');
const modelLabel = (m) => isOpus(m) ? 'Opus' : /sonnet/i.test(m || '') ? 'Sonnet' : /haiku/i.test(m || '') ? 'Haiku' : '';
const TOOL_LABEL = (n) => {
  n = (n || '').toLowerCase();
  if (n.includes('event') || n.includes('calendar')) return 'Checking your calendar';
  if (n.includes('thread') || n.includes('mail') || n.includes('draft') || n.includes('label')) return 'Checking your email';
  if (n.includes('search') || n.includes('vault') || n.includes('read') || n.includes('list') || n.includes('document')) return 'Searching your notes';
  if (n.includes('write') || n.includes('append') || n.includes('patch') || n.includes('create')) return 'Writing to your vault';
  if (n.includes('navigate') || n.includes('browser') || n.includes('page') || n.includes('click')) return 'Browsing the web';
  if (n.includes('drive') || n.includes('file')) return 'Looking in Drive';
  if (n.includes('applescript') || n.includes('macos') || n.includes('automator')) return 'Operating the desktop';
  return 'Using ' + n;
};

function setState(s, text) {
  state = s;
  orb.setState(s === 'capturing' ? 'listening' : s);
  const capLbl = manualRec ? 'Recording… tap to send' : 'Listening… (tap to stop)';
  const lbl = { idle: convo ? 'Tap to talk…' : `Tap or say “${wakeLabel()}”…`, capturing: capLbl, thinking: 'Thinking…', speaking: '' };
  caption.textContent = text != null ? text : (lbl[s] || '');
  caption.classList.toggle('dim', s === 'idle' && !convo);
  wakeActivity();   // any state change is activity: revive from dormancy + restart the idle countdown
}

// ---- graduated dormancy: in use -> (idle) dim -> minimized to the corner; hover-dwell to revive --------------
// What a user needs: when they are working, the orb is out of the way (fades, shrinks into the corner) so it never
// fights the browsing experience; bringing it back is a deliberate, satisfying hover, not an accidental twitch.
let dormTimer = null, dwellTimer = null;
const IDLE_DIM_MS = 12000;          // after this idle, the orb fades back so it stops competing for attention
const IDLE_MIN_MS = 32000;          // after this, it shrinks and tucks into the corner (a quiet ember)
const REVIVE_DWELL_MS = 480;        // hover this long over it to wake it (short enough to feel alive, long enough not to fire by accident)
function busyNow() { return convo || recording || state === 'thinking' || state === 'speaking'; }
function wakeActivity() {
  document.body.classList.remove('dorm-dim', 'dorm-min');
  if (dormTimer) clearTimeout(dormTimer);
  if (busyNow()) return;            // never go dormant mid-conversation / mid-answer
  dormTimer = setTimeout(() => {
    if (busyNow()) return;
    document.body.classList.add('dorm-dim');
    dormTimer = setTimeout(() => { if (!busyNow()) document.body.classList.add('dorm-min'); }, IDLE_MIN_MS - IDLE_DIM_MS);
  }, IDLE_DIM_MS);
}

function ensureAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = ctx.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.7;
  micAnalyser = ctx.createAnalyser(); micAnalyser.fftSize = 512; micAnalyser.smoothingTimeConstant = 0.5;
  td = new Uint8Array(micAnalyser.fftSize);
  orb.attach(analyser);
  warmAcks();
}

// ---- instant acknowledgments — Urfael answers the moment you stop talking ----
// Short phrases pre-synthesized once (cached AudioBuffers), played only if the real reply hasn't
// started speaking within ACK_AFTER_MS — so fast turns aren't slowed down, slow ones aren't silent.
const ACK_PHRASES = ['On it, sir.', 'Right away, sir.', 'Working on it.', 'One moment.', 'Let me look into that.'];
const ACK_AFTER_MS = 1200;
let ackBuffers = [], acksWarmed = false, lastAck = -1;
async function warmAcks() {
  if (acksWarmed || cfg.acks === false || (cfg.ttsProvider === 'elevenlabs' && !cfg.apiKey)) return;
  acksWarmed = true;
  for (const p of ACK_PHRASES) { try { const a = await synthOne(p); if (a) ackBuffers.push(a); } catch {} }
}
async function synthOne(text) { // one-shot synth → decoded AudioBuffer (no turn continuity)
  let bytes;
  if (cfg.ttsProvider === 'elevenlabs') {
    const r = await fetch(`${EL.base}/text-to-speech/${cfg.voiceId}`, {
      method: 'POST', headers: { 'xi-api-key': cfg.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: cfg.model, voice_settings: { stability: 0.85, similarity_boost: 0.9, style: 0.0, use_speaker_boost: true, speed: cfg.speed || 1.0 } }),
    });
    if (!r.ok) return null;
    bytes = await r.arrayBuffer();
  } else {
    const u8 = await window.urfael.tts(text);
    bytes = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }
  return ctx.decodeAudioData(bytes);
}
function scheduleAck() {
  setTimeout(() => { if (state === 'thinking' && !playing && !audioQ.length) playAck(); }, ACK_AFTER_MS);
}
function playAck() {
  if (playing || audioQ.length || !ackBuffers.length) return;
  let i = Math.floor(Math.random() * ackBuffers.length);
  if (ackBuffers.length > 1 && i === lastAck) i = (i + 1) % ackBuffers.length; // don't repeat back-to-back
  lastAck = i;
  playing = true; setState('speaking');
  curSource = ctx.createBufferSource();
  curSource.buffer = ackBuffers[i]; curSource.connect(analyser); curSource.connect(ctx.destination);
  curSource.onended = () => { curSource = null; playing = false; if (!audioQ.length && !streamEnded) setState('thinking', 'Thinking…'); playNext(); };
  curSource.start();
}
function rms() {
  micAnalyser.getByteTimeDomainData(td);
  let s = 0; for (let i = 0; i < td.length; i++) { const v = (td[i] - 128) / 128; s += v * v; }
  return Math.sqrt(s / td.length);
}

// ============================ HUD ============================
const reasonEl = document.getElementById('reason');
const responseEl = document.getElementById('response');
const chipsEl = document.getElementById('chips');
let altitude = 'idle', collapseTimer = null, toolCount = 0, respText = '';

function setAltitude(a) {
  if (a === altitude) return;
  altitude = a;
  document.body.className = 'state-' + a;
}
function escalate(a) { // never downgrade within a turn; idle<active<expanded
  const rank = { idle: 0, active: 1, expanded: 2 };
  if (rank[a] > rank[altitude]) setAltitude(a);
}
function scheduleCollapse() {
  if (collapseTimer) clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => { if (!convo && state !== 'thinking' && state !== 'speaking') setAltitude('idle'); }, 6000);
}
function resolvePendingRows() { reasonEl.querySelectorAll('.row:not(.done):not(.model)').forEach((r) => { r.classList.add('done'); r.querySelector('.mk').textContent = '✓'; }); }
function reasonRow(text, cls) {
  const d = document.createElement('div'); d.className = 'row' + (cls ? ' ' + cls : '');
  const m = document.createElement('span'); m.className = 'mk'; m.textContent = cls === 'model' ? '▸' : '⟳';
  d.appendChild(m); d.appendChild(document.createTextNode(text));
  reasonEl.appendChild(d);
  while (reasonEl.children.length > 40) reasonEl.removeChild(reasonEl.firstChild);
  reasonEl.scrollTop = reasonEl.scrollHeight;
}

window.urfael.onThinking((p) => {
  if (p.reset) {
    liveTurn = p.turnId; mutedTurn = -1; toolCount = 0; respText = '';
    reasonEl.innerHTML = ''; responseEl.textContent = ''; chipsEl.innerHTML = '';
    reasonRow((modelLabel(p.model) || 'Urfael') + ' engaged', 'model');
    escalate(isOpus(p.model) ? 'expanded' : 'active');
    refreshVitals();
  } else if (p.tool) {
    resolvePendingRows(); reasonRow(TOOL_LABEL(p.tool)); spawnMotes(6);
    if (++toolCount >= 2) escalate('expanded');
  } else if (p.delta) {
    respText += p.delta;
    if (!renderQueued) { renderQueued = true; requestAnimationFrame(renderResponse); } // batch: one DOM update per frame, not per token
  }
});
let renderQueued = false;
function renderResponse() {
  renderQueued = false;
  const shown = answerForScreen(respText).slice(-1400);
  responseEl.innerHTML = '';
  responseEl.appendChild(document.createTextNode(shown));
  const c = document.createElement('span'); c.className = 'cursor'; c.textContent = '▋'; responseEl.appendChild(c);
  responseEl.scrollTop = responseEl.scrollHeight;
}
// show only the WRITTEN answer on screen — strip the [SPOKEN] comment (that part is voiced, not read)
function answerForScreen(t) {
  const i = t.search(/\[\/SPOKEN\]/i);
  if (i >= 0) return t.slice(i).replace(/\[\/?SPOKEN\]/gi, '').trim();
  if (/\[SPOKEN\]/i.test(t)) return '';                 // comment still streaming, answer not started
  return t.replace(/\[\/?SPOKEN\]/gi, '').trim();        // no tags (fallback) → show all
}
window.urfael.onDone((p) => {
  if (p && p.aborted) { resolvePendingRows(); scheduleCollapse(); return; } // barge/stop: don't paint '(stopped)' over the panel
  resolvePendingRows();
  const full = answerForScreen((p && p.text) || respText);
  responseEl.textContent = full.slice(0, 1400);
  renderChips(full);
  refreshVitals();
  scheduleCollapse();
});

// extract clickable github/vault references from the answer
function renderChips(text) {
  chipsEl.innerHTML = '';
  const seen = new Set();
  const add = (label, q) => { if (seen.has(label)) return; seen.add(label); const c = document.createElement('span'); c.className = 'chip hot'; c.textContent = label; c.onclick = () => { ensureAudio(); setState('thinking'); submitAsk(q); }; chipsEl.appendChild(c); };
  (text.match(/[\w.-]+\/[\w.-]+(?=\s|$|[),.])/g) || []).filter((s) => s.includes('/') && !s.includes('//')).slice(0, 3).forEach((r) => add('⌥ ' + r, 'Tell me about the GitHub repo ' + r));
  (text.match(/\b[\w-]+\.md\b/g) || []).slice(0, 2).forEach((f) => add('▤ ' + f, 'Open ' + f + ' and summarize it'));
}

// vitals (real data from the daemon)
async function refreshVitals() {
  let v; try { v = await window.urfael.vitals(); } catch { v = null; }
  if (!v) return;
  const set = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  const mEl = document.getElementById('v-model');
  if (mEl) { mEl.textContent = modelLabel(v.model) || '—'; mEl.classList.toggle('opus', isOpus(v.model)); }
  set('v-warm', (v.warm || []).length); set('v-lat', v.avgMs ? v.avgMs + 'ms' : '—');
  set('v-turns', v.turnsToday); set('v-mem', v.memCommits);
  set('v-tok', v.tokToday != null ? (v.tokToday < 1000 ? v.tokToday : Math.round(v.tokToday / 1000) + 'k') : '—');
  set('v-up', v.uptimeS != null ? (v.uptimeS < 3600 ? Math.round(v.uptimeS / 60) + 'm' : Math.round(v.uptimeS / 3600) + 'h') : '—');
}
setInterval(() => { if (altitude !== 'idle') refreshVitals(); }, 5000);

// particle motes — streak toward the orb when a tool fires
const pcanvas = document.getElementById('particles'); const pctx = pcanvas.getContext('2d');
let motes = [];
function resizeParticles() { pcanvas.width = window.innerWidth; pcanvas.height = window.innerHeight; }
window.addEventListener('resize', resizeParticles); resizeParticles();
function orbCenter() { return { x: window.innerWidth - 198, y: window.innerHeight - 248 }; }
function spawnMotes(n) {
  const o = orbCenter();
  for (let i = 0; i < n; i++) {
    const edge = Math.floor(Math.random() * 3);
    const sx = edge === 0 ? Math.random() * window.innerWidth : (edge === 1 ? 0 : window.innerWidth);
    const sy = edge === 0 ? 0 : Math.random() * window.innerHeight;
    motes.push({ x: sx, y: sy, tx: o.x, ty: o.y, life: 1 });
  }
}
function drawParticles() {
  pctx.clearRect(0, 0, pcanvas.width, pcanvas.height);
  pctx.globalCompositeOperation = 'lighter';
  motes = motes.filter((m) => m.life > 0);
  for (const m of motes) {
    m.x += (m.tx - m.x) * 0.06; m.y += (m.ty - m.y) * 0.06; m.life -= 0.012;
    const d = Math.hypot(m.tx - m.x, m.ty - m.y);
    pctx.strokeStyle = `rgba(224,176,98,${Math.min(0.6, m.life)})`; pctx.lineWidth = 1.6;
    pctx.beginPath(); pctx.moveTo(m.x, m.y); pctx.lineTo(m.x + (m.tx - m.x) * 0.08, m.y + (m.ty - m.y) * 0.08); pctx.stroke();
    if (d < 14) m.life = 0;
  }
  pctx.globalCompositeOperation = 'source-over';
  requestAnimationFrame(drawParticles);
}
drawParticles();

// click-through except over lit/interactive elements (window is ignoreMouseEvents:true by default)
let interactiveNow = false;
const HOT = '#orb, #close, .chip, #rail, #dock, #cmdline';
window.addEventListener('mousemove', (e) => {
  const over = !!(e.target.closest && e.target.closest(HOT));
  if (over !== interactiveNow) { interactiveNow = over; window.urfael.setInteractive(over); }
  // hover-dwell to revive from dormancy: a deliberate hover wakes it, a passing cursor does not.
  const dorm = document.body.classList.contains('dorm-dim') || document.body.classList.contains('dorm-min');
  const overOrb = !!(e.target.closest && e.target.closest('#orbwrap'));
  if (dorm && overOrb) { if (!dwellTimer) dwellTimer = setTimeout(() => { dwellTimer = null; wakeActivity(); }, REVIVE_DWELL_MS); }
  else if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null; }
});

// dock launcher chips — set these to your own projects/areas (tap a chip → "Brief me on <name>")
const PROJECTS = ['work', 'personal', 'research', 'health', 'finances', 'ideas'];
const dock = document.getElementById('dock');
PROJECTS.forEach((p) => { const c = document.createElement('span'); c.className = 'chip hot'; c.textContent = p; c.onclick = () => { ensureAudio(); setState('thinking'); submitAsk('Brief me on ' + p); }; dock.appendChild(c); });

window.urfael.onHudToggle(() => setAltitude(altitude === 'expanded' ? 'idle' : 'expanded'));

// ============================ voice (preserved) ============================
window.urfael.onSay((p) => {
  if (p.text) enqueueSay(p.text, p.turnId);
  else if (p.end && p.turnId === liveTurn && p.turnId !== mutedTurn) { streamEnded = true; maybeFinish(); }
});
// Sentence chunks now stream in from the daemon and are synthesized CONCURRENTLY, so audio can
// finish out of order. A per-turn sequence pipeline re-orders before playback: each chunk takes a
// seq, lands in readyAudio when synthesized (null on failure, so a failed chunk never stalls the
// rest), and drainReady releases them to audioQ strictly in seq order.
let sayTurn = -1, prevSpoken = '', saySeq = 0, nextPlaySeq = 1;
const readyAudio = new Map();
function resetSayPipeline(turnId) { sayTurn = turnId; prevSpoken = ''; saySeq = 0; nextPlaySeq = 1; readyAudio.clear(); }
function drainReady(turnId) {
  while (readyAudio.has(nextPlaySeq)) {
    const audio = readyAudio.get(nextPlaySeq); readyAudio.delete(nextPlaySeq); nextPlaySeq++;
    if (audio && turnId === liveTurn && turnId !== mutedTurn) audioQ.push({ turnId, audio });
  }
  if (!playing) playNext();
}
async function enqueueSay(text, turnId) {
  if (turnId !== liveTurn || turnId === mutedTurn) return;
  const spoken = cleanForSpeech(text);
  if ((cfg.ttsProvider === 'elevenlabs' && !cfg.apiKey) || !spoken) return;   // only EL needs a key; local needs nothing
  if (turnId !== sayTurn) resetSayPipeline(turnId);
  const seq = ++saySeq;
  pendingFetches++;
  let audio = null;
  try {
    let audioBytes; // raw audio (ArrayBuffer) for decodeAudioData — same playback path = orb stays reactive
    if (cfg.ttsProvider === 'elevenlabs') {
      const myPrev = prevSpoken.slice(-600); prevSpoken += (prevSpoken ? ' ' : '') + spoken;
      const r = await fetch(`${EL.base}/text-to-speech/${cfg.voiceId}?optimize_streaming_latency=3`, {
        method: 'POST', headers: { 'xi-api-key': cfg.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: spoken, model_id: cfg.model, previous_text: myPrev || undefined, voice_settings: { stability: 0.85, similarity_boost: 0.9, style: 0.0, use_speaker_boost: true, speed: cfg.speed || 1.0 } }),
      });
      if (!r.ok) { caption.textContent = `Voice error (${r.status})`; }
      else audioBytes = await r.arrayBuffer();
    } else {
      // LOCAL (say / kokoro): main process synthesizes and returns mp3 bytes
      const u8 = await window.urfael.tts(spoken);                  // Uint8Array over IPC
      audioBytes = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    }
    if (audioBytes) audio = await ctx.decodeAudioData(audioBytes);
  } catch (e) { caption.textContent = (e && e.message ? e.message : 'Voice unavailable'); }
  readyAudio.set(seq, audio);
  pendingFetches--;
  drainReady(turnId);
}
function playNext() {
  if (!audioQ.length) { playing = false; maybeFinish(); return; }
  const item = audioQ.shift();
  if (item.turnId === mutedTurn) return playNext();
  playing = true;
  if (state !== 'speaking') setState('speaking');
  curSource = ctx.createBufferSource();
  curSource.buffer = item.audio; curSource.connect(analyser); curSource.connect(ctx.destination);
  curSource.onended = () => { curSource = null; playNext(); };
  curSource.start();
}
function maybeFinish() { if (!playing && !audioQ.length && streamEnded && pendingFetches === 0) finishSpeaking(); }
function finishSpeaking() {
  if (finished) return; finished = true;
  streamEnded = false;
  if (finishTimer) clearTimeout(finishTimer);
  finishTimer = setTimeout(() => {
    if (convo && handsFree) beginListening();                       // wake-word mode: auto-listen for the next turn
    else if (convo) setState('idle', 'Tap to talk…');               // manual mode: mic stays warm, wait for the next tap
    else { window.urfael.wakeDone(); setState('idle'); scheduleCollapse(); }
  }, 250);
}
function stopPlayback() {
  if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
  finished = true;
  if (curSource) { try { curSource.onended = null; curSource.stop(); } catch {} curSource = null; }
  audioQ = []; playing = false; streamEnded = false; pendingFetches = 0;
}
function beginListening() { if (!convo) return; if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; } setState('capturing'); recording = false; bargeFrames = 0; if (!loopRunning) { loopRunning = true; convoLoop(); } }
function convoLoop() {
  if (!convo) { loopRunning = false; return; }
  const lvl = rms(), now = performance.now();
  if (state === 'capturing' && !manualRec) {   // VAD auto start/stop is for the hands-free wake-word path only
    if (!recording) { if (lvl > START_RMS) startRec(now); }
    else { if (lvl > KEEP_RMS) lastVoice = now; if (now - speechAt > MAX_MS || now - lastVoice > SILENCE_MS) stopRec(); }
  } else if (state === 'speaking') {
    if (lvl > BARGE_RMS) { if (++bargeFrames >= BARGE_FRAMES) barge(); } else bargeFrames = 0;
  }
  requestAnimationFrame(convoLoop);
}
function barge() { mutedTurn = liveTurn; if (window.urfael.abort) window.urfael.abort(); stopPlayback(); beginListening(); }
function startRec(now) {
  chunks = []; recorder = new MediaRecorder(micStream, { mimeType: 'audio/webm' });
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => handleUtterance();
  recorder.start();
  recording = true; speechAt = now; lastVoice = now;
}
function stopRec() { recording = false; if (recorder && recorder.state !== 'inactive') recorder.stop(); }
async function handleUtterance() {
  manualRec = false;
  setState('thinking', 'Transcribing…');
  const said = await transcribe(new Blob(chunks, { type: 'audio/webm' }));
  const clean = (said || '').replace(/[\(\[][^)\]]*[\)\]]/g, '').trim();
  if (!clean || clean.length < 2) return convo ? beginListening() : resetIdle('');
  scheduleAck();
  submitAsk(clean);
}
// one ask path for voice, typed input, and dock chips — same finish/safety semantics everywhere
function submitAsk(text) {
  finished = false; streamEnded = false; audioQ = []; pendingFetches = 0;
  window.urfael.ask(text)
    .then(() => { setTimeout(() => { if (!finished && !playing && !audioQ.length && pendingFetches === 0) finishSpeaking(); }, 60); })
    .catch(() => finishSpeaking());
}
// typed input: Enter sends; the reply renders and speaks exactly like a voice turn
const cmdline = document.getElementById('cmdline');
cmdline.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const text = cmdline.value.trim();
  if (!text) return;
  cmdline.value = '';
  ensureAudio(); escalate('active');
  if (state !== 'capturing') setState('thinking');
  submitAsk(text);
});
window.urfael.onWake(async (p) => {
  if (p.detected) { wakeActivity(); const ok = await enterConversation(); if (ok !== false) { manualRec = false; handsFree = true; beginListening(); } }   // wake word: hands-free VAD
  else if (p.ready) setState('idle', `Tap or say “${wakeLabel()}”…`);
  else if (p.noKey) setState('idle', 'Tap to talk');
  else if (p.error) setState('idle', 'Tap to talk');
});
// PRESS TO TALK (deterministic): tap to record, tap again to send + process. No guessing when you are done; you
// decide. A long-press (or Escape while recording) cancels without sending, so an accidental tap costs nothing.
let tapDownAt = 0;
async function orbTap() {
  ensureAudio(); wakeActivity();
  if (recording) { manualRec = false; stopRec(); return; }          // second tap: stop + process what you said
  if (!convo) { const ok = await enterConversation(); if (ok === false) return; }   // first tap: open the mic
  manualStart();                                                    // then record continuously until the next tap
}
function manualStart() {
  if (!micStream || recording) return;
  manualRec = true; handsFree = false; if (finishTimer) { clearTimeout(finishTimer); finishTimer = null; }
  setState('capturing'); startRec(performance.now());
  if (!loopRunning) { loopRunning = true; convoLoop(); }   // keep the loop alive for barge-in during the answer
}
function cancelRec() {   // discard the current recording without sending it
  if (!recording) return;
  manualRec = false; if (recorder) recorder.onstop = null;
  try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch {}
  recording = false; chunks = [];
  if (convo) beginListening(); else resetIdle('');
}
canvas.addEventListener('mousedown', () => { tapDownAt = performance.now(); });
canvas.addEventListener('mouseup', () => {
  const held = performance.now() - tapDownAt;
  if (recording && held > 600) { cancelRec(); return; }   // long-press while recording = cancel
  orbTap();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (recording) cancelRec(); else window.urfael.hide(); } });
window.urfael.onShown(() => ensureAudio());
async function enterConversation() {
  if (convo) return true;
  convo = true; escalate('active'); window.urfael.wakePause(); ensureAudio();
  try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch { convo = false; resetIdle('Mic blocked — enable it in System Settings'); return false; }
  micSource = ctx.createMediaStreamSource(micStream);
  micSource.connect(micAnalyser); micSource.connect(analyser);
  return true;
}
function releaseMic() {
  if (micSource) { try { micSource.disconnect(); } catch {} micSource = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
}
function resetIdle(msg) { convo = false; manualRec = false; handsFree = false; stopPlayback(); releaseMic(); window.urfael.wakeDone(); setState('idle', msg); scheduleCollapse(); }
function endConversation() {
  convo = false; recording = false; manualRec = false; handsFree = false; if (window.urfael.abort) window.urfael.abort(); stopPlayback();
  if (recorder && recorder.state !== 'inactive') { try { recorder.onstop = null; recorder.stop(); } catch {} }
  releaseMic(); window.urfael.wakeDone(); window.urfael.conversationEnd();
  setState('idle', `Stopped — say “${wakeLabel()}”`); scheduleCollapse();
}
async function transcribe(blob) {
  if (cfg.sttProvider !== 'elevenlabs') {
    // LOCAL whisper.cpp: main process transcribes the recorded audio
    try { return (await window.urfael.stt(await blob.arrayBuffer())) || ''; }
    catch (e) { caption.textContent = (e && e.message) ? e.message : 'Local STT unavailable'; return ''; }
  }
  if (!cfg.apiKey) { resetIdle('No ElevenLabs key'); return ''; }
  const form = new FormData();
  form.append('file', blob, 'speech.webm'); form.append('model_id', 'scribe_v1'); form.append('tag_audio_events', 'false');
  try {
    const r = await fetch(`${EL.base}/speech-to-text`, { method: 'POST', headers: { 'xi-api-key': cfg.apiKey }, body: form });
    if (!r.ok) { caption.textContent = `Speech-to-text error (${r.status})`; return ''; }
    return ((await r.json()).text || '').trim();
  } catch { return ''; }
}
function cleanForSpeech(t) {
  return t.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
          .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, ' ')
          .replace(/[#>*_~|`\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

window.urfael.onTheme((t) => orb.setTheme(t));
window.urfael.onGaze((g) => orb.setGaze(g));
document.getElementById('close').addEventListener('click', (e) => { e.stopPropagation(); window.urfael.shutdown(); });

// boot sequence then idle
(async () => {
  cfg = await window.urfael.config();
  orb.setTheme(cfg.theme || 'sigil');
  orb.start();
  const boot = document.getElementById('boot'), bl = document.getElementById('bootline');
  const seq = ['WAKING', 'READING THE ARCHIVE', 'AT YOUR SERVICE'];
  let i = 0; const iv = setInterval(() => { i++; if (bl && seq[i]) bl.textContent = seq[i]; }, 480);
  setTimeout(() => { clearInterval(iv); if (boot) boot.classList.add('gone'); setState('idle', `Say “${wakeLabel()}”…`); refreshVitals(); }, 1500);
})();
