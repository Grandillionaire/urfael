# Urfael Threat Model

The honest version: what Urfael protects, who it protects against, what it does *not* defend, and how each
control is verified. Paired with the runnable [Security Benchmark](SECURITY-BENCHMARK.md) (`npm run security`).

## What we're protecting (assets)

1. **Your machine** — the host Urfael runs on, and everything on it.
2. **Your secrets** — the vault, `~/.claude/urfael/*.env` (bridge tokens, optional API keys), your `claude` login.
3. **Your Claude subscription** — used only for your own ordinary use; never bundled, pooled, or proxied for others.
4. **Your trust** — that Urfael does what it says and tells you what it doesn't know.

## Trust boundaries

| Zone | Trust | Reaches |
|---|---|---|
| **The owner** — you, at the mic / Console / CLI | Full | the daemon over a `0600` unix socket (no port) |
| **The brain** — warm `claude` sessions | Acts as you, with the permission mode you set | the vault, your tools/MCP, your `claude` login |
| **Remote channels** — Telegram/Discord/Slack/iMessage/Email/Matrix/Signal/WhatsApp | **Untrusted** until allowlisted to your id; then **sandboxed read-only** | read + search the vault only — no shell, write, or network egress |
| **Untrusted content** — email bodies, web pages, calendar entries, foreign skills, anything the agent reads | **Hostile by assumption** | nothing directly; framed as data, never instructions |
| **The network** (LAN / internet) | **Hostile** | nothing — the daemon opens no port; opt-in dashboard/API are loopback-only |

## Adversaries & controls

- **A network attacker / worm** scanning for exposed agents → there's nothing to find: the brain is a unix socket; the opt-in HTTP surfaces bind `127.0.0.1` only and are token-gated. *(Benchmark class 1, 2, 5.)*
- **A prompt injector** hiding instructions in an email/web page/calendar invite the agent reads → remote turns run a read-only profile with no egress tool, content is nonce-framed as untrusted, and the sender allowlist can't be spoofed or coerced. *(Class 3.)*
- **A malicious skill author** (the ClawHub failure) → skills are scanned, previewed, never auto-installed when flagged, never executed; install refuses SSRF; migration scans foreign skills too. *(Class 4.)*
- **A runaway / injected autonomous turn** with a shell → it runs in a Docker sandbox that mounts only the claude auth files (never your secret store) and is network-isolated by default; the goal loop is iteration/wall/stale-capped and never pushes. *(Class 6.)*
- **A local process without the token** trying to drive the dashboard/API → constant-time token, loopback-only, Host-allowlisted; rate-limited; no path from the URL. *(Class 2, 5.)*
- **A misconfiguration** exposing more than intended → fail-closed defaults: unknown channels get the most-restricted profile; the unrestricted shell is opt-in and logged. *(Class 7.)*

## What we do NOT defend against (residual risk — stated, not hidden)

- **A compromised host.** If malware already runs as you, it can read the same `0600` files Urfael uses. Urfael shrinks blast radius; it is not a rootkit detector.
- **`URFAEL_YOLO=1`.** Opt-in unrestricted-shell mode is, by design, an unrestricted shell that also reads untrusted web/email. The docs say in every relevant place: run it only in a VM / container / throwaway account.
- **A widened sandbox.** If you add `WebFetch`/`Write` to the remote profile (documented as an opt-in widening) you re-open an egress/write path. The default is closed; widen deliberately.
- **The model itself.** Urfael structurally prevents an injected instruction from *acting* (no egress, no shell on untrusted turns), but it can't guarantee the model never produces wrong text. The containment is structural, not behavioral.
- **The connectors you enable.** Calendar/Gmail/desktop MCPs you turn on carry their own permissions; Urfael drafts email and never sends, but you own what you connect.
- **The model provider you point at.** The sandbox is harness-enforced, so it holds whatever model answers — but the provider *processing* a turn inherently sees that turn. A **fully-local** model (Ollama/LM Studio on your box) means nothing leaves the machine; a **remote** proxy/provider (OpenRouter, a hosted endpoint) sees your prompts, exactly as using that API directly would. The sandbox stops the *agent* from exfiltrating beyond the turn; it can't unsee what you send it. Choose the provider accordingly.
- **A brain-tools-only plugin's server process.** A plugin that requests *only* LLM-visible tools (no fs/net/exec/secret grant) is spawned as a plain local stdio process, not inside the Docker cell — the cell confines a host-reaching grant, not the tool server itself. It has no *granted* capabilities, but the server code runs with your privileges, like any program you launch. Installing one is a trust decision; the capability preview labels it "not sandboxed" so the choice is explicit. Host-reaching plugins (fs/net/exec/secret) always run in the `--network none` cell or refuse to enable.
- **Install-time plugin signature verification.** Install today is static-scan + capability preview + consent, and the consented manifest is sha-pinned so a post-consent edit is refused at enable. Verifying a publisher's ed25519 signature *at install* (the primitive ships and is tested) is not yet wired into the install path; until it is, the first install of a publisher is a human-judgement moment, and tamper-evidence across the network depends on the registry sha-pin, not a signature check.
- **Scale.** This is a personal tool with a small user base — far less adversarial scrutiny than a 100k-deployment project. We say so plainly.

## Verification

Every control above maps to a check in `npm run security` (the [benchmark](SECURITY-BENCHMARK.md)) and/or a frozen regression test under `app/test/*.test.js` (allowlist bypass, IMAP injection, SSRF, malware scan, fail-closed profiles, DoS). Several of those tests were written *from* findings of Urfael's own internal adversarial review — the holes were found and closed, then nailed shut so a refactor can't reopen them.
