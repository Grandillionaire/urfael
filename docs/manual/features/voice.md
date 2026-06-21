# Voice

Urfael listens and speaks on your own machine. whisper.cpp turns your speech into text, macOS `say` (or a local Kokoro server) turns Urfael's reply into audio, and by default nothing audio-related leaves the box. No cloud speech-to-text, no cloud text-to-speech, no API key.

This page describes what the voice code actually does (`app/voice.js`, `app/wake-worker.js`, `app/main.js`). Where a tier is opt-in or a feature needs setup, it says so.

## How a spoken turn works

When the brain answers, it writes two things in one stream. A short `[SPOKEN]...[/SPOKEN]` remark (one or two sentences, plain text) and the full written answer. The daemon streams the remark out sentence by sentence as it arrives, so the voice starts before the whole reply is done, while the renderer shows the written answer on screen and strips the `[SPOKEN]` tag from what you read. So you hear a brief spoken summary and read the complete answer.

The spoken text is hard-capped at 700 characters per turn (`MAX_SPOKEN_CHARS` in `app/daemon.js`), so a runaway or unclosed block can never read an entire long answer aloud. If a reply has no `[SPOKEN]` tags at all, Urfael speaks one short opening line as a fallback rather than going silent.

The Console speaks the remark aloud by default. Set `CONSOLE_VOICE=0` to keep replies on screen only.

## Speech to text: whisper.cpp

The default transcriber is whisper.cpp, running locally as a warm `whisper-server` the daemon supervises. Your recorded audio (WebM from the renderer) is converted to 16 kHz mono WAV with ffmpeg, posted to `127.0.0.1:8462` (`STT_PORT`), and returned as text. The server is auto-respawned with backoff if it crashes, so a single failure does not leave Urfael deaf.

The model defaults to `base.en` and is read from `~/.claude/urfael/models/ggml-base.en.bin`, fetched (checksum-pinned) by `install.sh`. If the model file is missing, the app tells you to run `install.sh`. Set `WHISPER_MODEL` to use a different size, for example `small.en` for higher accuracy.

This path needs two binaries: `whisper-cpp` and `ffmpeg`. The error messages name them directly when one is absent.

## Text to speech tiers

| Tier | Engine | Cost |
|---|---|---|
| Default | macOS `say`, or Linux `espeak-ng`/`espeak` | free, offline, no key |
| Local upgrade | Kokoro-FastAPI on `localhost:8880` (`TTS_PROVIDER=kokoro`) | free, one extra service |
| Premium | ElevenLabs (`TTS_PROVIDER=elevenlabs`, paid key) | paid, opt-in |

All three return MP3 bytes that the renderer plays through its audio graph, which is what keeps the orb HUD reactive. On macOS, `say` output is piped through ffmpeg to MP3, so ffmpeg is required for the default tier too. `SAY_VOICE` and `SAY_RATE` tune the voice and words-per-minute.

Kokoro is a local, no-auth, OpenAI-compatible server you run yourself; if it is not running, the error tells you to start it or fall back to `TTS_PROVIDER=say`. ElevenLabs is the only paid tier and is handled in the renderer with your `ELEVENLABS_API_KEY`. Everything else stays on-device.

## Wake word: Porcupine

A spoken wake word is optional and off until you set it up. It uses Picovoice Porcupine (`app/wake-worker.js`), listening on-device in its own thread with no transcription and no cloud, and posting a message only on a detection.

It needs a Picovoice access key in `PICOVOICE_ACCESS_KEY`. With no key set, wake-word listening is simply skipped. The default keyword is `Computer`, and any built-in Porcupine keyword works out of the box via `WAKE_KEYWORD`. For a custom "Urfael" word, train a `.ppn` file free at console.picovoice.ai and point `WAKE_KEYWORD_PATH` at it. The custom file takes precedence over any built-in keyword. When the renderer records, the worker pauses to free the microphone, then resumes.

## Platform support, honestly

macOS is the primary, best-tested target: `say` ships with the OS. On Linux, TTS uses `espeak-ng` (preferred) or `espeak`, which sounds plainer than `say` and ignores macOS-style voice names; the Linux paths have far less mileage. The voice synthesis path is exercised end-to-end by the test harness (`npm run e2e`), but real-world Linux audio has seen fewer hours than macOS.

## Discord voice channels

Urfael can join a Discord voice channel and talk: the bot listens, transcribes with the same local whisper, answers, and speaks the reply into the channel. It reuses the local pipeline end to end, so nothing audio-related leaves the machine, unlike voice modes that ship your text to a cloud TTS to be synthesized.

```bash
node app/bridge/discord-voice-bridge.js
```

The security model is the point. Anyone can sit in a Discord voice channel, but only an enrolled speaker's audio is ever transcribed and sent to the brain. The speaker gate is the same fail-closed allowlist as every other channel: a stranger in the call is acoustically present and completely powerless, the bot ignores its own audio, and an optional `DISCORD_VOICE_OWNER_ONLY=1` restricts it to you. The owner can barge in to interrupt a reply. Set `DISCORD_TOKEN`, `DISCORD_VOICE_GUILD_ID`, and `DISCORD_VOICE_CHANNEL_ID` in `bridge.env`, then add yourself with `urfael team add discord <your-user-id>`.

The pure orchestration (the speaker gate, the speech shaping, the listen/think/speak state machine) is unit-tested and the allowlist is frozen as a benchmark check. The heavy `@discordjs/voice` and opus stack is an optional dependency, so the core stays dependency-free: the bridge prints the exact `npm install discord.js @discordjs/voice prism-media @discordjs/opus libsodium-wrappers` line if they are missing. Honest status: code-complete and unit-tested; the live voice-channel round-trip (a real bot in a real channel, with the optional packages, ffmpeg, and a local TTS) is the remaining certification.

## Setup pointers

- The default voice tier installs with `brew install ffmpeg whisper-cpp` on macOS (Linux: `ffmpeg` plus `espeak-ng`, and build whisper.cpp).
- Configurable values (`SAY_VOICE`, `SAY_RATE`, `TTS_PROVIDER`, `STT_PROVIDER`, `WHISPER_MODEL`, `KOKORO_VOICE`, `WAKE_KEYWORD`) live in `~/.claude/urfael/bridge.env` and several are settable from Settings.
- Full voice setup, including the Kokoro and ElevenLabs tiers, is in [SETUP.md on GitHub](https://github.com/Grandillionaire/urfael/blob/main/docs/SETUP.md).

See also start/quickstart.md to get the Console running, and features/memory.md for how spoken turns are archived and recalled like any other.
