'use strict';
// app/bridge/discord-voice-bridge.js — the I/O shell for Discord voice-channel voice. The bot joins a VC, listens,
// and talks back, reusing Urfael's LOCAL pipeline: whisper.cpp transcribes (core.transcribeLocal), the brain answers
// over the unix socket (core.askDaemon), and a local TTS speaks the reply into the channel. All the testable +
// security logic is in discord-voice-lib.js; this file is the thin glue around the heavy @discordjs/voice + opus
// stack, which is an OPTIONAL dependency: the core stays installable without it, and this shell fails soft with a
// clear install line if it is missing. STATUS: code-complete; the live voice-channel round-trip is the cert step
// (it needs the optional deps installed, ffmpeg, a local TTS, and a real Discord bot in a real voice channel).
//   node app/bridge/discord-voice-bridge.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const core = require('./bridge-core');
const vlib = require('./discord-voice-lib');

const TMP = path.join(os.tmpdir(), 'urfael-dvoice');
try { fs.mkdirSync(TMP, { recursive: true }); } catch {}

// lazily load the heavy voice stack; return null (with a helpful message) when it is not installed.
function loadStack() {
  try {
    const djs = require('discord.js');
    const voice = require('@discordjs/voice');
    const prism = require('prism-media');
    return { djs, voice, prism };
  } catch (e) {
    process.stderr.write('Discord voice channel support needs optional packages. Install them with:\n'
      + '  npm install discord.js @discordjs/voice prism-media @discordjs/opus libsodium-wrappers\n'
      + 'and have ffmpeg + a local TTS (macOS `say`, or espeak-ng on Linux) available.\n'
      + '(' + ((e && e.message) || e) + ')\n');
    return null;
  }
}

// local TTS: text → a wav file path, or null. macOS `say` first, then espeak-ng. Nothing leaves the machine.
function synthesize(text) {
  const f = path.join(TMP, 'tts-' + process.pid + '.wav');
  try {
    if (process.platform === 'darwin' && spawnSync('which', ['say']).status === 0) {
      execFileSync('say', ['-o', f, '--data-format=LEI16@22050', String(text).slice(0, 4000)], { stdio: 'ignore' });
      return fs.existsSync(f) ? f : null;
    }
    if (spawnSync('which', ['espeak-ng']).status === 0) { execFileSync('espeak-ng', ['-w', f, String(text).slice(0, 4000)], { stdio: 'ignore' }); return fs.existsSync(f) ? f : null; }
  } catch {}
  return null;
}

// decode a received opus stream to a wav file whisper can read (opus → PCM via prism → wav via ffmpeg). Resolves the
// path, or null on failure. 48k stereo s16le is what discord delivers.
function opusToWav(prism, opusStream, dest) {
  return new Promise((resolve) => {
    const pcm = path.join(TMP, 'in-' + process.pid + '.pcm');
    const w = fs.createWriteStream(pcm);
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    opusStream.pipe(decoder).pipe(w);
    w.on('finish', () => {
      try {
        execFileSync('ffmpeg', ['-y', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', pcm, '-ar', '16000', '-ac', '1', dest], { stdio: 'ignore' });
        resolve(fs.existsSync(dest) ? dest : null);
      } catch { resolve(null); }
    });
    w.on('error', () => resolve(null));
    opusStream.on('error', () => { try { w.end(); } catch {} });
  });
}

async function main() {
  const stack = loadStack(); if (!stack) process.exit(1);
  const { djs, voice, prism } = stack;
  const cfg = core.loadEnv();
  const token = cfg.DISCORD_TOKEN, guildId = cfg.DISCORD_VOICE_GUILD_ID, channelId = cfg.DISCORD_VOICE_CHANNEL_ID;
  if (!token || !guildId || !channelId) { process.stderr.write('set DISCORD_TOKEN, DISCORD_VOICE_GUILD_ID, DISCORD_VOICE_CHANNEL_ID in bridge.env\n'); process.exit(1); }
  const ownerOnly = /^(1|on|true)$/i.test(cfg.DISCORD_VOICE_OWNER_ONLY || '');

  const client = new djs.Client({ intents: [djs.GatewayIntentBits.Guilds, djs.GatewayIntentBits.GuildVoiceStates] });
  const player = voice.createAudioPlayer();
  let state = 'idle';
  const busy = new Set();   // userIds currently being captured (one capture per speaker at a time)

  async function speak(text) {
    const clean = vlib.toSpeech(text); if (!clean) { state = vlib.next(state, 'playback-done'); return; }
    state = vlib.next(state, 'reply');
    for (const chunk of vlib.splitSentences(clean)) {
      if (state !== 'speaking') break;                                  // barge-in stopped us
      const wav = synthesize(chunk); if (!wav) continue;
      await new Promise((res) => {
        player.play(voice.createAudioResource(wav));
        const done = () => { player.off(voice.AudioPlayerStatus.Idle, done); res(); };
        player.on(voice.AudioPlayerStatus.Idle, done);
      });
    }
    state = vlib.next(state, 'playback-done');
  }

  async function onUtterance(userId, connection) {
    const gate = vlib.speakerGate(core.loadRoster(), userId, { botUserId: client.user && client.user.id, ownerOnly });
    if (!gate.allowed) { core.audit({ ev: 'dvoice_drop', user: userId, reason: gate.reason }); return; }   // ALLOWLIST before the brain
    if (vlib.isBargeIn(state, gate)) { try { player.stop(true); } catch {} state = vlib.next(state, 'barge-in'); }
    if (state === 'thinking' || state === 'speaking') return;           // single-flight
    const opusStream = connection.receiver.subscribe(userId, { end: { behavior: voice.EndBehaviorType.AfterSilence, duration: 800 } });
    const wav = await opusToWav(prism, opusStream, path.join(TMP, 'utt-' + userId + '.wav'));
    if (!wav) return;
    const text = core.transcribeLocal(wav).trim(); if (!text) return;
    state = vlib.next(state, 'utterance');
    core.audit({ ev: 'dvoice_turn', user: userId, role: gate.principal.role, chars: text.length });
    let reply = ''; try { reply = await core.askDaemon(text, 'discord', gate.principal); } catch {}
    await speak(reply || 'Sorry, I did not catch that.');
  }

  client.once('ready', () => {
    const connection = voice.joinVoiceChannel({ channelId, guildId, adapterCreator: client.guilds.cache.get(guildId).voiceAdapterCreator, selfDeaf: false, selfMute: false });
    connection.subscribe(player);
    state = vlib.next(state, 'join');
    connection.receiver.speaking.on('start', (userId) => {
      if (busy.has(userId)) return; busy.add(userId);
      onUtterance(userId, connection).catch(() => {}).finally(() => busy.delete(userId));
    });
    process.stdout.write('Urfael is in the voice channel, listening (allowlisted speakers only)\n');
  });
  client.login(token).catch((e) => { process.stderr.write('discord login failed: ' + ((e && e.message) || e) + '\n'); process.exit(1); });
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

if (require.main === module) main();
module.exports = { loadStack, synthesize, opusToWav };
