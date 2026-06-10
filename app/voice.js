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
async function synthSay(text, cfg) {
  const aiff = tmpfile('aiff');
  const args = [];
  if (cfg.sayVoice) args.push('-v', cfg.sayVoice);
  if (cfg.sayRate) args.push('-r', String(cfg.sayRate));
  args.push('-o', aiff, text);
  try {
    await run('say', args);
    const mp3 = await run('ffmpeg', ['-y', '-i', aiff, '-f', 'mp3', '-'], { encoding: 'buffer' });
    return Buffer.from(mp3);
  } catch (e) {
    throw new Error(/ffmpeg/.test(e.message) ? 'Local TTS needs ffmpeg — run: brew install ffmpeg' : 'macOS `say` failed');
  } finally { try { fs.unlinkSync(aiff); } catch {} }
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
    await run('ffmpeg', ['-y', '-i', webm, '-ar', '16000', '-ac', '1', wav]); // → 16kHz mono WAV for whisper
    const text = await postWav(cfg.sttPort, fs.readFileSync(wav));
    return (text || '').trim();
  } catch (e) {
    throw new Error(/ffmpeg/.test(e.message) ? 'Local STT needs ffmpeg — run: brew install ffmpeg'
      : 'Local STT unavailable — run: brew install whisper-cpp (and let install.sh fetch the model)');
  } finally { for (const f of [webm, wav]) { try { fs.unlinkSync(f); } catch {} } }
}
async function transcribe(webmBuf, cfg) { return transcribeWhisper(webmBuf, cfg); } // elevenlabs STT handled in renderer

module.exports = { synth, transcribe };
