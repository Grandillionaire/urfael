# Urfael — Setup Guide

> Read **[../SECURITY.md](../SECURITY.md)** before enabling hands/eyes, the autonomous loop, or full permissions.

macOS only (for now). The `install.sh` at the repo root does most of this; the steps below are the detail.

## 1. Prerequisites
- **Claude Code on a paid plan (Pro or Max).** Run `claude` once and sign in *before* starting Urfael.
  The brain just shells out to your `claude` CLI, so it runs on that subscription — there's **no API key
  and nothing to "connect."** If `claude` works in your terminal, the daemon works. (Gmail/Calendar/Drive
  connectors come from your account.)
- **Node 18+**, **uv**, **coreutils** (`brew install coreutils` → `gtimeout`), **Python 3 + matplotlib**
  (`pip3 install --user matplotlib numpy`).
- **Local voice (free, default):** `brew install ffmpeg whisper-cpp` — `say` is built in; the installer
  downloads the ~142 MB speech model. **No API key needed.**
- **Obsidian** + the **Local REST API** community plugin.
- Optional paid/extra: **ElevenLabs** (premium voice), **Picovoice** (wake word — built-in keywords or a custom-trained "Urfael" `.ppn`), free data APIs (Tavily, etc.).

## 2. Run the installer
```bash
./install.sh
```
It checks deps, writes `~/.claude/urfael/{tts.env,api-keys.env}` from the examples (chmod 600), scaffolds
`~/Urfael` from the template (with a `.claude → _urfael` symlink), creates a private local `~/Urfael-memory`
git repo, runs `npm install`, and writes the launchd plists (without loading them).

