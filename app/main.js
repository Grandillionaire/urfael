'use strict';
// Urfael overlay — thin client of the brain daemon (daemon.js). It owns the Urfael HUD
// window, the wake word, and audio config for the renderer; the brain (warm Claude sessions,
// routing, memory) lives in the always-on daemon and survives this window closing.
//
// Mk II UI: ONE large transparent, click-through, always-on-top window. The orb lives bottom-right;
// the HUD rail deploys to its left inside the SAME window (transparent windows can't be resized on
// macOS, so the window is always large and the lit content expands/collapses via CSS altitudes).
// Mouse events pass through everything except elements the renderer marks interactive.
const { app, BrowserWindow, globalShortcut, ipcMain, screen, session } = require('electron');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TTS_ENV = path.join(os.homedir(), '.claude', 'urfael', 'tts.env');
const SOCK = path.join(os.homedir(), '.claude', 'urfael', 'daemon.sock');
const DAEMON = path.join(__dirname, 'daemon.js');

let win = null;
let wakeWorker = null;
function forward(channel, p) { if (win && !win.isDestroyed()) win.webContents.send(channel, p); }
function targetDisplay() { return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); } // multi-display: follow the cursor's screen

// ---- brain daemon client ---------------------------------------------------
function healthCheck(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: SOCK, method: 'GET', path: '/health', timeout: timeoutMs }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}
function spawnDaemon() { try { const p = spawn(process.execPath, [DAEMON], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: 'ignore' }); p.unref(); } catch {} }
let ensuring = null;
function ensureDaemon() {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    if (await healthCheck()) return true;
    spawnDaemon();
    for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 400)); if (await healthCheck()) return true; }
    return false;
  })().finally(() => { ensuring = null; });
  return ensuring;
}
function askDaemon(text) {
  return new Promise(async (resolve) => {
    if (!(await ensureDaemon())) { resolve({ ok: false, text: '(brain offline)', model: '' }); return; }
    let done = false;
    const req = http.request({ socketPath: SOCK, method: 'POST', path: '/ask', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let e; try { e = JSON.parse(line); } catch { continue; }
          if (e.kind === 'thinking') { const { kind, ...p } = e; forward('urfael:thinking', p); }
          else if (e.kind === 'say') { const { kind, ...p } = e; forward('urfael:say', p); }
          else if (e.kind === 'done') { done = true; forward('urfael:done', { model: e.model, ms: e.ms, text: e.text }); resolve({ ok: true, text: e.text, model: e.model }); }
        }
      });
      res.on('end', () => { if (!done) resolve({ ok: true, text: '', model: '' }); });
    });
    req.on('error', () => { if (!done) resolve({ ok: false, text: '(brain unreachable)', model: '' }); });
    req.write(JSON.stringify({ text })); req.end();
  });
}
function daemonPost(p) { try { const req = http.request({ socketPath: SOCK, method: 'POST', path: p }, (res) => res.resume()); req.on('error', () => {}); req.end(); } catch {} }
function daemonGet(p) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: SOCK, method: 'GET', path: p, timeout: 1500 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); req.end();
  });
}

ipcMain.handle('urfael:ask', (_e, text) => askDaemon(text));
ipcMain.handle('urfael:vitals', () => daemonGet('/vitals'));
ipcMain.on('urfael:conversation-end', () => daemonPost('/conversation-end'));

// ---- click-through: pass mouse to apps below except over lit/interactive elements ----
ipcMain.on('urfael:interactive', (_e, on) => { if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!on, { forward: true }); });

