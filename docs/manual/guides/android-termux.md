# Run on Android with Termux

Urfael's daemon and CLI are plain Node, so they run under [Termux](https://termux.dev) on Android. A portability layer (`app/platform.js`) detects the host and adapts the platform-specific bits, so the same code that runs on macOS and Linux also runs on a phone.

```bash
# in Termux
pkg install nodejs git ffmpeg
git clone https://github.com/Grandillionaire/urfael && cd urfael/app
npm install
node cli.js setup
```

## What the portability layer does

`app/platform.js` is a small, unit-tested module that detects whether it is on macOS, Linux, WSL, Windows, or Termux, and returns the right way to do platform-specific things:

- **Notifications**: `termux-notification` on Android (vs `osascript` on macOS, `notify-send` on Linux).
- **Local TTS**: `termux-tts-speak` (vs `say` / `espeak-ng`).
- **Capabilities**: on Termux it reports `sms` and `telephony` as available (through the `termux-api` package) and `docker` as not, so the rest of the system gates on a flag instead of re-sniffing the OS.

Install the Termux API bridge for notifications, TTS, SMS, and telephony:

```bash
pkg install termux-api      # plus the Termux:API app from F-Droid
```

## What works, and what does not

- **The brain, memory, recall, channels, scheduling**: all Node, all run under Termux.
- **No Docker on Android**: the autonomous-coding goal loop's Docker sandbox is unavailable, so use the SSH backend (run the sandbox on a remote host) or leave that feature off. The platform layer reports `hasDocker: false` so this is explicit, not a surprise.
- **Voice**: speech out works through `termux-tts-speak`; whisper STT needs a build that runs on the device.

## Honest status

The portability layer and its detection are unit-tested, and the install path is documented. A phone actually hosting Urfael end to end (a real Termux device running the daemon, the bridges, and voice) is the remaining certification step. The detection logic and the platform-specific argv are correct and tested; the live device run is not something this repository can prove for you yet.

## Related

- [using/configuration.md](using/configuration.md)
- [guides/coding.md](guides/coding.md)
