'use strict';
// Local, API-free voice for Urfael (runs in the Electron MAIN process).
// TTS: macOS `say` (default) or local Kokoro. STT: local whisper.cpp (via a warm whisper-server).
// Every function returns audio BYTES or text — it never plays audio itself, so the renderer can play
// through its Web Audio graph and keep the orb audio-reactive. Errors are thrown (fail-loud), so the
// renderer can surface "install X" instead of going silently deaf.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// First executable on PATH from a candidate list, or null. Used to pick the Linux TTS engine at call time.
function firstOnPath(bins) {
  const dirs = (process.env.PATH || '').split(path.delimiter);   // ':' on POSIX, ';' on win32
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const bin of bins) for (const d of dirs) { if (!d) continue; for (const e of exts) { try { fs.accessSync(path.join(d, bin + e), fs.constants.X_OK); return bin + e; } catch {} } }
  return null;
}

// ffmpeg, resolved ONCE: absolute install dirs first (a Finder/Dock-launched app inherits launchd's bare PATH,
// where `ffmpeg` alone would ENOENT even though brew installed it — same trap on a Start-menu launch), then
// PATH, then the bare name so the existing "install ffmpeg" error text still fires when it's truly absent.
let _ffmpeg = null;
function ffmpegBin() {
  if (_ffmpeg) return _ffmpeg;
  const cands = process.platform === 'win32'
    ? [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Urfael', 'bin', 'ffmpeg.exe')]
    : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
  for (const c of cands) { try { fs.accessSync(c); return (_ffmpeg = c); } catch {} }
  return (_ffmpeg = firstOnPath(['ffmpeg']) || 'ffmpeg');
}

const TMP = os.tmpdir();
function tmpfile(ext) { return path.join(TMP, `jv-${process.pid}-${Math.random().toString(36).slice(2)}.${ext}`); }
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 27, ...opts }, (err, stdout, stderr) => {
      if (err) { err.message = `${cmd} failed: ${(stderr || err.message || '').toString().slice(0, 200)}`; reject(err); }
      else resolve(stdout);
    });
  });
}

