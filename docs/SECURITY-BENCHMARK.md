# The Urfael Security Benchmark

> Most "secure" claims in this space are adjectives. This one is a command:
>
> ```bash
> npm run security
> ```
>
> It boots the real daemon and dashboard and attacks them the way the wild did — then prints a pass/fail
> table. As of the latest run: **10/10 real-world attack classes resisted · 96/96 checks passed.**

Self-hosted AI agents were not compromised hypothetically in 2026. Public reporting documented real ones:

- **A one-click RCE in a widely used agent** leaked its gateway auth token over a WebSocket, then drove the agent.
- **Exposed agent gateways were found in the tens of thousands**, reachable from the open internet.
- **A popular skill registry was caught serving stealers** and token-exfiltration payloads.
- **Private-key exfiltration via a single poisoned email** delivered to a linked inbox.

Urfael was designed against exactly these. The benchmark proves it, defense by defense, with the test you can read in [`app/test/security-benchmark.js`](../app/test/security-benchmark.js).

## The scorecard

| # | Attack class | What happened in the wild | Urfael's answer | Proven by |
|---|---|---|---|---|
| 1 | **Network exposure** | Agent gateways reachable from the internet, reported in the tens of thousands | The brain listens on a **unix socket only** — zero TCP ports. The opt-in dashboard/API bind `127.0.0.1` only. | `lsof` shows 0 TCP listeners for the daemon; socket is `0600` |
| 2 | **Auth-token leak → RCE** | A one-click RCE leaked a gateway token to a malicious page | Tokens are **constant-time compared**, **never logged**, stored `0600`; cross-origin `Host` rejected (anti-rebinding); no token in any URL | wrong/empty/rebind requests → 401/400; token never appears in stdout |
| 3 | **Prompt-injection exfiltration** | A poisoned email made the agent leak a private key | Remote turns run a **read-only profile** (Read/Grep/Glob — no shell, no write, **no network-egress tool**), nonce-framed; the vault **denies the agent reading credential stores** (a hard boundary that beats even YOLO); the heartbeat (which reads untrusted email) has **no egress tool**; the cron sandbox is read/fetch-only. So an injected "read a secret and send it out" has nothing to read and nowhere to send | 9 coercion attempts → `untrusted`; forged `From:` blocked; `permissions.deny` on `~/.claude`/`~/.ssh`; heartbeat disallows WebFetch/Search/Bash |
| 4 | **Poisoned skill / supply chain** | A popular skill registry was caught serving malware | Skills are **previewed + statically scanned** before install (curl\|sh, reverse shells, persistence into shell-rc / cron / agent-identity files, LLM base-url hijack, install-lifecycle hooks, `--dangerously-skip-permissions`, exfil URLs, hidden unicode), **never auto-installed when flagged**, **never executed**; one obfuscation layer is **decoded and re-scanned** so a base64- or `\xNN`-wrapped payload is judged on its real bytes instead of read as clean text; install refuses SSRF redirects; migrated foreign skills are scanned too | the scanner + `installFromUrl` SSRF guard + `--force` can't bypass the malware gate |
| 5 | **Unauthenticated DoS / crash-loop** | A malformed request that crashes a restarted service is a remote no-auth DoS (we caught one in our *own* review) | Malformed input → 401/400, **not a crash**; bodies capped; rate-limited; no filesystem path from the URL | malformed cookie → 401, process survives; traversal → 404 |
| 6 | **Secret theft by a runaway agent** | An agent with a shell + your secrets is one injection from reading them | The Docker sandbox **stages only the claude auth files** (never `bridge.env` / API keys) and is **`--network none`** by default; and across *every* spawned session the vault `permissions.deny` blocks reading the credential stores outright | the goal-loop never mounts `~/.claude`; the vault denies `Read(~/.claude/**)` etc. (beats the permission mode) |
| 7 | **Insecure defaults** | Some agents ship the unrestricted shell on by default | The unrestricted shell is **off by default** (opt-in + logged); default mode is not bypass; an unknown channel gets the **most-restricted** profile | YOLO off; unknown channel → `untrusted` |
| 8 | **Inbound event trigger → escalation** | Hermes-class agents accept inbound webhooks; an unauthenticated or over-powered trigger turns "an event arrived" into RCE/exfil | The receiver binds **`127.0.0.1` only** (no daemon port); each hook needs its own **256-bit secret** (sha256-hashed, **constant-time**); a missing hook is checked against a dummy hash (**no enumeration**); the `ask` action runs **no-egress** (Read/Grep/Glob — no web/shell/write), payload framed UNTRUSTED, result to the owner only | wrong/unknown secret → 401; list never leaks the secret; `ask` allowlist is `Read,Grep,Glob`; secret stored hashed |
| 9 | **Correctness & craft regressions** | The subtler failure is silent quality rot — a new feature that quietly widens real power, or a "secure" surface that stops verifying its own claims | New surfaces must keep their guarantees: a **persona is a voice overlay only** (its immutable safety clause is appended in code, so an authored "you have root" persona can't strip it, and no authored persona can shadow a built-in), a **Council worker can only NARROW** its tools (never gains Write/Edit/Bash) and the council is **local-only + single-flight + reaped on shutdown**, a typo is **caught before it spends a turn**, and an **optional connector** is an owner-only power that refuses a plaintext-http remote, masks the secret you type (passed as an `execFile` argv, never a shell line, so no `~/.zsh_history` leak), and loads on no sandboxed turn. Each is frozen as a regression so a future commit can't silently undo it | `personas.overlayFor` always carries `SAFETY_CLAUSE`; `intersectTools` ⊆ the read-only floor; `/council` refuses a remote channel + clamps agents; did-you-mean intercepts a near-miss before the brain; `connectors.parse` drops a plain-http remote, `buildAddArgs` keeps the secret in the argv, every connector is `--strict-mcp-config`-gated |
| 10 | **Plugin loader** | OpenClaw and Hermes load plugins as in-process code with broad host power | A plugin is loaded as **DATA** (never `require()`d), runs only as a **capability-scoped MCP server** inside the `--network none` Docker cell, and is **sha-pinned at consent** and re-checked at enable, so a manifest edited *after* you consented (widening caps, swapping `entry.cmd`) is refused. Attaches to **owner turns only**; sandboxed turns stay `--strict-mcp-config` | loaded-as-data (no `require`); `integrityOk` refuses an edited manifest fail-closed; host-reaching needs the cell; owner-turns-only |

## Why this is the differentiator

OpenClaw and Hermes optimize for reach — channel count, model count, star count. None of the three ships a runnable proof that it resists the attacks that have actually compromised agents in the wild. Urfael does, because it was built blast-radius-first:

- **The topology is one-way.** Urfael reaches *out* (to your `claude` login, to chat APIs it polls). Nothing reaches *in*. There is no gateway to expose, no token to leak over a socket, no DM endpoint to spray.
- **Untrusted content is structurally contained,** not prompt-engineered into safety. A remote message physically cannot run a shell or hit the network, so "read a secret and POST it somewhere" has no egress to use.
- **The supply chain is guilty until proven innocent.** A skill is inert markdown that gets scanned and shown to you before it's stored, and is never executed. Hermes and OpenClaw also scan a plugin at install, and Urfael now matches their shell- and JavaScript-idiom coverage; what is unique here is that Urfael **decodes one obfuscation layer and re-scans the result**, so a dropper hidden inside a base64 or `\xNN` blob is judged on its real bytes rather than passing as clean text, and it returns a **capability summary + severity verdict** (`block` / `review` / `clean`) instead of a bare allow/deny. The honest bound: this is a heuristic static gate over one decode layer, not a sandboxed taint analysis, and the real guarantee is the layer behind it (preview + sha-pin + never-execute), which holds even if a sample slips the scanner.
- **The tests are adversarial and frozen.** Each defense above ships with a regression test built from a real finding (several from Urfael's own internal red-team), so a refactor can't silently reopen a hole.

This is not a claim that Urfael is unbreakable — nothing is, and we keep a [`What's lightly tested`](../README.md#whats-lightly-tested) section on purpose. It is a claim that the specific, documented ways self-hosted agents got owned in 2026 are closed here, and that you can verify it in one command. See the formal [Threat Model](THREAT-MODEL.md) for the boundaries and the residual risks we *don't* cover.
