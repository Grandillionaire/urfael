'use strict';
// Urfael overlay — thin client of the brain daemon (daemon.js). It owns the Urfael HUD
// window, the wake word, and audio config for the renderer; the brain (warm Claude sessions,
// routing, memory) lives in the always-on daemon and survives this window closing.
//
// Mk II UI: ONE large transparent, click-through, always-on-top window. The orb lives bottom-right;
// the HUD rail deploys to its left inside the SAME window (transparent windows can't be resized on
// macOS, so the window is always large and the lit content expands/collapses via CSS altitudes).
// Mouse events pass through everything except elements the renderer marks interactive.
const { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, session, Tray } = require('electron');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const JDIR = path.join(os.homedir(), '.claude', 'urfael');
const TTS_ENV = path.join(JDIR, 'tts.env');
const SOCK = path.join(JDIR, 'daemon.sock');
const ONBOARDED = path.join(JDIR, 'onboarded'); // marker: first-run GUI onboarding done (shown once)
const DAEMON = path.join(__dirname, 'daemon.js');
const setup = require('./setup'); // reuse the wizard's provider.env read/write (no side effects on require)
const lib = require('./lib');     // reuse the pure reapOrphanPids helper (no side effects on require)
const dc = require('./daemon-client'); // shared unix-socket client (request + /ask NDJSON stream)

let win = null;
let consoleWin = null;
let wakeWorker = null;
let tray = null;        // MODULE-LEVEL so the menu-bar Tray is never garbage-collected
let trayTimer = null;   // vitals refresh interval for the tray status line
function forward(channel, p) { for (const w of [win, consoleWin]) if (w && !w.isDestroyed()) w.webContents.send(channel, p); }
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
let askInFlight = 0; // refcount concurrent LOCAL asks so the dock badge clears only when all finish
function dockBadge() { if (app.dock && process.platform === 'darwin') app.dock.setBadge(askInFlight > 0 ? '…' : ''); }
function askDaemon(text) {
  askInFlight++; dockBadge();
  return new Promise(async (resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; askInFlight = Math.max(0, askInFlight - 1); dockBadge(); resolve(v); }; // idempotent: error+end can both fire
    if (!(await ensureDaemon())) { finish({ ok: false, text: '(brain offline)', model: '' }); return; }
    let done = false;
    // ./daemon-client frames + routes the /ask NDJSON stream. The overlay HUD needs EVERY raw thinking event
    // (reset/tool/delta), so we take them via onThinking and forward the payload verbatim, exactly as before.
    // No timeout is set (the overlay's turns can run long); a sync throw must still settle (and clear the badge).
    try {
      dc.streamAsk(text, {
        onThinking: (e) => { const { kind, ...p } = e; forward('urfael:thinking', p); },
        onSay: (e) => { const { kind, ...p } = e; forward('urfael:say', p); },
        onDone: (e) => { done = true; forward('urfael:done', { model: e.model, ms: e.ms, text: e.text, aborted: e.aborted }); finish({ ok: true, text: e.text, model: e.model }); },
        onError: (err) => {
          if (err.phase === 'end') { if (!done) finish({ ok: true, text: '', model: '' }); }
          else if (!done) finish({ ok: false, text: '(brain unreachable)', model: '' });   // 'error'
        },
      }, { socketPath: SOCK });
    } catch { finish({ ok: false, text: '(brain unreachable)', model: '' }); }
  });
}
function daemonPost(p) { try { const req = http.request({ socketPath: SOCK, method: 'POST', path: p }, (res) => res.resume()); req.on('error', () => {}); req.end(); } catch {} }
function daemonGet(p) {
  // parse the JSON reply, else null; a socket error/timeout resolves null (fail-soft for the always-on poller).
  return dc.request('GET', p, undefined, { socketPath: SOCK, timeoutMs: 1500 }).then((b) => { try { return JSON.parse(b); } catch { return null; } }, () => null);
}

function daemonPostJson(p, body) {
  return dc.request('POST', p, body || {}, { socketPath: SOCK, timeoutMs: 5000 }).then((b) => { try { return JSON.parse(b); } catch { return null; } }, () => null);
}

