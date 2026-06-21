<!-- AUTO-GENERATED from app/registry.js by docs/manual/reference/generate-cli.js. Do not edit by hand. -->

# CLI reference

Every command Urfael ships, generated straight from the source of truth so it always matches the binary. Run `urfael help` for the same list in your terminal, or `urfael help <command>` to drill into one.

Aliases are accepted everywhere the canonical name is. Hidden subcommands (folded under a parent here) work the same on the command line.

## Ask

_put a question to it_

### `urfael ask`

ask anything, the default verb; streams the answer live.

```bash
urfael "<your question>"
```

Examples:

```bash
urfael "what's on my calendar today?"
urfael "summarise the thread with Stefan and draft a reply"
```

See also: `sessions` · `stop`

### `urfael sessions`

full-text search of every past conversation.

```bash
urfael sessions search <query>
```

Examples:

```bash
urfael sessions search "railway token"
urfael sessions search invoice
```

See also: `why`

### `urfael stop`

abort the current in-flight turn (or Ctrl+C while it answers).

```bash
urfael stop
```

Examples:

```bash
urfael stop
```

See also: `shutdown`

## Memory

_what it knows about you, and where each belief came from_

### `urfael why`

trace a belief to the commit that set it, a checkable SHA.

```bash
urfael why "<a belief or fact you want sourced>"
```

Examples:

```bash
urfael why "prefers terse replies"
urfael why "Co-CEO of MYG Media"
```

See also: `drift` · `as-of` · `learn`

### `urfael drift`

how the model of you changed, added / revised / removed.

```bash
urfael drift [file] [--since <date>]
```

Examples:

```bash
urfael drift
urfael drift MEMORY.md --since "2026-05-01"
```

See also: `why` · `as-of`

### `urfael as-of`

reconstruct a memory file as of a past date (def USER.md).

```bash
urfael as-of <date> [file]
```

Aliases: `asof`

Examples:

```bash
urfael as-of "2026-05-01"
urfael as-of "2026-05-01" MEMORY.md
```

See also: `drift` · `why`

### `urfael learn`

the learning ledger, learned, verified, pruned, w/ confidence.

```bash
urfael learn [trusted|proposed|retired]
```

Examples:

```bash
urfael learn
urfael learn trusted
```

See also: `why` · `forget`

### `urfael forget`

remove matching beliefs + leave a provable git tombstone.

```bash
urfael forget ["<phrase>"]
```

Examples:

```bash
urfael forget "old office address"
urfael forget
```

See also: `learn` · `why`

### `urfael dataset`

export your runs + verified lessons as training data.

```bash
urfael dataset stats
urfael dataset export --format sft|atropos|lessons|all
  [--since <date>] [--channel <name>] [--model opus|sonnet] [--out <dir>] [--no-redact]
```

Aliases: `trajectories`

Examples:

```bash
urfael dataset stats
urfael dataset export --format sft --since "2026-05-01"
urfael dataset export --format all --out ~/urfael-dataset
```

See also: `learn` · `sessions` · `why`

## Schedule

_reminders, background jobs, and cron_

### `urfael remind`

set a reminder, once or repeating.

```bash
urfael remind "<text>" (--in <mins> | --at <iso>)
  [--repeat daily|weekly|<mins> | --days <list> | --cron <expr>]
```

Examples:

```bash
urfael remind "call the dentist" --in 20
urfael remind "standup" --at "2026-06-19T09:30" --repeat weekly
```

See also: `reminders` · `cron`

### `urfael reminders`

list scheduled reminders.

```bash
urfael reminders
```

Examples:

```bash
urfael reminders
```

See also: `remind`

### `urfael jobs`

list background jobs and their state.

```bash
urfael jobs | job <id> | cancel <id>
```

Examples:

```bash
urfael jobs
urfael job a1b2c3
urfael cancel a1b2c3
```

See also: `cron`

### `urfael cron`

run the brain (or a --script shell cmd) on a schedule.

```bash
urfael cron add "<prompt>" (--cron <expr> | --days <list> --at HH:MM |
  --daily-at HH:MM | --in N | --repeat daily) [--then "<prompt>"]
  [--script "<cmd>"] [--deliver notify|silent|push]
urfael cron list | cancel <id> | run <id>
```

Examples:

```bash
urfael cron add "brief me on overnight email" --daily-at 07:30
urfael cron add "poll the deploy" --cron "*/15 9-17 * * 1-5"
urfael cron list
```

See also: `remind` · `jobs` · `script`

## Team

_the roster, the activity trail, the seal_

### `urfael team`

manage the roster; `pair` mints a single-use guest code.

```bash
urfael team [add <channel> <id> [name] [owner|member|guest]
  | remove <channel> <id> | pair [channel] [--ttl <mins>]]
```

Examples:

```bash
urfael team
urfael team add telegram 12345 "Sam" member
urfael team pair telegram --ttl 60
```

See also: `audit` · `seal`

### `urfael audit`

team activity trail; --verify walks the Ledger of Record.

```bash
urfael audit [--json | --verify]
```

Examples:

```bash
urfael audit
urfael audit --verify
```

See also: `seal` · `team`

### `urfael seal`

owner ed25519 key signs the ledger head, attests, not proves.

```bash
urfael seal [--verify]
```

Examples:

```bash
urfael seal
urfael seal --verify
```

See also: `audit`

## Skills

_install and share skills (scanned, never executed)_

### `urfael skills`

your installed skills; install scans + previews, never runs.

```bash
urfael skills list | export <name> | scan <file>
  | install <https-url> [--yes]
```

Examples:

```bash
urfael skills list
urfael skills install https://example.com/skill.md
urfael skills scan ./draft.md
```

See also: `hub` · `import`

### `urfael hub`