## 3. Configure
- **Voice (works out of the box, free & local):** the default is macOS `say` (TTS) + whisper.cpp (STT) —
  nothing to configure. In `~/.claude/urfael/tts.env` you can set `SAY_VOICE` (run `say -v '?'` to list
  voices) or `WHISPER_MODEL=small.en` for better accuracy.
  - *Higher-quality local voice (optional):* run [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)
    on `:8880` and set `TTS_PROVIDER=kokoro`.
  - *Premium (optional, paid):* set `TTS_PROVIDER=elevenlabs` + `STT_PROVIDER=elevenlabs` and add your
    `ELEVENLABS_API_KEY` (use a **premade** voice — premade voices don't drift).
  - *Acknowledgments:* while it works on a slow answer, Urfael says a short "On it, sir." instead of
    leaving silence. Disable with `URFAEL_ACKS=0` in `tts.env`.
- **Persona:** fill `{{USER_NAME}}` / `{{CITY}}` / `{{TIMEZONE}}` / `{{LANGUAGE}}` in `~/Urfael/CLAUDE.md`.
- **Obsidian:** open `~/Urfael` as a vault → Settings → Community plugins → enable → install *Local REST API*
  → copy its API key → register it:
  ```bash
  cd ~/Urfael && claude mcp add -s local --transport http obsidian \
    http://127.0.0.1:27123/mcp/ --header "Authorization: Bearer <REST_KEY>"
  ```

## 4. Run it
```bash
launchctl load -w ~/Library/LaunchAgents/com.urfael.daemon.plist   # the always-on brain
cd app && npm start                                                # the overlay UI
```
The orb appears bottom-right. Tap it to talk, or set a Picovoice key for a spoken wake word: any built-in keyword via `WAKE_KEYWORD` (default "Computer"), or a custom "Urfael" keyword — train it free at console.picovoice.ai, save the `.ppn`, and set `WAKE_KEYWORD_PATH` in `tts.env`.
`⌘⇧U` show/hide · `⌘⇧H` expands the HUD · `⌘⇧T` changes the look · `⌘⇧Q` full shutdown.

Optional background jobs (opt-in): `com.urfael.morningbrief` (8am brief), `com.urfael.obsidian-heal`
(keeps the Obsidian connection alive).

### Models & plans
The brain uses Claude Code's model **aliases** — `sonnet` for most turns, escalating to `opus` for hard
ones (code, deep reasoning). Aliases always resolve to the latest model your plan supports, so nothing
breaks when Anthropic ships a new version. **Opus access requires a Max plan** — on **Pro**, set
`URFAEL_OPUS_MODEL=sonnet` so escalation stays on Sonnet instead of failing. You can also pin exact ids
(e.g. `URFAEL_OPUS_MODEL=claude-opus-4-8`). Set these in the daemon plist's `EnvironmentVariables`
(next to `URFAEL_YOLO`), the same place you set any other daemon env var.

## 5. Enabling hands, eyes & autonomy (opt-in — read SECURITY.md)
- **Computer-use MCPs** (browser/desktop/vision): see `config/mcp.json.example`. macOS will prompt for
  Accessibility / Automation / Screen Recording the first time the agent uses them — grant once.
- **Full permissions:** set `URFAEL_YOLO=1` (in the daemon plist's `EnvironmentVariables`, or your env).
  ⚠️ This is an unrestricted shell agent — run it in a VM / container / throwaway account.
- **Autonomous `/goal` loop:** requires an explicit `--repo` pointing at an isolated git worktree.

## 6. Remote control from your phone — Telegram / Discord (opt-in)
Talk to Urfael from anywhere. Remote turns are **sandboxed**: owner-allowlisted, never `bypassPermissions`
(even with `URFAEL_YOLO=1`), no computer-use, **read-only with no network egress** (vault read + search;
no writes, no shell, no web) — see SECURITY.md. Web lookup / phone capture are opt-in widenings in `app/lib.js`.

1. Put your bot token(s) + your own chat/user id in `~/.claude/urfael/bridge.env` (the installer scaffolds
   it from `config/bridge.env.example`; that file has the step-by-step for getting each value). `chmod 600`.
2. Load the bridge(s) — they were written to `~/Library/LaunchAgents` by the installer but not started:
   ```bash
   launchctl load -w ~/Library/LaunchAgents/com.urfael.telegram.plist   # Telegram (Node 18+)
   launchctl load -w ~/Library/LaunchAgents/com.urfael.discord.plist    # Discord (Node 22+, MESSAGE CONTENT intent)
   ```
3. DM your bot. Only your single allowlisted id is ever answered; everyone else is dropped before the brain
   sees anything. Every turn is appended to `~/.claude/urfael/bridge-audit.log` and rate-limited.

Once a bridge is configured, autonomous jobs and the morning brief also **push to your phone** when they
finish (one-way, owner-only — there's no way to make it message anyone else).

## 7. Reminders & heartbeat (the proactive layer)

**Reminders need zero setup.** Say "remind me in 20 minutes to call Stefan" (or type it) — Urfael schedules
it in the daemon and it fires as a macOS notification + spoken aloud + a phone push (if a bridge is
configured), even with every window closed. Reminders persist across daemon restarts. Inspect them:
```bash
curl -s --unix-socket ~/.claude/urfael/daemon.sock http://x/reminders
curl -s -X POST --unix-socket ~/.claude/urfael/daemon.sock http://x/reminder/<id>/cancel
```

**Heartbeat (opt-in).** Set `URFAEL_HEARTBEAT_MINS` (e.g. `30`) in the daemon plist's
`EnvironmentVariables` and Urfael periodically runs the checklist in `~/Urfael/HEARTBEAT.md` — upcoming
events, urgent email, piling-up inbox, slipping deadlines — and **stays silent unless something needs
you** (the `HEARTBEAT_OK` contract). It skips beats while you're actively talking to it and respects
`URFAEL_HEARTBEAT_HOURS` (default `8-23`) so it never pipes up at 3am. Edit `HEARTBEAT.md` to control
exactly what it watches; keep it short — every line costs tokens on every beat.

## 8. Background jobs (so long work doesn't tie up the conversation)
Ask Urfael (by voice or chat) to run something in the background and it dispatches a detached, cancellable
job via the `/job` command. Coding jobs run through the guard-railed `/goal` loop (isolated `--repo`, never
pushes); research jobs run sandboxed and drop a note in your vault. Manage them over the socket:
```bash
curl -s --unix-socket ~/.claude/urfael/daemon.sock http://x/jobs                 # list
curl -s --unix-socket ~/.claude/urfael/daemon.sock http://x/job/<id>             # status + log tail
curl -s -X POST --unix-socket ~/.claude/urfael/daemon.sock http://x/job/<id>/cancel
```

## Permissions Urfael may ask macOS for
Microphone (voice), and — only if you enable computer-use — Accessibility, Automation, Screen Recording,
Calendars, Reminders. Grant them to the app/terminal hosting the agent.

## Updating / uninstalling
- Update: `git pull && cd app && npm install`.
- Uninstall: `launchctl unload` the `com.urfael.*` plists and delete them; remove the cloned repo (NOT your `~/Urfael` vault — different capitalisation). Your
  `~/Urfael` vault and `~/Urfael-memory` are yours to keep or delete.