ipcMain.handle('urfael:ask', (_e, text) => askDaemon(text));
ipcMain.handle('urfael:abort', async () => { const r = await daemonPostJson('/abort'); return { ok: !!(r && r.ok) }; }); // stops only the current in-flight LOCAL turn

// ---- Console window IPC: session archive, reminders, jobs, settings ----
const MEMORY_DIR = path.join(os.homedir(), process.env.URFAEL_MEMORY_DIR || 'Urfael-memory');
const SESSIONS_DIR = path.join(MEMORY_DIR, 'sessions');
const SAFE_ID = /^[A-Za-z0-9-]{4,64}$/;
ipcMain.handle('urfael:sessions-days', () => {
  try { return fs.readdirSync(SESSIONS_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).map((f) => f.slice(0, -6)).sort().reverse(); } catch { return []; }
});
ipcMain.handle('urfael:session-read', (_e, day) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return [];
  try { return fs.readFileSync(path.join(SESSIONS_DIR, day + '.jsonl'), 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
});
ipcMain.handle('urfael:sessions-search', (_e, q) => {
  const needle = String(q || '').toLowerCase().slice(0, 200);
  if (!needle) return [];
  const out = [];
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter((x) => x.endsWith('.jsonl')).sort().reverse().slice(0, 90)) {
      for (const l of fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8').split('\n')) {
        if (!l || !l.toLowerCase().includes(needle)) continue;
        try { out.push(JSON.parse(l)); } catch {}
        if (out.length >= 60) return out;
      }
    }
  } catch {}
  return out;
});
ipcMain.handle('urfael:reminders', () => daemonGet('/reminders'));
ipcMain.handle('urfael:remind', (_e, spec) => daemonPostJson('/remind', spec));
ipcMain.handle('urfael:reminder-cancel', (_e, id) => SAFE_ID.test(String(id)) ? daemonPostJson('/reminder/' + id + '/cancel') : null);
ipcMain.handle('urfael:jobs', () => daemonGet('/jobs'));
ipcMain.handle('urfael:job', (_e, id) => SAFE_ID.test(String(id)) ? daemonGet('/job/' + id) : null);
ipcMain.handle('urfael:job-cancel', (_e, id) => SAFE_ID.test(String(id)) ? daemonPostJson('/job/' + id + '/cancel') : null);
const SETTABLE = ['SAY_VOICE', 'SAY_RATE', 'TTS_PROVIDER', 'STT_PROVIDER', 'URFAEL_THEME', 'URFAEL_ACKS', 'URFAEL_ORB', 'CONSOLE_VOICE', 'WAKE_KEYWORD', 'WAKE_WORD_LABEL', 'WHISPER_MODEL', 'KOKORO_VOICE', 'ELEVENLABS_SPEED'];
ipcMain.on('urfael:set-config', (_e, key, val) => {
  if (!SETTABLE.includes(key)) return;
  setTtsEnvValue(key, String(val).replace(/[\r\n]/g, '').slice(0, 200));
  if (key === 'URFAEL_THEME') forward('urfael:theme', String(val));
  // Some settings are baked into a live child process at boot; respawn it so the new value applies
  // now instead of only after a full app restart. The tts.env mtime cache is already invalidated by
  // the write above, so each respawn re-reads the new value.
  if (key === 'WHISPER_MODEL' || key === 'STT_PROVIDER') { stopWhisper(); startWhisper(); } // warm local STT, new argv
  if (key === 'WAKE_KEYWORD' || key === 'WAKE_WORD_LABEL') {                                 // Porcupine wake worker (orb HUD only)
    if (wakeWorker) { try { wakeWorker.postMessage('stop'); } catch {} wakeWorker = null; startWake(); }
  }
});
ipcMain.handle('urfael:vitals', () => daemonGet('/vitals'));
ipcMain.handle('urfael:learn', () => daemonGet('/learn'));   // the learning ledger (Hearth view)
ipcMain.handle('urfael:audit', () => daemonGet('/audit'));   // the team activity trail (Hearth view)
// ---- multi-chat manager (Console): open/list/talk-to/close independent provider-bound chats (new terminal windows) ----
ipcMain.handle('urfael:providers', () => daemonGet('/providers'));
ipcMain.handle('urfael:chat-open', (_e, spec) => daemonPostJson('/chat', { model: (spec && spec.model) === 'opus' ? 'opus' : 'sonnet', providerId: (spec && typeof spec.providerId === 'string') ? spec.providerId.slice(0, 60) : '' }));
ipcMain.handle('urfael:chat-close', (_e, id) => SAFE_ID.test(String(id)) ? daemonPostJson('/chat/' + id + '/disconnect', {}) : null);
ipcMain.handle('urfael:chat-ask', (_e, id, text) => {
  if (!SAFE_ID.test(String(id))) return { text: '(bad chat id)' };
  return new Promise((resolve) => {
    let out = '';   // the chat's warm session streams NDJSON like /ask; we only surface its final done text
    try {
      dc.streamAsk('', {
        onDone: (e) => { out = e.text || ''; },
        onError: (err) => {
          if (err.phase === 'error') resolve({ text: '(brain unreachable)' });
          else if (err.phase === 'timeout') resolve({ text: '(timed out)' });
          else resolve({ text: out });   // 'end'
        },
      }, { socketPath: SOCK, path: '/chat/' + id + '/ask', body: { text: String(text || '').slice(0, 8000) }, timeoutMs: 200000 });
    } catch { resolve({ text: '(error)' }); }
  });
});
ipcMain.on('urfael:conversation-end', () => daemonPost('/conversation-end'));