browse the skill registry, scanned + sha-checked, never run.

```bash
urfael hub [search <term>] | install <slug> [--yes] | publish <file>
```

Examples:

```bash
urfael hub
urfael hub search calendar
urfael hub install daily-brief
```

See also: `skills`

### `urfael import`

migrate memory + skills from OpenClaw/Hermes (dry-run default).

```bash
urfael import [--from openclaw|hermes] [--path <dir>] [--apply]
```

Examples:

```bash
urfael import --from hermes
urfael import --from openclaw --apply
```

See also: `skills`

## Connect

_optional integrations via MCP, previewed, owner turns only_

### `urfael connect`

add MCP connectors, previewed, scanned, secrets masked.

```bash
urfael connect [search <term>] | info <id> | add <id> | remove <id> | installed
```

Aliases: `connectors`, `connector`, `integration`, `integrations`, `mcp`

Examples:

```bash
urfael connect
urfael connect search calendar
urfael connect add github
```

See also: `skills` · `hub`

## Plugins

_capability-scoped, sandboxed, signed extensions_

### `urfael plugin`

install, enable, scan + inspect sandboxed MCP plugins.

```bash
urfael plugin [list | scan <file> | info <file> | install <file>
  | enable <id> | disable <id> | secret <REF> | import <path> [--apply]]
```

Aliases: `plugins`

Examples:

```bash
urfael plugin list
urfael plugin scan ./plugin.json
urfael plugin import ./openclaw-plugin
```

See also: `connect` · `skills`

## Serve

_expose the brain, API, web console, webhooks_

### `urfael serve`

OpenAI-compatible local API (localhost only, token-gated).

```bash
urfael serve [--token]
```

Examples:

```bash
urfael serve
urfael serve --token
```

See also: `dashboard` · `hooks`

### `urfael dashboard`

open the token-gated localhost web console (prints the URL).

```bash
urfael dashboard
```

Examples:

```bash
urfael dashboard
```

See also: `serve` · `tui`

### `urfael tui`

full-screen terminal cockpit, turns, scrollback, status.

```bash
urfael tui
```

Examples:

```bash
urfael tui
```

See also: `dashboard` · `status`

### `urfael acp`

drive Urfael from an editor over ACP (stdio, no new port).

```bash
urfael acp [--probe]
```

Examples:

```bash
urfael acp
urfael acp --probe
```

See also: `serve` · `tui`

### `urfael council`

live multi-agent council, watch agents decompose + synthesize.

```bash
urfael council "<task>" [--agents N]
urfael council --list | --replay <id>
```

Examples:

```bash
urfael council "audit this repo for security gaps"
urfael council "compare 3 caching strategies" --agents 4
urfael council --list
```

See also: `tui` · `jobs`

### `urfael hooks`

start the loopback webhook receiver + print its URL.

```bash
urfael hooks
```

Examples:

```bash
urfael hooks
```

See also: `hook`

### `urfael hook`

register / list / remove webhook triggers; relay = two-way.

```bash
urfael hook add "<name>" [--action ask|notify|relay]
  [--reply-url <url> --reply-auth <hdr>] [--deliver notify|silent|push]
urfael hook list | rm <id>
```

Examples:

```bash
urfael hook add "deploy finished" --action notify
urfael hook list
```

See also: `hooks`

### `urfael script`

saved-script library; needs URFAEL_SCRIPT_CRON=1.

```bash
urfael script add <name> "<shell>" | run <name> [args…] | list | rm <name>
```

Examples:

```bash
urfael script add backup "tar czf ~/bak.tgz ~/work"
urfael script run backup
```

See also: `cron`

## System

_setup, health, and the daemon_

### `urfael setup`

onboarding wizard, pick subscription / API key / local model.

```bash
urfael setup
```

Aliases: `init`, `onboard`

Examples:

```bash
urfael setup
```

See also: `doctor` · `status`

### `urfael status`

the Hearth, model, 7-day tokens, facts, seal, uptime.

```bash
urfael status
```

Examples:

```bash
urfael status
```

See also: `doctor` · `tui` · `model`

### `urfael model`

pin a tier (opus/sonnet/auto) or switch the model provider.

```bash
urfael model [opus | sonnet | auto]
  | providers | use <id> [--big M --small M] | test <id>
```

Examples:

```bash
urfael model
urfael model providers
urfael model use ollama
```

See also: `status` · `persona`

### `urfael persona`

switch voice, architect/sage/operator/muse/analyst (or ask).

```bash
urfael persona [<id> | list | reset]
```

Examples:

```bash
urfael persona
urfael persona architect
urfael persona reset
```

See also: `model` · `status`

### `urfael doctor`

health read; every red line carries its own one-command fix.

```bash
urfael doctor
```

Examples:

```bash
urfael doctor
```

See also: `status` · `setup`

### `urfael health`

print the daemon health JSON.

```bash
urfael health
```

Examples:

```bash
urfael health
```

See also: `doctor` · `shutdown`

### `urfael shutdown`

stop the daemon, distinct from `stop` (aborts one turn).

```bash
urfael shutdown
```

Examples:

```bash
urfael shutdown
```

See also: `stop` · `health`

### `urfael logo`

print the Urfael terminal logo.

```bash
urfael logo
```

Examples:

```bash
urfael logo
```

### `urfael help`

this reference; `help <command>` drills into one command.

```bash
urfael help [command]
```

Examples:

```bash
urfael help
urfael help cron
```

## Hidden subcommands

Folded under a parent command above, but valid on their own:

| Command | What it does |
|---|---|
| `urfael job` | inspect one background job (full record + log tail) |
| `urfael cancel` | cancel a background job by id |

---

Generated from `app/registry.js`. To regenerate: `node docs/manual/reference/generate-cli.js`.