// ---- full shutdown (brain daemon + overlay) --------------------------------
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.urfael.daemon.plist');
function shutdownAll() {
  daemonPost('/shutdown');
  try { spawn('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch {}
  if (wakeWorker) { try { wakeWorker.postMessage('stop'); } catch {} }
  stopWhisper();
  setTimeout(() => app.quit(), 450);
}
ipcMain.on('urfael:shutdown', shutdownAll);

// ---- look/theme ------------------------------------------------------------
const THEMES = ['sigil', 'rune', 'ember', 'eye'];
function setTtsEnvValue(key, val) {
  let lines = [];
  try { lines = fs.readFileSync(TTS_ENV, 'utf8').split('\n'); } catch {}
  let found = false;
  lines = lines.map((l) => { if (l.trim().startsWith(key + '=')) { found = true; return `${key}=${val}`; } return l; });
  if (!found) lines.push(`${key}=${val}`);
  try { fs.writeFileSync(TTS_ENV, lines.join('\n')); } catch {}
}
function cycleTheme() {
  const next = THEMES[(THEMES.indexOf(readTtsEnv().theme) + 1) % THEMES.length] || 'sigil';
  setTtsEnvValue('URFAEL_THEME', next); forward('urfael:theme', next);
}
ipcMain.on('urfael:set-theme', (_e, t) => { if (THEMES.includes(t)) { setTtsEnvValue('URFAEL_THEME', t); forward('urfael:theme', t); } });
ipcMain.on('urfael:hud', () => forward('urfael:hud-toggle')); // ⌘⇧H: renderer toggles expanded altitude

// ---- cursor gaze (eye/sigil look at the cursor) -----------------------------
function startGaze() {
  let lastX = 9, lastY = 9;
  setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    try {
      const c = screen.getCursorScreenPoint(); const b = win.getBounds();
      const ox = b.x + b.width - 210, oy = b.y + b.height - 240; // approx orb center (bottom-right)
      const x = Math.max(-1, Math.min(1, (c.x - ox) / 600)), y = Math.max(-1, Math.min(1, (c.y - oy) / 600));
      if (Math.abs(x - lastX) < 0.005 && Math.abs(y - lastY) < 0.005) return; // cursor still — no IPC churn
      lastX = x; lastY = y;
      forward('urfael:gaze', { x, y });
    } catch {}
  }, 60);
}

// ---- wake word -------------------------------------------------------------
function sendWake(p) { forward('urfael:wake', p); }
function startWake() {
  const cfg = readTtsEnv();
  if (!cfg.picovoiceKey) { sendWake({ noKey: true }); return; }
  try {
    wakeWorker = new Worker(path.join(__dirname, 'wake-worker.js'), { workerData: { accessKey: cfg.picovoiceKey, keyword: cfg.wakeKeyword, keywordPath: cfg.wakeKeywordPath, sensitivity: 0.55 } });
    wakeWorker.on('message', (m) => {
      if (m.type === 'wake') { if (win) { win.showInactive(); win.show(); } sendWake({ detected: true }); }
      else if (m.type === 'ready') sendWake({ ready: true });
      else if (m.type === 'error') sendWake({ error: m.message });
    });
    wakeWorker.on('error', (e) => sendWake({ error: String(e.message || e) }));
  } catch (e) { sendWake({ error: String(e.message || e) }); }
}
ipcMain.on('urfael:wake-pause', () => wakeWorker && wakeWorker.postMessage('pause'));
ipcMain.on('urfael:wake-done', () => wakeWorker && wakeWorker.postMessage('resume'));

// ---- window (one big transparent click-through HUD) ------------------------
function createWindow() {
  const { workArea } = targetDisplay();
  const W = Math.min(1180, workArea.width - 32), H = Math.min(780, workArea.height - 32);
  win = new BrowserWindow({
    width: W, height: H,
    x: workArea.x + workArea.width - W, y: workArea.y + workArea.height - H,
    frame: false, transparent: true, hasShadow: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true }); // click-through by default; renderer flips it over lit elements
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}
function toggle() {
  if (!win) return;
  if (win.isVisible()) { win.hide(); if (wakeWorker) wakeWorker.postMessage('pause'); }
  else { win.showInactive(); win.show(); win.webContents.send('urfael:shown'); if (wakeWorker) wakeWorker.postMessage('resume'); }
}

