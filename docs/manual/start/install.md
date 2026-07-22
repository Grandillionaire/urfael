# Installation

Urfael is an always-on local brain that runs your installed `claude` CLI as a subprocess. There is no API key and nothing to connect: if `claude` works in your terminal, Urfael works. This page covers what you need and the two ways to install. When you are done, go to [start/quickstart.md](start/quickstart.md).

## Prerequisites

- **Claude Code on a paid plan (Pro or Max), signed in.** Run `claude` once and log in before you start Urfael. The brain shells out to that CLI, so it rides your existing subscription. (Opus escalation needs Max. On Pro, set `URFAEL_OPUS_MODEL=sonnet` so hard turns stay on Sonnet instead of failing.)
- **Node 20 or newer.** `app/package.json` declares `"engines": { "node": ">=20" }`, the single source of truth for the floor.
- **An operating system Urfael supports.** macOS on Apple Silicon or Intel is the primary, best-tested target. Linux runs the headless brain and the Electron GUI, but it is newer and has far less mileage. **Native Windows is supported in beta**: `install.ps1` installs the daemon + CLI (the control plane rides a per-user named pipe with a required token instead of the POSIX 0600 socket), and the full unit/fuzz/red-team suite gates it in CI on every push. WSL remains fully supported and is the path to the POSIX-only extras (docker/ssh goal sandboxes, host-reaching plugin cells).
- **Obsidian** with its Local REST API community plugin, for the vault.
- For local voice (the free default): `ffmpeg`, `whisper-cpp`, and `coreutils` on macOS. The installer downloads the speech model (checksum-pinned). Docker is optional and only needed for sandboxed autonomous coding.

One Homebrew line covers the local-voice tools on macOS:

```bash
brew install ffmpeg whisper-cpp coreutils
```

## Path 1: run from source in `app/`

This is the recommended path because the installer is read-it-first friendly. It never auto-installs heavy software and never enables anything risky on your behalf.

```bash
git clone https://github.com/Grandillionaire/urfael.git && cd urfael
./install.sh        # checks deps, fetches the speech model, scaffolds your vault, writes config templates
urfael setup        # onboarding wizard: subscription (default), an API key, or a local model
cd app && npm start # the Console opens
```

`install.sh` writes config templates (`chmod 600`), scaffolds the vault and memory repo, runs `npm install`, links the `urfael` CLI onto your PATH, and writes the service files (launchd on macOS, `systemd --user` on Linux) without loading them. You start the daemon yourself in [start/quickstart.md](start/quickstart.md).

If you prefer a one-liner, a bootstrap clones the repo and runs `install.sh` for you. It is deliberately short so you can read it first.

```bash
curl -fsSL https://raw.githubusercontent.com/Grandillionaire/urfael/main/get.sh | bash
```

### Native Windows (beta)

The same path, in PowerShell. Do not double-click `install.sh` — that is the macOS/Linux installer; Windows has its own:

```powershell
git clone https://github.com/Grandillionaire/urfael.git; cd urfael
powershell -ExecutionPolicy Bypass -File .\install.ps1   # deps check, speech model + whisper-server (both SHA-pinned), vault, `urfael` on PATH
urfael setup                                              # same onboarding wizard (open a NEW terminal first so PATH refreshes)
cd app; npm start                                         # the Console opens
```

Or the one-line bootstrap, short enough to read first: `irm https://raw.githubusercontent.com/Grandillionaire/urfael/main/get.ps1 | iex`

Windows differences, stated plainly: the daemon's control plane is a per-user named pipe plus a required token file under your profile (the POSIX build uses a `0600` unix socket — same trust statement, different kernel); autostart is a Run-key command the installer prints but never adds for you; `--check` commands for goal jobs run under PowerShell; docker/ssh goal sandboxes and host-reaching plugin cells stay POSIX/WSL-only for now. The brain's `curl --unix-socket` examples become `node _urfael/daemonctl.js …` (the installer scaffolds it).

## Path 2: the packaged desktop app

The repo ships an `electron-builder` config in `app/package.json`. Building it produces a `.dmg` and `.zip` on macOS, an `AppImage` on Linux, and an NSIS installer on Windows:

```bash
cd app && npm run dist        # or npm run dist:dir for an unpacked build
```

Note plainly: the packaged app is the Console (the Electron overlay UI). It is a client of the same daemon, so you still install from source once to get the brain, the `urfael` CLI, and the service files. There is no published, signed download that sets up everything in one step today.

## What the installer creates on first run

- **`~/Urfael`**: your Obsidian vault, scaffolded from the template, with a `.claude` symlink to `_urfael`. This is the archive the brain reads.
- **`~/Urfael-memory`**: a private local git repo for what Urfael learns. Per-day conversation logs land in `~/Urfael-memory/sessions/` as JSONL.
- **`~/.claude/urfael/`**: config templates (`tts.env`, `api-keys.env`, and others) written from the examples at `chmod 600`.
- **The daemon socket**: once the daemon is running it listens only on a `0600` unix socket at `~/.claude/urfael/daemon.sock` (on native Windows: a per-user named pipe gated by `~/.claude/urfael/daemon.token`). No TCP port is opened on any OS.

The `~/Urfael` vault and `~/Urfael-memory` repo are yours. They are kept separate from the cloned source (note the capitalisation) so an uninstall of the code never touches your data.

## Next

The full setup detail (voice tiers, persona, Obsidian registration, connectors, bridges, Linux units) is in [SETUP.md on GitHub](https://github.com/Grandillionaire/urfael/blob/main/docs/SETUP.md). To start the daemon and say something, go to [start/quickstart.md](start/quickstart.md).
