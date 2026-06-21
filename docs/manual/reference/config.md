# Configuration reference

Every knob Urfael reads is a `URFAEL_*` environment variable. There is no config file format to learn. Set a variable in your shell, in the service unit, or let `urfael setup` write the ones it manages into `~/.claude/urfael/provider.env` (mode `0600`, since it may hold an API key).

The defaults are safe. Almost everything optional is off until you set it: an unset budget never blocks a turn, semantic recall stays lexical, the heartbeat sleeps, and remote turns stay read-only. You can run Urfael with none of these set.

Two notes before the tables:

- Auth variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`) are not in the `URFAEL_*` namespace. They are written by `urfael setup` and read by the `claude` CLI directly. See [features/models.md](features/models.md).
- A few variables still accept a legacy `JARVIS_*` spelling as a fallback (the project's former name). Prefer `URFAEL_*`.

## Core

| Variable | Description | Default |
|---|---|---|
| `URFAEL_MODE` | `fortress` or `full`. Fortress keeps remote (chat) turns read-only with no web. Full lets remote owner/member turns browse and search the web, still no write, no shell, no bypass. | `fortress` |
| `URFAEL_MEMORY_DIR` | Directory name under your home for the private memory git repo. | `Urfael-memory` (so `~/Urfael-memory`) |
| `URFAEL_VAULT_DIR` | Directory name under your home for the Obsidian vault. | `Urfael` (so `~/Urfael`) |
| `URFAEL_CLAUDE_BIN` | Path to the `claude` CLI binary to spawn. | first of `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, `/usr/bin/claude` |
| `URFAEL_PERMISSION_MODE` | Permission mode passed to `claude` for owner turns when YOLO is off. | `acceptEdits` |
| `URFAEL_YOLO` | Set to `1` to give the agent an unrestricted shell (`bypassPermissions`). Off by default. Run it only in a VM, container, or throwaway account. | unset (off) |

> When `URFAEL_YOLO=1` the daemon logs a warning on startup. This mode also reads untrusted email and web. Read [security/model.md](security/model.md) first.

## Memory and recall

| Variable | Description | Default |
|---|---|---|
| `URFAEL_ACTIVE_RECALL` | Set to `0` to disable per-turn active recall (the fenced "recalled memory" block injected before owner turns). | on (off only if `0`) |
| `URFAEL_EMBED_URL` | An OpenAI-compatible `/v1/embeddings` endpoint. Setting it turns on hybrid (BM25 plus semantic) recall. Unset means lexical BM25 only. | unset (off) |
| `URFAEL_EMBED_MODEL` | The embedding model name sent to that endpoint. | none in code; `urfael setup` writes `nomic-embed-text` |
| `URFAEL_EMBED_KEY` | Optional bearer token for the embeddings endpoint. | unset |
| `URFAEL_USERMODEL` | Set to `1` for the per-turn user-model dialectic (theory-of-mind into `USER.md`). | unset (off) |
| `URFAEL_USERMODEL_EVERY` | Run the user-model pass every Nth local turn. | `1` |
| `URFAEL_REVIEW` | Set to `1` for a per-turn background review pass. | unset (off) |
| `URFAEL_REVIEW_EVERY` | Run the review pass every Nth local turn. | `1` |
| `URFAEL_CURATOR_DAYS` | Skill-curator interval in days. An explicit `0` disables it. | `7` |
| `URFAEL_PREDICT` | Set to `1` to let the heartbeat act on `USER.md` "likely next" predictions (surface only). | unset (off) |

Recall fails soft: if the embedder is slow or down, it falls back to BM25 and never breaks a turn. See [features/memory.md](features/memory.md).

## Models

| Variable | Description | Default |
|---|---|---|
| `URFAEL_OPUS_MODEL` | Model alias or exact id for the Opus tier (code and deep reasoning). On a Pro plan with no Opus access, set this to `sonnet`. | `opus` |
| `URFAEL_SONNET_MODEL` | Model alias or exact id for the Sonnet tier (most turns). | `sonnet` |

These follow Claude Code's model aliases, so they track the latest models your plan supports. See [features/models.md](features/models.md).

## Budget guardrail

The budget is dormant unless you set `URFAEL_BUDGET_TURNS` or `URFAEL_BUDGET_TOKENS`. It counts turns and tokens over a rolling window. It never fabricates dollars, and an unconfigured budget never blocks the assistant (fail open).

