# Threat model & benchmark

Most "secure" claims in this space are adjectives. Urfael ships a command instead:

```bash
npm run security
```

This boots the real daemon and the opt-in dashboard, then attacks them across ten real-world attack classes and prints a pass/fail table. The current pass count is printed when the benchmark runs, so read the table rather than a number quoted here. The test is one you can read: it lives at [`app/test/security-benchmark.js`](https://github.com/Grandillionaire/urfael/blob/main/app/test/security-benchmark.js).

## Why a benchmark and not an adjective

Self-hosted agents were compromised in production in 2026, not hypothetically: public gateways found by the tens of thousands, a one-click token-leak RCE, a skill registry where roughly a fifth of skills were malware, a private key exfiltrated by a single poisoned email. The benchmark targets exactly those failure modes, defense by defense.

## The ten attack classes

The benchmark groups its checks into ten classes. Each maps to a control Urfael actually enforces.

1. **Network exposure.** The brain listens on a unix socket only, zero TCP ports. The opt-in dashboard and API bind `127.0.0.1` only. The benchmark confirms no TCP listeners and a `0600` socket.
2. **Auth-token leak to RCE.** Tokens are constant-time compared, never logged, stored `0600`. Cross-origin `Host` is rejected (anti-rebinding) and no token rides in a URL.
3. **Prompt-injection exfiltration.** Remote turns run a read-only profile (`Read`, `Grep`, `Glob`) with no shell, no write, and no network-egress tool. Untrusted content is nonce-framed. The vault denies reading credential stores. So "read a secret and send it out" has nothing to read and nowhere to send.
4. **Poisoned skill / supply chain.** Skills are previewed and statically scanned before install, never auto-installed when flagged, never executed. One obfuscation layer is decoded and re-scanned. Install refuses SSRF redirects. Migrated foreign skills are scanned too.
5. **Unauthenticated DoS / crash-loop.** Malformed input returns 401 or 400 and does not crash. Bodies are capped and requests are rate-limited.
6. **Secret theft by a runaway agent.** The Docker sandbox stages only the claude auth files (never `bridge.env` or API keys) and runs `--network none` by default. The vault deny blocks reading credential stores across every spawned session.
7. **Insecure defaults.** The unrestricted shell is off by default (opt-in and logged). An unknown channel gets the most-restricted profile.
8. **Inbound-trigger escalation.** The webhook receiver binds `127.0.0.1` only. Each hook needs its own 256-bit secret (sha256-hashed, constant-time compared). A missing hook checks against a dummy hash, so there is no enumeration. The triggered `ask` action runs no-egress.
9. **Correctness and craft regressions.** New surfaces keep their guarantees: a persona is a voice overlay that cannot strip its safety clause, a Council worker can only narrow its tools, a typo is caught before it spends a turn, and a connector refuses a plaintext-http remote. Each is frozen as a regression.
10. **More of the same, nailed shut.** Several checks come from Urfael's own internal red-team. The holes were found, closed, then frozen so a refactor cannot reopen them.

## Frozen regression tests

The security-critical paths carry frozen regression tests under `app/test/*.test.js` (allowlist bypass, IMAP injection, SSRF, malware scan, fail-closed profiles, DoS). Several were written from real findings in Urfael's own adversarial review. They exist so a future commit cannot silently undo a guard.

## What this does not claim

This is not a claim that Urfael is unbreakable. Nothing is. The threat model states the residual risks plainly: a host already compromised as you, the opt-in `URFAEL_YOLO=1` unrestricted shell (run it only in a VM or throwaway account), a deliberately widened sandbox, the model itself, the connectors you enable, and the provider you point at. It is a personal tool with a small user base, so it has had far less adversarial scrutiny than a large deployment. We say so.

## Further reading

The honest version of what Urfael protects, who it protects against, and what it does not defend lives in [docs/THREAT-MODEL.md](https://github.com/Grandillionaire/urfael/blob/main/docs/THREAT-MODEL.md). The full scorecard, with the in-the-wild incident for each class, lives in [docs/SECURITY-BENCHMARK.md](https://github.com/Grandillionaire/urfael/blob/main/docs/SECURITY-BENCHMARK.md). For the read-only vs web-reach tradeoff that classes 3 and 6 rely on, see [security/modes.md](security/modes.md). To get the daemon running first, see [start/quickstart.md](start/quickstart.md).