// ---- first-run GUI onboarding (so a non-technical user never needs a terminal) ----
ipcMain.handle('urfael:provider-status', () => {
  let mode = 'subscription';
  try { const e = setup.readEnv(); mode = e.ANTHROPIC_BASE_URL ? 'local' : e.ANTHROPIC_API_KEY ? 'apikey' : 'subscription'; } catch {}
  let onboarded = false; try { onboarded = fs.existsSync(ONBOARDED) || fs.existsSync(setup.PROVIDER_ENV); } catch {}
  return { onboarded, mode };
});
ipcMain.handle('urfael:save-provider', async (_e, cfg) => {
  cfg = cfg || {};
  try {
    const next = { ...setup.readEnv() };
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']) delete next[k]; // clear managed auth keys
    if (cfg.mode === 'apikey' && typeof cfg.key === 'string' && cfg.key.trim()) next.ANTHROPIC_API_KEY = cfg.key.trim();
    else if (cfg.mode === 'local' && typeof cfg.url === 'string' && /^https?:\/\//.test(cfg.url)) { next.ANTHROPIC_BASE_URL = cfg.url.trim(); next.ANTHROPIC_AUTH_TOKEN = (typeof cfg.token === 'string' && cfg.token.trim()) || 'local'; }
    setup.writeEnv(next);                                                         // 0600, atomic (reused from the CLI wizard)
    try { fs.mkdirSync(JDIR, { recursive: true }); fs.writeFileSync(ONBOARDED, new Date().toISOString()); } catch {}
    try { await daemonPostJson('/shutdown'); } catch {}                          // restart so the daemon loads the new provider.env
    await new Promise((r) => setTimeout(r, 600));
    await ensureDaemon();
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

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

// ---- Console window: the desktop-app surface (chat, archive, reminders, jobs, settings) ----
const CONSOLE_STATE = path.join(os.homedir(), '.claude', 'urfael', 'console-window.json');
function createConsole() {
  if (consoleWin && !consoleWin.isDestroyed()) { consoleWin.show(); consoleWin.focus(); return; }
  let st = {}; try { st = JSON.parse(fs.readFileSync(CONSOLE_STATE, 'utf8')); } catch {}
  consoleWin = new BrowserWindow({
    width: st.width || 1100, height: st.height || 720, x: st.x, y: st.y,
    minWidth: 780, minHeight: 500,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#14100a', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  consoleWin.loadFile(path.join(__dirname, 'console', 'index.html'));
  consoleWin.once('ready-to-show', () => consoleWin.show());
  consoleWin.on('close', () => { try { fs.writeFileSync(CONSOLE_STATE, JSON.stringify(consoleWin.getBounds())); } catch {} }); // remember bounds (HIG)
  consoleWin.on('closed', () => { consoleWin = null; });
}
ipcMain.on('urfael:open-console', createConsole);

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
  // dismissed by ANY route (hide IPC, Cmd+Shift+U toggle, close box) -> tell the renderer to end a live voice
  // conversation so the mic is released and the wake word is re-armed. Fixes a mic that stayed on after walking away.
  win.on('hide', () => { if (win && !win.isDestroyed()) win.webContents.send('urfael:hidden'); });
  // null the reference when the orb window is destroyed (Cmd+W), so every `if (win)` guard short-circuits afterward.
  // Without this, win stays truthy-but-destroyed and the wake-worker handler + the Cmd+Shift+U toggle deref a dead
  // window and crash the app (mirrors createConsole's consoleWin.on('closed')).
  win.on('closed', () => { win = null; });
}
function toggle() {
  if (!win) return;
  if (win.isVisible()) { win.hide(); if (wakeWorker) wakeWorker.postMessage('pause'); }
  else { win.showInactive(); win.show(); win.webContents.send('urfael:shown'); if (wakeWorker) wakeWorker.postMessage('resume'); }
}

// ---- native menu bar -------------------------------------------------------
// App-action items send 'urfael:menu' (an action string) to the focused window; the Console renderer
// consumes it via window.urfael.onMenu. Edit/Window roles stay native.
// Console-bound actions (views, new, settings, stop) always target the Console even when the orb is
// focused — opening it if needed; window-agnostic actions go to the focused window.
function menuSend(action) {
  const consoleBound = action.startsWith('view:') || ['new', 'settings', 'stop'].includes(action);
  let w = consoleBound ? (consoleWin && !consoleWin.isDestroyed() ? consoleWin : null) : BrowserWindow.getFocusedWindow();
  if (consoleBound && !w) { createConsole(); w = consoleWin; }
  if (w && !w.isDestroyed()) w.webContents.send('urfael:menu', action);
}
function toggleOrb() { if (win && !win.isDestroyed()) toggle(); else { createWindow(); win.once('ready-to-show', () => { win.showInactive(); win.show(); }); } }
function buildMenu() {
  const tpl = [
    { label: 'Urfael', submenu: [
      { label: 'About Urfael', click: () => app.showAboutPanel() },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => menuSend('settings') },
      { type: 'separator' },
      { role: 'hide' },
      { type: 'separator' },
      { label: 'Quit Urfael', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ] },
    { label: 'File', submenu: [
      { label: 'New Conversation', accelerator: 'CmdOrCtrl+N', click: () => menuSend('new') },
      { label: 'Open Console', accelerator: 'CmdOrCtrl+Shift+O', click: createConsole },
      { type: 'separator' },
      { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+W' },
    ] },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { label: 'View', submenu: [
      { label: 'Converse', accelerator: 'CmdOrCtrl+1', click: () => menuSend('view:converse') },
      { label: 'Archive', accelerator: 'CmdOrCtrl+2', click: () => menuSend('view:archive') },
      { label: 'Reminders', accelerator: 'CmdOrCtrl+3', click: () => menuSend('view:reminders') },
      { label: 'Jobs', accelerator: 'CmdOrCtrl+4', click: () => menuSend('view:jobs') },
      { label: 'Hearth', accelerator: 'CmdOrCtrl+5', click: () => menuSend('view:hearth') },
      { label: 'Settings', accelerator: 'CmdOrCtrl+6', click: () => menuSend('view:settings') },
      { type: 'separator' },
      { label: 'Stop Generation', accelerator: 'CmdOrCtrl+.', click: () => menuSend('stop') },
      { label: 'Toggle Orb HUD', click: () => { toggleOrb(); menuSend('toggle-orb'); } },
      { role: 'reload' },
      { role: 'toggleDevTools' },
    ] },
    { label: 'Window', submenu: [ { role: 'minimize' }, { role: 'zoom' } ] },
    { label: 'Help', role: 'help', submenu: [ { label: 'About Urfael', click: () => app.showAboutPanel() } ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// ---- menu-bar / system-tray (third lightweight surface) --------------------
// macOS: a monochrome Template image evoking the Uruz rune (ASCII). The icon is built at runtime from a
// macOS Template image — a black-on-transparent PNG (Electron's nativeImage CANNOT decode SVG data URLs;
// it would return an empty image and `new Tray()` would throw). The @2x file is picked up automatically.
// Linux: setTemplateImage is a no-op there and a black-on-transparent icon is invisible on most panels,
// so we load a normal gold (visible) rune icon instead, decoded from an embedded PNG data URL.
const TRAY_ICON_LINUX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAQUlEQVR42mNgGAXEgOeHGv6DME0Mpbrh6AZTzQJcBlNsASGDyTYcmwFUMRyfZooMJ6Rx1OBRg0e0wTDNlMgPLQAAWXg7sAHZVNgAAAAASUVORK5CYII=';
function trayIcon() {
  if (process.platform === 'linux') {
    return nativeImage.createFromDataURL(TRAY_ICON_LINUX); // gold rune; NOT a template image (panels don't tint, would be invisible)
  }
  const img = nativeImage.createFromPath(path.join(__dirname, 'renderer', 'trayTemplate.png'));
  img.setTemplateImage(true); // monochrome; macOS tints it for the active menu-bar appearance
  return img;
}
function shortModel(m) { // '/vitals' returns a full model id - keep the tray line terse
  if (!m) return '?';
  const s = String(m).toLowerCase();
  if (s.includes('opus')) return 'Opus';
  if (s.includes('sonnet')) return 'Sonnet';
  if (s.includes('haiku')) return 'Haiku';
  return String(m).replace(/^claude-/, '').replace(/-\d{6,}$/, '').slice(0, 18) || '?';
}
function buildTrayMenu(status) {
  return Menu.buildFromTemplate([
    { label: 'Open Console', click: createConsole },
    { label: 'Toggle Orb HUD', click: () => { toggleOrb(); menuSend('toggle-orb'); } },
    { label: 'New Conversation', click: () => menuSend('new') },
    { label: 'Stop Generation', click: () => menuSend('stop') },
    { type: 'separator' },
    { label: status || 'brain offline', enabled: false },
    { type: 'separator' },
    { label: 'Quit Urfael', click: () => shutdownAll() },
  ]);
}
async function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const v = await daemonGet('/vitals');
  const status = v ? `${shortModel(v.model)} - ${v.turnsToday || 0} turn${v.turnsToday === 1 ? '' : 's'} today` : 'brain offline';
  if (!tray || tray.isDestroyed()) return; // may have been torn down during the await
  tray.setContextMenu(buildTrayMenu(status));
}
function createTray() {
  if ((process.platform !== 'darwin' && process.platform !== 'linux') || tray) return; // menu-bar (macOS) / system-tray (Linux) presence
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('Urfael');
    tray.setIgnoreDoubleClickEvents(true);
    tray.on('click', () => { if (consoleWin && !consoleWin.isDestroyed()) { consoleWin.show(); consoleWin.focus(); } else createConsole(); }); // left-click -> Console
    tray.setContextMenu(buildTrayMenu(null));
    refreshTray();
    trayTimer = setInterval(refreshTray, 10000);
    if (trayTimer.unref) trayTimer.unref(); // don't keep the event loop alive for the tray poll
  } catch { tray = null; }
}
function destroyTray() {
  if (trayTimer) { clearInterval(trayTimer); trayTimer = null; }
  if (tray && !tray.isDestroyed()) { try { tray.destroy(); } catch {} }
  tray = null;
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
      cfg[t.slice(0, i).trim()] = t.slice(i + 1).replace(/\s+#.*$/, '').trim(); // strip inline comments
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
    orb: cfg.URFAEL_ORB === '1',     // the floating orb HUD is OPT-IN — the Console is the app
    consoleVoice: cfg.CONSOLE_VOICE !== '0', // Console speaks the [SPOKEN] remark aloud (default on)
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
function whisperBin() { for (const p of ['/opt/homebrew/bin/whisper-server', '/usr/local/bin/whisper-server', '/usr/bin/whisper-server']) { try { fs.accessSync(p); return p; } catch {} } return 'whisper-server'; } // Linux: whisper.cpp typically installs to /usr/bin or /usr/local/bin
// Whisper-server orphan reaper — mirror of the brain's brain.pids discipline (daemon.js recordBrainPid /
// cleanupOrphanBrains, now the SAME lib.makePidLedger). The 168MB model server is a detached long-lived child;
// on any Electron crash / force-quit / SIGKILL it would otherwise be orphaned forever, and only the OLDEST
// orphan owns STT port 8462, so a fresh spawn silently fails to bind. So: record every spawned pid WITH its
// start-time marker, and reap any recorded pid that is STILL our process (alive AND marker matches) then
// truncate — a pid the OS recycled for something unrelated no longer matches its marker and is left untouched.
const WHISPER_PIDFILE = path.join(JDIR, 'whisper.pids');
const whisperLedger = lib.makePidLedger({
  read: (f) => fs.readFileSync(f, 'utf8'),
  write: (f, s) => fs.writeFileSync(f, s),
  append: (f, s) => fs.appendFileSync(f, s),
  mkdir: () => fs.mkdirSync(JDIR, { recursive: true }),
  kill: (pid) => process.kill(pid, 'SIGKILL'),
  run: (cmd, args) => require('child_process').execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString(),
}, WHISPER_PIDFILE);
function recordWhisperPid(pid) { whisperLedger.record(pid); }
function cleanupOrphanWhispers() { whisperLedger.reap(); }
function startWhisper() {
  const cfg = readTtsEnv();
  if (cfg.sttProvider !== 'whispercpp') return;                                  // only the local-STT path needs the server
  const model = path.join(os.homedir(), '.claude', 'urfael', 'models', `ggml-${cfg.whisperModel}.bin`);
  if (!fs.existsSync(model)) { forward('urfael:wake', { error: 'Local STT model missing — run install.sh (downloads whisper)' }); return; }
  whisperStopped = false;
  cleanupOrphanWhispers();                                                       // reap a leaked whisper-server BEFORE we bind 8462, so the fresh spawn never loses the port to a zombie
  try {
    const spawnedAt = Date.now();
    const child = spawn(whisperBin(), ['--model', model, '--host', '127.0.0.1', '--port', String(cfg.sttPort), '--language', 'en', '--no-timestamps'],
      { stdio: 'ignore' });
    whisperProc = child;
    recordWhisperPid(child.pid);                                                 // ledger the pid so a future run can reap us if we are orphaned
    child.on('exit', () => {                                                     // supervised: auto-respawn with backoff so a crash never leaves Urfael deaf
      if (whisperProc !== child) return;                                         // a settings respawn already replaced us; ignore this stale exit (no double-spawn)
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
  let aboutVersion = ''; try { aboutVersion = require('./package.json').version || ''; } catch {}
  try { app.setAboutPanelOptions({ applicationName: 'Urfael', applicationVersion: aboutVersion, copyright: 'Self-hosted local AI daemon' }); } catch {} // backs the native About panel (menu items call app.showAboutPanel)
  buildMenu();                                                     // native menu bar + accelerators
  createTray();                                                    // macOS menu-bar / Linux system-tray presence (third surface; no-op on other platforms)
  const orbOn = readTtsEnv().orb || process.env.URFAEL_ORB === '1';
  createConsole();                                                 // the Console IS the app
  globalShortcut.register('CommandOrControl+Shift+O', createConsole);
  globalShortcut.register('CommandOrControl+Shift+Q', shutdownAll);
  if (orbOn) {                                                     // ambient orb HUD — opt-in (URFAEL_ORB=1)
    createWindow();
    globalShortcut.register('CommandOrControl+Shift+U', toggle);
    globalShortcut.register('CommandOrControl+Shift+T', cycleTheme);
    globalShortcut.register('CommandOrControl+Shift+H', () => forward('urfael:hud-toggle'));
    win.once('ready-to-show', () => { win.showInactive(); win.show(); });
    startWake();
    startGaze();
  }
  ensureDaemon();
  cleanupOrphanWhispers();   // reap a whisper-server orphaned by a prior crash/force-quit even if STT is now disabled (mirrors daemon's cleanupOrphanBrains at boot)
  startWhisper();   // warm local STT (Console push-to-talk + orb voice)
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); stopWhisper(); destroyTray(); try { wakeWorker && wakeWorker.postMessage('stop'); } catch {} }); // daemon (brain) intentionally keeps running
app.on('activate', () => { if (!consoleWin) createConsole(); });       // dock click → Console
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); }); // macOS: app lives in the dock; reopen via click
ipcMain.on('urfael:hide', () => win && win.hide());
ipcMain.on('urfael:quit', () => app.quit());
