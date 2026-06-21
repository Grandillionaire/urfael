# FAQ

The questions people actually ask before they install. Short answers, grounded in what the code does.

## Do I need an API key?

No, not to start. Urfael runs your installed `claude` CLI as a subprocess, so it rides your existing Claude Code login (Pro or Max). If `claude` works in your terminal, the daemon works. There is no key to paste and nothing to connect. The installer fetches a checksum-pinned local speech model, so even voice needs no key.

One exception: non-Anthropic models. If you route to GPT, Gemini, DeepSeek, or a local model through a proxy, that runs on your own provider keys. The Claude subscription only covers Anthropic models. Also note: if `ANTHROPIC_API_KEY` is in your environment, it overrides the subscription. Details in features/models.md.

## Does it open a port?

No. The brain is a local daemon reachable only through a `0600` unix socket. It never opens a TCP port, so nothing on the LAN or the internet can reach it. The topology is one-way: Urfael reaches out (to your `claude` login and the chat APIs it polls), nothing reaches in.

The optional dashboard (`urfael dashboard`), the OpenAI-compatible API (`urfael serve`), and the webhook receiver all bind `127.0.0.1` only. They are loopback, token or secret gated, and unreachable off the machine. The only genuinely inbound surfaces are opt-in and you tunnel them yourself: the WhatsApp bridge (HMAC-verified) and the webhook receiver (per-hook 256-bit secret). Neither opens a port on your behalf. See security/model.md.

## What does it cost?

Flat. It runs on your Claude Code subscription, so idle costs nothing beyond it and there is no per-token meter. You can still see usage: token counts and an estimated daily, 7-day, and 30-day spend show up in the Console's Hearth panel, the dashboard, and `urfael status`. The spend figure is an estimate (the rate is env-overridable), not an asserted bill.

If you want to run Urfael as a shared service or at production scale, use an Anthropic API key instead of a subscription, which is metered per token.

## Where is my data?

Local. Two places, both yours:

- The **vault** (`~/Urfael`), an Obsidian vault, holds its knowledge and archive.
- A **private local git repo** (`~/Urfael-memory`) holds what it learns. Every conversation, from every surface, is archived as plain JSONL in `~/Urfael-memory/sessions/`, versioned and grep-able by you.

Nothing is pooled across users and no tokens are stored. With a local model and the already-local voice, nothing leaves the machine at all. See features/memory.md.

## Can a teammate read my secrets?

No. Multiple people can use Urfael, each a sandboxed principal through the same fail-closed kernel, where a role can only narrow access, never escalate. Remote and shared turns run read-only with no network egress, and the vault's `permissions.deny` blocks `~/.claude` and `~/.ssh` as a hard boundary that holds even in full-capability mode. An injected "read a secret and send it out" has nothing to read and nowhere to send. `urfael audit` gives an auditor the who, when, and what trail. See security/team.md.

## Which OS?

macOS on Apple Silicon or Intel is the primary, best-tested target. Linux is supported but newer and less battle-tested: the headless core, voice, and Electron GUI run there, with far less mileage. The installer detects Linux and writes `systemd --user` units instead of launchd plists. There is no Windows port yet. See start/install.md.

## Is it production-ready?

Be honest: it is young. Every feature is verified end-to-end by an in-repo harness (`npm run e2e`) against a live daemon, and the security-critical paths ship adversarial regression tests. The security benchmark (`npm run security`) boots the real daemon and dashboard and attacks them: the latest run resisted 10 of 10 attack classes across 95 checks.

What that does not buy you is scale. This is a personal tool. The live relay of the Matrix, Signal, and WhatsApp bridges has not been exercised against real accounts (their parsing and allowlist logic is unit-tested). It is security-tested, not battle-tested at scale. That is the one thing only time and users add.

For the full security writeup, see [SECURITY-BENCHMARK.md](https://github.com/Grandillionaire/urfael/blob/main/docs/SECURITY-BENCHMARK.md) and the [Threat Model](https://github.com/Grandillionaire/urfael/blob/main/docs/THREAT-MODEL.md).
