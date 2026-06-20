# Urfael Plugins

A plugin is the most powerful way to extend Urfael: it can ship tools the brain can call, reach a scoped set of your files, and talk to allowlisted hosts. Because it is the most powerful surface, it gets the most paranoid handling in the codebase. This is the design, and an honest account of what ships today versus what lands next.

## The thesis: better than in-process plugins, on purpose

OpenClaw and Hermes load plugins as in-process code with broad host power. That is exactly why roughly 20% of the ClawHub registry shipped as malware in 2026: one poisoned plugin runs with the agent's full privileges. Urfael does not copy that model. A Urfael plugin is:

- **Loaded as data, never `require()`d.** Plugin code never enters the daemon's address space, never inherits its environment, and never holds your Claude subscription token.
- **Run only as a capability-scoped MCP server**, the open tool standard the `claude` brain already speaks, inside the existing `--network none` Docker cell.
- **Owner turns only.** A plugin's tools attach to a turn through `--mcp-config` on your trusted local turns. Every sandboxed spawn (a remote message, a cron job, the heartbeat) stays `--strict-mcp-config`, so a prompt injection that says "use the plugin to leak a secret" has no plugin to reach.
- **Signed and sha-pinned.** A registry entry must carry an https url and a 64-hex sha256, and install verifies an ed25519 signature against the publisher's pinned key.

## The two laws that never bend

1. **No inbound port.** A plugin is spawned by the daemon as a stdio MCP server. It never listens. The moat holds.
2. **Zero capability by default.** An empty manifest grants nothing. Every power is declared, then granted by you, then compiled into the runtime confinement. The manifest is the enforcement spec, not documentation.

## The capability model: declared, granted, effective

Three objects, enforced by the same fail-closed machinery the rest of Urfael uses:

- **Declared**: what the `plugin.json` manifest asks for.
- **Granted**: the subset you approve on a 0600-socket turn, after a full static scan, an ed25519 verify, and a capability preview. Persisted 0600 with the sha and key fingerprint.
- **Effective**: computed per invocation as `granted ∩ the active turn's profile`. A capability that is declared but not granted produces no bind mount, no proxy rule, no staged binary, and no injected secret. It simply does not exist at runtime.

A freshly installed plugin sits at the `plugin-zero` floor: no tools, no host reach. That floor is never the `local` (bypass-capable) profile.

### Capability kinds

| Kind | What it grants | How it is enforced |
|---|---|---|
| `fs` | read or write a single vault-relative path | a docker `-v` bind mount of exactly that path; a path into a credential store or outside the vault is rejected at validate time by the same deny-oracle the skill scanner uses |
| `net` | reach exactly the listed FQDNs | the cell is `--network none`; the only egress is a per-plugin forward proxy that allowlists the granted hosts, https only, and re-checks the resolved IP against the private-host guard at connect time |
| `exec` | run a named host binary | the binary is staged read-only into the cell and invoked with arguments as argv, never concatenated into a shell line |
| `secret` | use a secret by reference | the plugin never sees the value; a broker injects it into a granted outbound request and masks it everywhere else |
| `channel` | emit a one-way owner-only notification | reuses the existing no-egress notify path; never inbound |
| `brain.tools` | expose MCP tools to the model | names are auto-prefixed `mcp_<id>_<tool>`; shipping a tool grants zero code capability by itself |

## The manifest

`plugin.json` (schema `urfael.plugin/v1`), validated by a fail-closed parser: a bad top-level shape is refused, and a single malformed capability entry is dropped rather than failing the whole plugin. Key fields: `id` (kebab), `name`, `version` (semver), `runtime` (`mcp-native` or `node`), `entry` (a stdio argv array, never a shell string), `capabilities` (the table above), `limits` (memory capped at 512 MB), `integrity.sha256`, `publisher.keyFingerprint`, and `signature` (ed25519 over the canonical manifest).

## The six-gate install

`fetch -> static scan -> sha-pin -> signature verify -> capability preview -> consent`. The preview shows exactly what the plugin can do, where it connects, whether it runs local code, which secrets it needs, and the literal `docker run` command that would launch it. Nothing is written until you confirm. `--yes` is refused for anything that trips a scan flag, widens a grant, overwrites, or carries a secret, exec, or net capability.

## The lifecycle

