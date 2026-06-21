<!-- docs/manual/README.md -->

# Urfael

**A personal, voice-capable AI you run on your own machine, on the flat-rate Claude subscription you already pay for.** No API key to start, no inbound network port to attack, no per-token meter running.

Urfael is an always-on local brain. It runs your installed `claude` CLI as a subprocess, so it rides your existing Claude Code login. An Obsidian vault is its archive, a private git repo is its memory, and voice in and out runs on your device. It answers in a real voice while the full written answer lands on screen, stays silent unless something needs you, and ships with every power switched **off** until you turn it on.

What makes it different is not a feature count. It is the blast radius. Nothing listens on a network port. Every remote message is allowlisted to you before the brain sees it and sandboxed read-only by default. The security-critical paths ship with adversarial tests that try to break them, frozen so they cannot regress.

## Where to go next

| You want to | Read |
|---|---|
| Get it running now | [Installation](start/install.md) then [Quickstart](start/quickstart.md) |
| Understand what it can do | [Features overview](features/overview.md) |
| Talk to it from chat apps | [Channels](channels/overview.md) |
| Know it is safe to run | [The security model](security/model.md) |
| Look up a command | [CLI reference](reference/cli.md) |
| Something is not working | [Troubleshooting](reference/troubleshooting.md) |

## The shape of it in one minute

- **One brain, one socket.** A local daemon speaks only over a `0600` unix socket. No TCP port. The optional dashboard and API bind to loopback only.
- **Memory that compounds.** Every conversation is archived and recalled through a hybrid keyword plus semantic index, and the most relevant memory is pulled into each turn automatically. See [Memory & active recall](features/memory.md).
- **It acts on your behalf, carefully.** Reminders, scheduled jobs, webhooks, and autonomous coding all run in sandboxes that fail closed. See [Automation](features/automation.md).
- **It grows.** Skills it writes down and reuses, connectors to the wider tool ecosystem, and a learning loop that verifies a lesson before it trusts it.

> New here? The [Learning path](start/learning-path.md) walks you from first run to power user in a sensible order.

This manual documents what the code actually does. Where a feature is still maturing, it says so plainly. For the deepest internals, the [Architecture](developer/architecture.md) and the [Threat model](security/threat-model.md) link out to the full engineering documents in the repository.