// ---- TTS ----
// macOS `say` → AIFF, then ffmpeg → mp3 bytes (decodeAudioData-friendly, keeps the orb reactive).
// On Linux, espeak-ng/espeak → WAV, then ffmpeg → mp3 bytes (same return contract: an mp3 Buffer).
async function synthSay(text, cfg) {
  if (process.platform === 'win32') return synthSayWin(text, cfg);
  if (process.platform !== 'darwin') return synthSayLinux(text, cfg);
  const aiff = tmpfile('aiff');
  const args = [];
  if (cfg.sayVoice) args.push('-v', cfg.sayVoice);
  if (cfg.sayRate) args.push('-r', String(cfg.sayRate));
  args.push('-o', aiff, text);
  try {
    await run('say', args);
    const mp3 = await run(ffmpegBin(), ['-y', '-i', aiff, '-f', 'mp3', '-'], { encoding: 'buffer' });
    return Buffer.from(mp3);
  } catch (e) {
    throw new Error(/ffmpeg/.test(e.message) ? 'Local TTS needs ffmpeg — run: brew install ffmpeg' : 'macOS `say` failed');
  } finally { try { fs.unlinkSync(aiff); } catch {} }
}
// Linux TTS requirement (documented): espeak-ng (preferred) or espeak, plus ffmpeg. espeak writes WAV
// directly (-w), so we synth → WAV, then ffmpeg WAV → mp3 bytes — same mp3 Buffer the renderer expects.
// SAY_VOICE/SAY_RATE are honored where espeak supports them: -v <voice>, -s <words/min>.
async function synthSayLinux(text, cfg) {
  const engine = firstOnPath(['espeak-ng', 'espeak']);
  if (!engine) throw new Error('Local TTS needs espeak — run: apt install espeak-ng (or espeak)');
  const wav = tmpfile('wav');
  const args = [];
  // -v takes an espeak voice ('en', 'en-us+f3'), NOT a macOS voice name — the shipped default SAY_VOICE='Daniel'
  // would make espeak fail, so only pass it when it looks like an espeak voice; otherwise use the engine default.
  if (cfg.sayVoice && /^[a-z]{2,3}([-+][a-z0-9-]+)*$/i.test(String(cfg.sayVoice).trim())) args.push('-v', String(cfg.sayVoice).trim());
  if (cfg.sayRate && /^\d+$/.test(String(cfg.sayRate).trim())) args.push('-s', String(cfg.sayRate).trim()); // espeak -s is wpm, like SAY_RATE
  args.push('-w', wav, text);
  try {
    await run(engine, args);
    const mp3 = await run(ffmpegBin(), ['-y', '-i', wav, '-f', 'mp3', '-'], { encoding: 'buffer' });
    return Buffer.from(mp3);
  } catch (e) {
    throw new Error(/ffmpeg/.test(e.message) ? 'Local TTS needs ffmpeg — run: apt install ffmpeg' : `Local TTS \`${engine}\` failed`);
  } finally { try { fs.unlinkSync(wav); } catch {} }
}
// win32 TTS: the built-in SAPI synthesizer writes a WAV (no extra install), then ffmpeg → mp3 bytes — the
// same return contract. Text crosses into PowerShell as a SINGLE-QUOTED literal with quotes doubled (the same
// injection-safe encoding platform.js uses for speak()); the wav path we control is encoded the same way.
async function synthSayWin(text, cfg) {
  const wav = tmpfile('wav');
  const psq = (x) => "'" + String(x).replace(/'/g, "''") + "'";
  const rate = cfg.sayRate && /^\d+$/.test(String(cfg.sayRate).trim()) ? Math.max(-10, Math.min(10, Math.round((Number(cfg.sayRate) - 175) / 25))) : 0;  // wpm → SAPI -10..10, 175wpm ≈ 0
  const script = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = ' + rate + '; $s.SetOutputToWaveFile(' + psq(wav) + '); $s.Speak(' + psq(String(text).slice(0, 4000)) + '); $s.Dispose()';
  try {
    await run('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
    const mp3 = await run(ffmpegBin(), ['-y', '-i', wav, '-f', 'mp3', '-'], { encoding: 'buffer' });
    return Buffer.from(mp3);
  } catch (e) {
    throw new Error(/ffmpeg/.test(e.message) ? 'Local TTS needs ffmpeg — run: winget install Gyan.FFmpeg (or re-run install.ps1)' : 'Windows SAPI TTS failed');
  } finally { try { fs.unlinkSync(wav); } catch {} }
}

// Optional local upgrade: Kokoro-FastAPI (OpenAI-compatible, no auth) → mp3 bytes.
function synthKokoro(text, cfg) {
  const body = JSON.stringify({ model: 'kokoro', voice: cfg.kokoroVoice || 'bm_george', input: text, response_format: 'mp3' });
  const u = new URL(cfg.kokoroUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => res.statusCode === 200 ? resolve(Buffer.concat(c)) : reject(new Error('Kokoro server error ' + res.statusCode))); });
    req.on('error', () => reject(new Error('Kokoro not running — start Kokoro-FastAPI on :8880 (see SETUP.md) or use TTS_PROVIDER=say')));
    req.write(body); req.end();
  });
}
async function synth(text, cfg) {
  if (cfg.ttsProvider === 'kokoro') return synthKokoro(text, cfg);
  return synthSay(text, cfg); // 'say' default; 'elevenlabs' handled in the renderer (network fetch)
}

// ---- STT (local whisper.cpp via the warm whisper-server) ----
function postWav(port, wav) {
  const boundary = '----urfael' + Date.now();
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n--${boundary}--\r\n`);
  const bodyBuf = Buffer.concat([head, wav, tail]);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/inference', method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d).text || ''); } catch { resolve(d.trim()); } }); });
    req.on('error', () => reject(new Error('whisper-server not reachable')));
    req.write(bodyBuf); req.end();
  });
}
async function transcribeWhisper(webmBuf, cfg) {
  const webm = tmpfile('webm'), wav = tmpfile('wav');
  try {
    fs.writeFileSync(webm, webmBuf);
    await run(ffmpegBin(), ['-y', '-i', webm, '-ar', '16000', '-ac', '1', wav]); // → 16kHz mono WAV for whisper
    const text = await postWav(cfg.sttPort, fs.readFileSync(wav));
    return (text || '').trim();
  } catch (e) {
    const isWin = process.platform === 'win32';
    throw new Error(/ffmpeg/.test(e.message) ? ('Local STT needs ffmpeg — run: ' + (isWin ? 'winget install Gyan.FFmpeg (or re-run install.ps1)' : 'brew install ffmpeg'))
      : ('Local STT unavailable — ' + (isWin ? 're-run install.ps1 (it fetches whisper-server + the model)' : 'run: brew install whisper-cpp (and let install.sh fetch the model)')));
  } finally { for (const f of [webm, wav]) { try { fs.unlinkSync(f); } catch {} } }
}
async function transcribe(webmBuf, cfg) { return transcribeWhisper(webmBuf, cfg); } // elevenlabs STT handled in renderer

module.exports = { synth, transcribe };