| Variable | Description | Default |
|---|---|---|
| `URFAEL_BUDGET_TURNS` | Max turns in the window. A non-positive value is ignored. | unset (no turn cap) |
| `URFAEL_BUDGET_TOKENS` | Max tokens in the window. | unset (no token cap) |
| `URFAEL_BUDGET_WINDOW_H` | Window length in hours, clamped to 168. | `5` (the Claude usage window) |
| `URFAEL_BUDGET_WARN_PCT` | Percent of either cap at which it warns, clamped to 1 to 100. | `80` |
| `URFAEL_BUDGET_HARD` | Set to `1` to refuse new turns once a cap is hit. Otherwise it only warns. | unset (warn only) |

## Ports

All three surfaces below bind `127.0.0.1` only. The brain itself opens no TCP port (unix socket only); these are opt-in loopback servers.

| Variable | Description | Default |
|---|---|---|
| `URFAEL_API_PORT` | Port for the OpenAI-compatible API (`urfael serve`). | `7720` |
| `URFAEL_DASHBOARD_PORT` | Port for the web dashboard (`urfael dashboard`). | `7717` |
| `URFAEL_HOOKS_PORT` | Port for the webhook receiver (`urfael hooks`). | `7718` |

## Scheduling

| Variable | Description | Default |
|---|---|---|
| `URFAEL_HEARTBEAT_MINS` | Heartbeat interval in minutes. `0` disables the heartbeat entirely. | `0` (off) |
| `URFAEL_HEARTBEAT_HOURS` | Hour range (local) in which the heartbeat may run, as `start-end`. | `8-23` |
| `URFAEL_SCRIPT_CRON` | Set to `1` to allow owner-authored no-LLM shell cron jobs. Off by default, like YOLO, because scheduling a shell command is real power. | unset (off) |
| `URFAEL_TURN_TIMEOUT_S` | Per-turn watchdog in seconds, clamped to 30 to 900. Long work belongs in a `/job`, not a turn. | `120` |

See [features/automation.md](features/automation.md).

## TUI appearance

These control `urfael tui` (and the orb shares `URFAEL_THEME`). They are read once at startup. You can also cycle theme and animation live inside the TUI; that is in-memory only.

| Variable | Description | Default |
|---|---|---|
| `URFAEL_THEME` | Theme for the orb HUD, and the fallback for the TUI theme. | `gold` |
| `URFAEL_TUI_THEME` | TUI theme: `gold`, `ember`, `mono`, or `custom`. Falls back to `URFAEL_THEME`. | `gold` |
| `URFAEL_TUI_ACCENT` | Accent colour (0 to 255) used only when the theme is `custom`. | none |
| `URFAEL_TUI_ANIM` | Spinner animation: `oracle`, `rune`, `ember`, `braille`, `scry`, or `shimmer`. An unknown value falls back to `oracle`. | `oracle` |
| `URFAEL_TUI_FPS` | Animation frame rate, clamped to 4 to 20. | `12` |
| `URFAEL_TUI_COMPACT` | Set to `1`/`on`/`true` for a denser layout. | off |
| `URFAEL_TUI_TIMESTAMPS` | Set to `1`/`on`/`true` to show per-line timestamps. | off |
| `URFAEL_TUI_REDUCE_MOTION` | Force-disable animation (`1`/`on`) or force-enable (`0`/`off`). Unset auto-detects from `NO_COLOR`, `CI`, a dumb `TERM`, or no TTY. | auto |

Outside a TTY the TUI emits no colour codes at all, and `NO_COLOR` strips colour as you would expect.

## Pricing (cost estimate)

Urfael runs on a flat-rate subscription, so there is nothing to meter. The cost figures in `urfael status` and the dashboard are an estimate from these per-million-token rates, and the daemon labels them as an estimate, never as fact. Under a local model or a proxy the meter reads `$0`.

| Variable | Description | Default |
|---|---|---|
| `URFAEL_PRICE_SONNET_IN` | Sonnet input price per million tokens. | `3` |
| `URFAEL_PRICE_SONNET_OUT` | Sonnet output price per million tokens. | `15` |
| `URFAEL_PRICE_OPUS_IN` | Opus input price per million tokens. | `5` |
| `URFAEL_PRICE_OPUS_OUT` | Opus output price per million tokens. | `25` |

## Where these live

`urfael setup` writes the auth and recall and mode choices into `~/.claude/urfael/provider.env`. Anything else you can export in your shell or add to the service unit (launchd plist on macOS, the `systemd --user` unit on Linux). The full first-run path is in [start/quickstart.md](start/quickstart.md). The setup wizard source is at [app/setup.js](https://github.com/Grandillionaire/urfael/blob/main/app/setup.js).
