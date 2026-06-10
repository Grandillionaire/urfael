'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('urfael', {
  config: () => ipcRenderer.invoke('urfael:config'),
  ask: (text) => ipcRenderer.invoke('urfael:ask', text),
  vitals: () => ipcRenderer.invoke('urfael:vitals'),
  tts: (text) => ipcRenderer.invoke('urfael:tts', text),   // local TTS → audio bytes
  stt: (buf) => ipcRenderer.invoke('urfael:stt', buf),     // local STT → transcript text
  hide: () => ipcRenderer.send('urfael:hide'),
  quit: () => ipcRenderer.send('urfael:quit'),
  shutdown: () => ipcRenderer.send('urfael:shutdown'),
  setTheme: (t) => ipcRenderer.send('urfael:set-theme', t),
  setInteractive: (on) => ipcRenderer.send('urfael:interactive', on), // mouse passthrough toggle
  conversationEnd: () => ipcRenderer.send('urfael:conversation-end'),
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
});