// ---- config for the renderer -----------------------------------------------
let ttsEnvCache = { mtime: -1, val: null }; // read per TTS/STT call — only re-parse when the file actually changed
function readTtsEnv() {
  let mtime = 0;
  try { mtime = fs.statSync(TTS_ENV).mtimeMs; } catch {}
  if (ttsEnvCache.val && ttsEnvCache.mtime === mtime) return ttsEnvCache.val;
  const cfg = {};
  try {
    for (const line of fs.readFileSync(TTS_ENV, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      cfg[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  } catch {}
  const out = {
    ttsProvider: (cfg.TTS_PROVIDER || 'say').toLowerCase(),       // say (default, local) | kokoro | elevenlabs
    sttProvider: (cfg.STT_PROVIDER || 'whispercpp').toLowerCase(), // whispercpp (default, local) | elevenlabs
    sayVoice: cfg.SAY_VOICE || '',
    sayRate: cfg.SAY_RATE || '190',
    whisperModel: cfg.WHISPER_MODEL || 'base.en',
    sttPort: cfg.STT_PORT || '8462',
    kokoroUrl: cfg.KOKORO_URL || 'http://localhost:8880/v1/audio/speech',
    kokoroVoice: cfg.KOKORO_VOICE || 'bm_george',
    // optional paid ElevenLabs
    apiKey: cfg.ELEVENLABS_API_KEY || '',
    voiceId: cfg.TTS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb',          // a premade ElevenLabs voice (no gender drift)
    model: cfg.ELEVENLABS_TTS_MODEL || 'eleven_turbo_v2_5',
    speed: parseFloat(cfg.ELEVENLABS_SPEED || '1.0'),
    picovoiceKey: cfg.PICOVOICE_ACCESS_KEY || '',
    wakeKeyword: cfg.WAKE_KEYWORD || 'Computer',                  // any Porcupine builtin
    wakeKeywordPath: cfg.WAKE_KEYWORD_PATH || '',                 // custom .ppn (train "Urfael" free at console.picovoice.ai)
    wakeLabel: cfg.WAKE_WORD_LABEL || (cfg.WAKE_KEYWORD_PATH ? 'Urfael' : (cfg.WAKE_KEYWORD || 'Computer')),
    theme: cfg.URFAEL_THEME || 'sigil',
    acks: cfg.URFAEL_ACKS !== '0',   // instant spoken acknowledgments while thinking (default on)
  };
  ttsEnvCache = { mtime, val: out };
  return out;
}
ipcMain.handle('urfael:config', () => readTtsEnv());

// ---- local voice (API-free): TTS via `say`/Kokoro, STT via a warm whisper-server ----
const voice = require('./voice');
ipcMain.handle('urfael:tts', async (_e, text) => { const b = await voice.synth(text, readTtsEnv()); return b; });        // returns mp3 bytes
ipcMain.handle('urfael:stt', async (_e, buf) => voice.transcribe(Buffer.from(buf), readTtsEnv()));                       // returns transcript text

let whisperProc = null, whisperStopped = false, whisperRestarts = 0;
function whisperBin() { for (const p of ['/opt/homebrew/bin/whisper-server', '/usr/local/bin/whisper-server']) { try { fs.accessSync(p); return p; } catch {} } return 'whisper-server'; }
function startWhisper() {
  const cfg = readTtsEnv();
  if (cfg.sttProvider !== 'whispercpp') return;                                  // only the local-STT path needs the server
  const model = path.join(os.homedir(), '.claude', 'urfael', 'models', `ggml-${cfg.whisperModel}.bin`);
  if (!fs.existsSync(model)) { forward('urfael:wake', { error: 'Local STT model missing — run install.sh (downloads whisper)' }); return; }
  whisperStopped = false;
  try {
    const spawnedAt = Date.now();
    whisperProc = spawn(whisperBin(), ['--model', model, '--host', '127.0.0.1', '--port', String(cfg.sttPort), '--language', 'en', '--no-timestamps'],
      { stdio: 'ignore' });
    whisperProc.on('exit', () => {                                               // supervised: auto-respawn with backoff so a crash never leaves Urfael deaf
      whisperProc = null;
      if (whisperStopped) return;
      if (Date.now() - spawnedAt > 60000) whisperRestarts = 0;                   // it ran fine for a while — reset the backoff
      const delay = Math.min(30000, 1000 * 2 ** whisperRestarts++);
      setTimeout(() => { if (!whisperProc && !whisperStopped) startWhisper(); }, delay);
    });
  } catch { /* binary missing → voice.transcribe throws a clear install message */ }
}
function stopWhisper() { whisperStopped = true; try { whisperProc && whisperProc.kill(); } catch {} whisperProc = null; }

// ---- lifecycle -------------------------------------------------------------
if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => { if (win) { win.show(); } });

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  createWindow();
  globalShortcut.register('CommandOrControl+Shift+U', toggle);
  globalShortcut.register('CommandOrControl+Shift+T', cycleTheme);
  globalShortcut.register('CommandOrControl+Shift+H', () => forward('urfael:hud-toggle'));
  globalShortcut.register('CommandOrControl+Shift+Q', shutdownAll);
  win.once('ready-to-show', () => { win.showInactive(); win.show(); });
  ensureDaemon();
  startWhisper();   // warm local STT (no-op unless STT_PROVIDER=whispercpp)
  startWake();
  startGaze();
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); stopWhisper(); try { wakeWorker && wakeWorker.postMessage('stop'); } catch {} }); // daemon (brain) intentionally keeps running
app.on('window-all-closed', () => app.quit());
ipcMain.on('urfael:hide', () => win && win.hide());
ipcMain.on('urfael:quit', () => app.quit());
