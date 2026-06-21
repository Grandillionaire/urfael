# Configuration

Urfael has two layers of configuration, and you rarely touch more than a few values.

1. The onboarding wizard (`urfael setup`) writes a small file for you.
2. `URFAEL_*` environment variables tune behaviour. The daemon reads them, and forwards a fixed set to every brain spawn (live turns, chat, cron, the heartbeat), so a setting holds everywhere, not just in the foreground.

Most people run the wizard once and never edit a file by hand.

## The wizard writes `provider.env`

`urfael setup` is a plain CLI wizard. It asks how Urfael reaches Claude (your subscription, an API key, or a local model via a proxy), offers semantic recall and Fortress/Full mode, and writes the answers to:

```bash
~/.claude/urfael/provider.env   # mode 0600, may hold an API key
```

It is written atomically at `0600` because it can contain an `ANTHROPIC_API_KEY`. The wizard reads the existing file first and edits it non-destructively, so re-running setup to switch one thing leaves the rest alone. After it writes, it offers to restart the daemon so the running brain picks up the change. If your daemon is not managed by a service, the new config is used on the next start.

Re-run the wizard anytime to switch modes:

```bash
urfael setup
```

## Environment variables tune behaviour

Anything `provider.env` holds is an environment variable, and you can also set `URFAEL_*` vars yourself (in your shell, or in the service file). The handful most people touch:

| Variable | What it does | Default |
|---|---|---|
| `URFAEL_MODE` | `fortress` (remote turns read-only, no web, no write) or `full` (remote owner/member turns gain web reach, still no shell/write/bypass). | `fortress` |
| `URFAEL_ACTIVE_RECALL` | Active recall injects relevant past turns and lessons before each owner turn. Set to `0` to turn it off. | on |
| `URFAEL_OPUS_MODEL` | Which model the Opus tier maps to. On a Pro plan (no Opus), set this to `sonnet`. | `opus` |
| `URFAEL_SONNET_MODEL` | Which model the Sonnet tier maps to. | `sonnet` |
| `URFAEL_THEME` | Console and orb theme: `sigil`, `rune`, `ember`, `eye`. | `sigil` |

`URFAEL_MODE` and the model tiers are exactly what the wizard sets for you. Active recall and theme you can flip at will. The Console writes `URFAEL_THEME` for you when you pick a theme in its settings, so you do not have to edit anything to change the look.

Setting any of these by hand looks like this:

```bash
export URFAEL_OPUS_MODEL=sonnet     # Pro plan, no Opus access
export URFAEL_ACTIVE_RECALL=0       # turn active recall off
```

For how active recall actually works, see features/memory.md. For Fortress vs Full, see security/modes.md.

## Channel secrets live in `bridge.env`

Bot tokens and channel credentials do not go in `provider.env`. They live in a separate file you create yourself:

```bash
~/.claude/urfael/bridge.env   # chmod 600, never committed
```

Copy `config/bridge.env.example` to that path, fill in only the channels you use (a Telegram bot token, your owner id, and so on), and `chmod 600` it. This file is gitignored. It is deliberately kept apart from the brain: the autonomous sandbox never mounts it, so a sandboxed turn cannot read your tokens. See channels/setup.md for the per-channel keys.

## The full list

The table above is the short list. Urfael reads many more `URFAEL_*` variables (budgets, sandbox image, heartbeat cadence, TUI styling, price overrides, and more). The complete, current list lives in the Configuration reference: reference/config.md.
