# Quickstart

This page gets you from a fresh install to a real answer in about five minutes. It assumes you have already cloned the repo and run `./install.sh`. If you have not, start with [Installation](start/install.md).

## 1. Run setup

`urfael setup` is the onboarding wizard. It asks how the brain should reach a model and writes that choice down. There are three paths:

- **Subscription (the default).** Urfael shells out to your installed `claude` CLI, so it rides your existing Claude Code login. No API key, nothing to connect. If `claude` already works in your terminal, this works.
- **API key.** Paste an Anthropic API key and pay per token instead of using a subscription. Same Urfael, metered cost. Note: if `ANTHROPIC_API_KEY` is already in your environment, it overrides the subscription.
- **Local model.** Point at a local model (Ollama, LM Studio, NVIDIA NIM) through a translating proxy. A local model is not Claude-grade, and that tradeoff is yours to make. The full guide is [Run on your own GPU](guides/local-gpu.md).

```bash
urfael setup
```

Setup also lets you choose between Fortress mode (the default, read-only remote turns with no egress) and Full mode. Leave it on Fortress unless you have read the [security model](security/model.md).

## 2. Ask your first question

`ask` is the default verb, so you do not type it. Put the question in quotes. The answer streams back live, with one line of tool activity as it works.

```bash
urfael "what's on my calendar today?"
```

A longer request works the same way:

```bash
urfael "summarise the thread with Stefan and draft a reply"
```

Press `Ctrl+C` to abort a turn in progress (or run `urfael stop` from another terminal).

## 3. Open the cockpit

`urfael tui` is a full-screen terminal cockpit: the streamed transcript, live tool activity, a status bar, and scrollback. Press `Esc` to stop a turn. Type `/` for a command palette that filters as you go, so you do not have to remember command names.

```bash
urfael tui
```

## 4. Check health

Two commands tell you whether things are working. `urfael doctor` is a health read where every red line carries its own one-command fix. `urfael status` is the Hearth: a live vitals card with the model, seven-day token use, uptime, and an estimated spend (the spend rate is an estimate, env-overridable, never asserted as fact).

```bash
urfael doctor
urfael status
```

If `doctor` flags the daemon as not running, the always-on brain needs loading. On macOS:

```bash
launchctl load -w ~/Library/LaunchAgents/com.urfael.daemon.plist
```

On Linux it is `systemctl --user enable --now urfael-daemon`. The full daemon and service detail is in [Installation](start/install.md).

## Where to next

That is first value. To go deeper in a sensible order, follow the [Learning path](start/learning-path.md). For a map of what the tool can do, read the [Features overview](features/overview.md).
