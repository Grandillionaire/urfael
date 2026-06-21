# Architecture

Urfael is one local Node daemon that drives your installed `claude` CLI and speaks to every surface over a single UNIX socket. There is no TCP port on the brain. The security model is the shape of the system, not a layer on top of it.

## One daemon over a UNIX socket

`app/daemon.js` is the conductor. It runs an HTTP server bound to a UNIX socket at `$JDIR/daemon.sock`, created with mode `0600` so only your user can talk to it. Every client (your mic, the Console, the `urfael` CLI, the TUI, the orb, the optional dashboard, the OpenAI-compatible API) connects to that one socket. No client has a privileged path; they all go through the same routes (`/ask`, `/council`, `/abort`, `/model`, `/persona`, `/seal`, and so on).

The topology is one-way. Urfael reaches out to your `claude` login and the chat APIs its bridges poll. Nothing reaches in. The LAN and the internet can address nothing on the brain because there is no port to address.

## Warm claude subprocesses

The daemon keeps warm `claude` sessions ready rather than cold-starting a process per request. A local full-power session acts as you in the permission mode you set. A scoped pool handles remote turns under tight limits. When a remote message arrives, the session is spawned with `--allowedTools` restricted to Read, Grep, and Glob, and the vault's `permissions.deny` blocks `~/.claude` and `~/.ssh`. That denial holds even in the most permissive run mode.

## The vault and the memory repo

The spawned `claude` subprocess works against two stores. The Obsidian vault is the archive that everything is written into and searched over. The git memory repo is what Urfael learns and commits over time. See [features/memory.md](features/memory.md) for how memory is captured, verified, and recalled, and [start/quickstart.md](start/quickstart.md) to set both up.

## Pure, unit-tested modules

`daemon.js` is large because it owns I/O, process lifecycle, and routing. Every decision worth testing is delegated to a pure satellite module that takes data and returns data, with no daemon, no socket, and no `claude` in the loop. Examples:

- `app/lib.js` resolves permission profiles (`resolveProfile` / `profileFor`).
- `app/council.js` narrows a worker's tools (`intersectTools`).
- `app/personas.js` appends the immutable `SAFETY_CLAUSE` at spawn.
- `app/audit-chain.js` and `app/seal.js` hash-chain and ed25519-sign the Ledger of Record.
- `app/registry.js` is the single source of truth for CLI help and dispatch.

Because these are pure, the unit suite runs with no credentials in about half a second, and the security benchmark calls the exact same functions the daemon calls.

## Fail-closed everywhere

Resolution is fail-closed by default. Any unknown or non-string profile name returns the most restricted `untrusted` profile, never `local`. The owner's mode can only narrow a principal, never escalate it. `intersectTools` can only narrow a Council worker's tools to `requested ∩ floor`, never add Write, Edit, or Bash, and never returns an empty list (it falls back to the Read/Grep/Glob floor). An injected "read a secret and POST it out" turn has nothing to read and nowhere to send. That containment is structural, not prompt-engineered.

The full trust-boundary table and the residual risks Urfael does not cover are in [security/model.md](security/model.md).

## Read the full walkthrough

This is a summary. The complete five-minute walkthrough, including the system diagram, the module map, the data-and-security flow of one remote message, and the test and benchmark story, is in the repository:

[ARCHITECTURE.md on GitHub](https://github.com/Grandillionaire/urfael/blob/main/ARCHITECTURE.md)
