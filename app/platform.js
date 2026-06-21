'use strict';
// app/platform.js — one place that knows WHICH host Urfael runs on and HOW to do platform-specific things there
// (desktop notification, local TTS, whether a Docker sandbox is even possible). PURE + unit-tested: the environment
// and process.platform are injected, so detection is deterministic. This adds Termux/Android as a first-class target
// alongside macOS, Linux, WSL, and Windows, and centralizes the platform branching that was scattered in daemon.js.
// notify()/speak() return a { cmd, args } argv the caller runs with execFile (NO shell), so they are injection-safe.

function jsq(s) { return JSON.stringify(String(s)); }                  // osascript: an AppleScript double-quoted string
function psq(s) { return "'" + String(s).replace(/'/g, "''") + "'"; } // PowerShell: a single-quoted string

const NOTIFY = {
  termux:  (t, b) => ({ cmd: 'termux-notification', args: ['--title', t, '--content', b] }),
  macos:   (t, b) => ({ cmd: 'osascript', args: ['-e', 'display notification ' + jsq(b) + ' with title ' + jsq(t)] }),
  windows: (t, b) => ({ cmd: 'powershell', args: ['-NoProfile', '-Command', 'New-BurntToastNotification -Text ' + psq(t) + ',' + psq(b)] }),
  wsl:     (t, b) => ({ cmd: 'notify-send', args: [t, b] }),
  linux:   (t, b) => ({ cmd: 'notify-send', args: [t, b] }),
};
const SPEAK = {
  termux:  (x) => ({ cmd: 'termux-tts-speak', args: [x] }),
  macos:   (x) => ({ cmd: 'say', args: [x] }),
  windows: (x) => ({ cmd: 'powershell', args: ['-Command', 'Add-Type -AssemblyName System.Speech;(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak(' + psq(x) + ')'] }),
  wsl:     (x) => ({ cmd: 'espeak-ng', args: [x] }),
  linux:   (x) => ({ cmd: 'espeak-ng', args: [x] }),
};

// detect(env, platform) → a platform profile. env defaults to process.env, platform to process.platform.
function detect(env, platform) {
  const e = env || process.env || {};
  const p = platform || process.platform || 'linux';
  const isTermux = /com\.termux/.test(String(e.PREFIX || '')) || !!e.TERMUX_VERSION || /com\.termux/.test(String(e.HOME || ''));
  const isWsl = !!e.WSL_DISTRO_NAME || /microsoft/i.test(String(e.WSL_INTEROP || ''));
  const kind = isTermux ? 'termux' : p === 'darwin' ? 'macos' : p === 'win32' ? 'windows' : isWsl ? 'wsl' : 'linux';
  const hasDocker = kind === 'linux' || kind === 'macos' || kind === 'wsl';    // not Termux (no Docker), not Windows (out of scope for the goal-loop)
  return {
    kind, isTermux, isWsl, isMobile: isTermux, hasDocker,
    home: String(e.HOME || ''),
    notify: (title, body) => NOTIFY[kind](String(title == null ? 'Urfael' : title).slice(0, 120), String(body == null ? '' : body).slice(0, 500)),
    speak: (text) => SPEAK[kind](String(text == null ? '' : text).slice(0, 4000)),
    // capability flags the rest of the system can gate on, instead of re-sniffing the OS
    caps: { docker: hasDocker, sms: isTermux, telephony: isTermux, clipboard: kind === 'macos' || isTermux, desktopNotify: kind !== 'termux' },
  };
}

module.exports = { detect, NOTIFY, SPEAK };
