# The security model

Self-hosted agents got owned in 2026 because they listened where attackers could reach them and ran untrusted content with real power. Urfael inverts both. This page is the moat in plain terms. Every claim matches what the code does, and where a control is opt-in or off by default, it says so.

## The brain has no port

The brain is a local Node daemon. It speaks to every surface (mic, Console, CLI, TUI, orb) over a single UNIX socket at `$JDIR/daemon.sock`, mode `0600` so only your user can connect. There is no TCP port on the brain. A network scanner finds nothing, because nothing is listening on the network.

The topology is one-way. Urfael reaches out: it drives your local `claude` login as warm subprocesses, and the chat bridges poll their APIs outbound. Nothing reaches in.

Three HTTP surfaces are opt-in and bind `127.0.0.1` only: the web dashboard (`urfael dashboard`), the OpenAI-compatible API (`urfael serve`), and the webhook receiver. Each is loopback-only and token or secret gated: reachable from your own machine, not from the LAN or the internet. The genuinely inbound surfaces (the optional WhatsApp bridge and the webhook receiver) are opt-in, HMAC or per-hook-secret verified, and tunnel-it-yourself. Neither opens a port on your behalf.

## Allowlisted before the brain, then sandboxed

Every message from a chat channel (Telegram, Discord, Slack, iMessage, Email, Matrix, Signal, WhatsApp) is checked against your id and dropped plus audited otherwise, before a single token reaches the model.

A message that passes the allowlist still runs in a read-only sandbox. The profile resolution in `app/lib.js` (`resolveProfile` / `profileFor`) is fail-closed: any unknown or non-string profile name resolves to the most restricted `untrusted` profile, never `local`. A remote turn gets Read, Grep, and Glob over your vault only. No write, no shell, no network egress. The message text is wrapped in a nonce-framed envelope marked as untrusted data, not instructions.

The result: an injected "read a secret and POST it out" has nothing to read and nowhere to send. The containment is structural, not prompt-engineered.

## Autonomous work runs throwaway

The `/goal` loop can edit and commit code on its own. It runs with iteration, wall-clock, and stale caps, a kill switch, and never pushes. Beyond a trusted local repo, run it sandboxed:

- `--sandbox docker`: a throwaway container, `--network none`, with only your `claude` auth files staged in. Your `bridge.env` and any API keys are never mounted.
- `--sandbox ssh`: a remote box, again with no secrets mounted.

Supervise the first run. Full capability mode (`URFAEL_YOLO=1`) gives the agent an unrestricted shell that also reads untrusted web and email; run that only in a VM, container, or throwaway account.

## The vault denies the credential stores

The spawned `claude` subprocess runs against a vault whose permissions deny reading `~/.claude` and `~/.ssh` outright. This is a hard boundary that holds even in YOLO mode: the agent cannot read your credential stores no matter what it is asked to do.

## Secure by default

Urfael ships in Fortress mode. No unrestricted shell, no computer-use, remote turns read-only with no egress. You turn power on deliberately. Opting into Full mode widens remote owner and member turns to web reach while keeping no-shell, no-bypass, framing, and the credential-deny in place, so even Full mode stays contained. See [Fortress vs Full](security/modes.md).

Multiple people can use one instance, each a sandboxed principal through the same fail-closed kernel, where a role can only narrow access, never escalate. `urfael audit` gives an auditor the who, when, and what. See [Team mode](security/team.md).

## Proof, not adjectives

`npm run security` boots the real daemon and dashboard and attacks them the way self-hosted agents were attacked in the wild: network exposure, prompt-injection key exfil, malicious skills, runaway autonomous turns, DoS, and more. The latest run resists 10 of 10 attack classes across 91 checks. Several controls are also frozen as adversarial regression tests under `app/test/*.test.js`, so a refactor cannot quietly reopen a closed hole.

This is a personal tool with a small user base, so it has had far less adversarial scrutiny than a large deployment. We say so plainly. The threat model also states the residual risks Urfael does not cover (a host already compromised, a sandbox you widen yourself, the model provider you point at). Read the full version in [Threat model and benchmark](security/threat-model.md), or the full file on GitHub at [docs/THREAT-MODEL.md](https://github.com/Grandillionaire/urfael/blob/main/docs/THREAT-MODEL.md).