```bash
urfael plugin scan ./plugin.json      # parse + static scan + the full capability preview
urfael plugin install ./plugin.json   # six-gate install; written DISABLED, 0600
urfael plugin enable <id>             # attach its tools to your owner turns (re-verified first)
urfael plugin list                    # what is installed, and what is enabled
urfael plugin disable <id>            # detach it
```

`urfael plugin scan` prints the capability grant a plugin would receive (with any unsafe path or host already dropped) and the exact `--network none` cell command, before anything runs. That pre-enable preview is the move no competitor ships. Install writes the bundle and a grant file (both 0600) in a disabled state; you enable it deliberately as a separate step.

## What v1 ships, and what is next

This is an honest split. v1 ships the verified core; the live runtime is the next increment.

**Ships now (verified and frozen):**
- The pure loader (`app/pluginhub.js`): parse and validate, static scan, sha256 integrity, ed25519 signature verify, the declared-to-granted capability diff, the default-deny cell builder, and the capability preview.
- The full lifecycle: `urfael plugin scan` / `install` / `enable` / `list` / `disable` / `secret <REF>`. An enabled plugin's tools attach to your owner turns through `--mcp-config`, safe-by-default (with nothing enabled the warm spawn is byte-identical to before). Every sandboxed, remote, or cron turn stays `--strict-mcp-config`, so a plugin never reaches an untrusted turn.
- The egress + secret broker (`app/plugin-broker.js`): the decision seam (allowlist, SSRF re-checked on the resolved IP for DNS-rebind, secret injected only for a granted host, masking). Pure and frozen.
- The transport (`app/plugin-brokerd.js`): the daemon-side server on a per-plugin 0600 unix socket that is the cell's sole egress. It resolves once, asks the frozen broker, then makes the real HTTPS call pinned to the exact vetted IP (no second DNS lookup, so the rebind window is closed), does not auto-follow redirects, strips any plugin-supplied `Authorization`/`Host` header, and returns only a safe view to the plugin. No new TCP port anywhere. The cell stays `--network none` with one extra mount: that socket.
- The runtime wiring: `enablePlugin` starts a per-plugin brokerd for a `net`/`secret` grant; the `fs` tier gets a read-only cell mount; secrets are stored 0600 (`urfael plugin secret <REF>`) and used by reference only, never placed in any spawn env. A host-reaching grant needs Docker and fails closed if absent.
- Frozen: a 10th attack-class with a transport probe (`npm run security`, now 10/10 classes, 88/88 checks) plus the broker (14 tests) and brokerd (9 tests) unit suites and the fuzz targets, so none of it can silently regress.

**The one remaining step: live Docker certification.** The build environment has no Docker, so ~95% of the security lands as unit and benchmark tests (the broker decision, the transport over an in-process socket, the cell argv shape), but the final containment claim must be certified on a real Linux Docker host: that inside the `--network none` cell there is genuinely no network except the bound socket, that the socket bind-mount passes through, and that the in-cell client round-trips. One honest caveat to certify first: macOS Docker Desktop runs in a VM and may not pass an `AF_UNIX` socket bind-mount through the VM boundary, so the certified target is a Linux host; the macOS path needs its own check. Until certified on the deploy target, treat the host-reaching tiers as code-complete and unit-verified, not battle-hardened, exactly like the lightly-tested channel bridges.

## Honest limits

- A capability-bearing plugin requires Docker. Without it those plugins refuse to enable. There is no in-process fallback, by design.
- v1 does not run a competitor's plugin code, by design. `urfael plugin import <path>` brings an OpenClaw or Hermes plugin onto Urfael by reading its manifest as data only: a bundled `SKILL.md` routes to the skill scanner, a declared external MCP server becomes a previewed, unsigned, disabled draft manifest, and in-process code (hooks, slash/CLI commands, provider/channel/model adapters, direct host calls) is refused with a specific reason rather than stubbed. So most in-process foreign plugins will not port, and refusing them is the correct outcome. The importer never signs, never enables, and never executes anything; the owner still walks the full native six-gate pipeline on the draft.
- Signing is ed25519 with trust-on-first-use plus a sha pin, which is more than ClawHub had, but not yet a full provenance attestation chain. The first install of a brand-new publisher is a human-judgement moment, surfaced as such.
- A plugin tool's result can still carry prompt injection back to the brain. Untrusted framing and owner-turns-only bound this; they do not eliminate it. This is a residual risk shared by all MCP tooling.
