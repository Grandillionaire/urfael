# The CLI

`urfael` is a thin client. It talks to the daemon over a unix socket and shares the same brain, memory, and warm sessions as the rest of the system. The whole command surface is described once in `app/registry.js`, which feeds the help text, the typo suggestions, and the generated reference. There is no second copy to drift.

## Asking is the default

There is no `ask` verb to type. Whatever you pass that is not a known command is treated as a question and streamed back live:

```bash
urfael "what's on my calendar today?"
urfael "summarise the thread with Stefan and draft a reply"
```

While the turn runs, a one-line status (a changing rune, elapsed time, the current tool) prints to stderr; the answer renders as Markdown on stdout. Press Ctrl+C, or run `urfael stop` from another shell, to abort the in-flight turn. Note that `stop` aborts one turn and `shutdown` stops the daemon. They are different.

## The verb groups

Everything else is grouped into nine sections, the same way `urfael help` lays them out:

| Group | What lives there |
| --- | --- |
| ASK | the default question verb, plus `sessions` search and `stop` |
| MEMORY | `why`, `drift`, `as-of`, `learn`, `forget`: what it knows about you and where each belief came from |
| SCHEDULE | `remind`, `reminders`, `jobs`, `cron`: reminders and background jobs |
| TEAM | `team`, `audit`, `seal`: the roster, the activity trail, the signed ledger |
| SKILLS | `skills`, `hub`, `import`: install and share skills (scanned, never executed) |
| CONNECT | `connect`: optional MCP integrations, previewed and owner-turns-only |
| PLUGINS | `plugin`: capability-scoped, sandboxed extensions |
| SERVE | `serve`, `dashboard`, `tui`, `acp`, `council`, `hooks`, `hook`, `script`: expose the brain |
| SYSTEM | `setup`, `status`, `model`, `persona`, `doctor`, `health`, `shutdown`, `help` |

This page explains the shape. For the exact subcommands, flags, and examples of every command, see the full [CLI reference](reference/cli.md). That reference is generated straight from `app/registry.js`, so it always matches the binary.

## The help system

Help comes in three tiers, each driven by the registry:

```bash
urfael              # the "start here" card: a few first moves, then a count of the rest
urfael help         # the full reference, grouped into the nine sections
urfael help cron    # one command in focus: summary, usage, examples, related commands
```

`--help` and `-h` map to `urfael help`. Help text is plain when piped or redirected (it honours `NO_COLOR` and a non-TTY), so `urfael help > file` is clean. `urfael logo` prints the banner on its own.

## Did-you-mean

Because asking is the default, a typo would otherwise spend a real turn. So before falling through to the brain, the CLI checks one case: a single command-shaped word (three or more letters, no spaces, and no further arguments) that sits exactly one edit away from a real command. Only then does it suggest the fix instead of asking:

```text
$ urfael remnd
did you mean  urfael remind  ?
  (or ask me literally:  urfael "remnd")
```

The threshold is deliberately strict (distance one, with transpositions counted as one mistake). A real one-word question like `urfael "weather"` still reaches the brain untouched, and the suggestion always prints the escape hatch for forcing the word through as a literal question. `urfael help <something-unknown>` is more generous (it nudges within two edits) because you already signalled you are looking for a command.

The dispatcher that backs all of this lives in [`app/cli.js`](https://github.com/Grandillionaire/urfael/blob/main/app/cli.js), with the command graph in [`app/registry.js`](https://github.com/Grandillionaire/urfael/blob/main/app/registry.js).
