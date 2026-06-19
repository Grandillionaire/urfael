'use strict';
// preload.js — the renderer↔main bridge. Exposes a single frozen `window.urfael` surface over
// contextBridge: every renderer capability is an explicit ipcRenderer.invoke/send/on here (no raw
// ipcRenderer, no Node) so the orb/console can only reach the main process through this allowlist.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('urfael', {
  config: () => ipcRenderer.invoke('urfael:config'),
  ask: (text) => ipcRenderer.invoke('urfael:ask', text),
  abort: () => ipcRenderer.invoke('urfael:abort'),        // stop the current in-flight LOCAL turn
  vitals: () => ipcRenderer.invoke('urfael:vitals'),
  tts: (text) => ipcRenderer.invoke('urfael:tts', text),   // local TTS → audio bytes
  stt: (buf) => ipcRenderer.invoke('urfael:stt', buf),     // local STT → transcript text
  hide: () => ipcRenderer.send('urfael:hide'),
  quit: () => ipcRenderer.send('urfael:quit'),
  shutdown: () => ipcRenderer.send('urfael:shutdown'),
  setTheme: (t) => ipcRenderer.send('urfael:set-theme', t),
  setInteractive: (on) => ipcRenderer.send('urfael:interactive', on), // mouse passthrough toggle
  conversationEnd: () => ipcRenderer.send('urfael:conversation-end'),
  // Console (desktop app) surface
  openConsole: () => ipcRenderer.send('urfael:open-console'),
  sessionsDays: () => ipcRenderer.invoke('urfael:sessions-days'),
  sessionRead: (day) => ipcRenderer.invoke('urfael:session-read', day),
  sessionsSearch: (q) => ipcRenderer.invoke('urfael:sessions-search', q),
  reminders: () => ipcRenderer.invoke('urfael:reminders'),
  remind: (spec) => ipcRenderer.invoke('urfael:remind', spec),
  reminderCancel: (id) => ipcRenderer.invoke('urfael:reminder-cancel', id),
  jobs: () => ipcRenderer.invoke('urfael:jobs'),
  job: (id) => ipcRenderer.invoke('urfael:job', id),
  jobCancel: (id) => ipcRenderer.invoke('urfael:job-cancel', id),
  setConfig: (k, v) => ipcRenderer.send('urfael:set-config', k, v),
  providerStatus: () => ipcRenderer.invoke('urfael:provider-status'),   // first-run onboarding
  saveProvider: (cfg) => ipcRenderer.invoke('urfael:save-provider', cfg),
  learn: () => ipcRenderer.invoke('urfael:learn'),                      // the verify-before-trust ledger
  audit: () => ipcRenderer.invoke('urfael:audit'),                      // the team-mode activity trail
  wakePause: () => ipcRenderer.send('urfael:wake-pause'),
  wakeDone: () => ipcRenderer.send('urfael:wake-done'),
  onShown: (cb) => ipcRenderer.on('urfael:shown', () => cb()),
  onThinking: (cb) => ipcRenderer.on('urfael:thinking', (_e, p) => cb(p)),
  onSay: (cb) => ipcRenderer.on('urfael:say', (_e, p) => cb(p)),
  onDone: (cb) => ipcRenderer.on('urfael:done', (_e, p) => cb(p)),
  onWake: (cb) => ipcRenderer.on('urfael:wake', (_e, p) => cb(p)),
  onTheme: (cb) => ipcRenderer.on('urfael:theme', (_e, t) => cb(t)),
  onGaze: (cb) => ipcRenderer.on('urfael:gaze', (_e, g) => cb(g)),
  onHudToggle: (cb) => ipcRenderer.on('urfael:hud-toggle', () => cb()),
  onMenu: (cb) => ipcRenderer.on('urfael:menu', (_e, a) => cb(a)), // native menu app-actions (view:*, new, settings, stop, toggle-orb, about)
});
