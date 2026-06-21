# Plugins

A plugin is the most capable way to extend Urfael. It can ship tools the brain calls, read or write a scoped set of your vault files, and reach an allowlisted set of hosts. Because it is the most capable surface, it gets the most paranoid handling in the codebase. A plugin is never trusted by default. It earns each power one declaration at a time.

## The model

OpenClaw and Hermes load plugins as in-process code with broad host power. That is why a large share of one registry shipped as malware in 2026: a single poisoned plugin runs with the agent's full privileges. Urfael does not copy that model. A Urfael plugin is:

- **Loaded as data, never `require()`d.** Plugin code never enters the daemon's address space, never inherits its environment, and never holds your Claude subscription token. `app/pluginhub.js` parses the manifest, scans the bundle, and builds the runtime confinement as data. It never runs the plugin itself.
- **Run as a network-isolated MCP cell.** A host-reaching plugin is spawned as a stdio MCP server inside a Docker cell with `--network none`, `--cap-drop ALL`, `--read-only`, `no-new-privileges`, a 512 MB memory ceiling, and only the bind mounts its grant earned.
- **ed25519-signed and sha256-pinned.** Install verifies the bundle bytes against a pinned sha256, then verifies an ed25519 signature against the publisher's pinned key fingerprint (trust on first use). A version that changes the key stays disabled until you re-consent.
- **Owner turns only.** A plugin's tools attach to a turn through `--mcp-config` on your trusted local turns. Every sandboxed spawn (a remote message, a cron job, the heartbeat) runs `--strict-mcp-config`, so a prompt injection that says "use the plugin to leak a secret" has no plugin to reach. Any host-reaching capability forces this.

Two rules never bend. First, no inbound port: a plugin is spawned as a stdio server and never listens. Second, zero capability by default: an empty manifest grants nothing, and the grant you approve is compiled into the cell's mounts and the brain's tool allowlist. The manifest is the enforcement spec, not documentation.

## Capabilities

The manifest (`plugin.json`, schema `urfael.plugin/v1`) declares capabilities. You grant a subset. The effective set is `granted` intersected with the active turn's profile. Anything declared but not granted produces no bind mount, no proxy rule, no staged binary, and no injected secret. It does not exist at runtime.

| Kind | Grants | Enforced by |
|---|---|---|
| `fs` | read or write one vault-relative path | a Docker bind mount of exactly that path; a path into a credential store or outside the vault is rejected |
| `net` | reach exactly the listed FQDNs | a per-plugin forward proxy over a mounted socket; the cell stays `--network none`, https only, with the resolved IP re-checked against the private-host guard |
| `exec` | run a named host binary | staged read-only into the cell, invoked as argv, never a shell line |
| `secret` | use a secret by reference | a broker injects the value into a granted request; the plugin never sees it |
| `channel` | emit a one-way owner-only notification | the existing no-egress notify path, never inbound |
| `brain.tools` | expose MCP tools to the model | names auto-prefixed `mcp_<id>_<tool>`; this grants no code capability by itself |

`net` and `secret` grants get one extra mount: a per-plugin 0600 unix socket that is the cell's sole egress. The daemon-side broker resolves once, vets the call, pins the request to the vetted IP (closing the DNS-rebind window), strips any plugin-supplied `Authorization` or `Host` header, and returns only a safe view. No new TCP port anywhere.

## How it differs from connectors

A connector (see features/connectors.md) is an external MCP server you add with `claude mcp add`. It is curated, scanned, and owner-turns-only, but it is not signed, not sha-pinned, and not sandboxed in a Docker cell. You trust the upstream server. A plugin is for code you want to run with a verified identity inside containment: signed, pinned, and confined to the exact powers you granted. Use a connector to reach a service you trust. Use a plugin when you want the sandbox.

## The lifecycle

```bash
urfael plugin scan ./plugin.json      # parse, static scan, full capability preview
urfael plugin install ./plugin.json   # six-gate install; written DISABLED and 0600
urfael plugin enable <id>             # attach tools to owner turns (re-verified first)
urfael plugin list                    # what is installed, and what is enabled
urfael plugin disable <id>            # detach it
```

Install runs six gates: fetch, static scan, sha-pin, signature verify, capability preview, consent. The preview shows where it connects, whether it runs local code, which secrets it needs, and the literal `docker run` command that would launch it. Nothing is written until you confirm. `--yes` is refused for anything that trips a scan flag, widens a grant, overwrites, or carries a `secret`, `exec`, or `net` capability. Install writes the bundle disabled; you enable it as a deliberate second step.

## Honest limits

- A capability-bearing plugin requires Docker. Without it those plugins refuse to enable. There is no in-process fallback, by design.
- The host-reaching runtime is code-complete and unit-verified, not yet certified on a live Docker host. The build environment has no Docker, so the containment claim (genuinely no network inside the cell except the bound socket) rests on unit and benchmark tests and must still be certified on a Linux Docker host. macOS Docker Desktop may not pass the socket bind-mount through its VM, so the certified target is Linux. Treat the host-reaching tiers as not yet battle-hardened.
- Signing is ed25519 with trust on first use plus a sha pin. That is more than the broken registries had, but not a full provenance attestation chain. The first install of a new publisher is a human-judgement moment.
- A plugin tool's result can still carry prompt injection back to the brain. Untrusted framing and owner-turns-only bound this risk; they do not eliminate it. It is shared by all MCP tooling.

The full engineering account, including the manifest schema, the broker transport, and the test matrix, is in the repository: [docs/PLUGINS.md](https://github.com/Grandillionaire/urfael/blob/main/docs/PLUGINS.md).
