# Learning path

A route from first run to power user. Each step is small. Do them in order, or skip ahead once a step feels routine. This page is a map, not a deep dive: every step links to the page that covers it properly.

Everything past the first two steps is opt-in and off by default. You turn power on deliberately, one step at a time.

## 1. Install and run it once

Clone the repo, run `./install.sh`, run `urfael setup`, then `cd app && npm start`. That gets you a voice assistant running on your Claude Code subscription with no API key. See [start/install.md](start/install.md).

## 2. Have your first conversation

Load the daemon, open a surface, and ask it something. `urfael "what's on my calendar today?"` streams the answer back; the mic does the same by voice. See [start/quickstart.md](start/quickstart.md).

## 3. Learn the surfaces

One daemon, four ways to reach it: the Console desktop app, the orb HUD, the full-screen TUI (`urfael tui`), and the token-gated web dashboard (`urfael dashboard`). A conversation started in one shows up in the others. See [using/surfaces.md](using/surfaces.md).

## 4. Understand its memory

Conversations are archived as plain JSONL and recalled through a BM25 index. Before each owner turn, active recall pulls the relevant past turns and trusted lessons and puts them in front of the model. It is on by default; set `URFAEL_ACTIVE_RECALL=0` to turn it off. `urfael sessions search <query>` searches the whole archive, and `urfael why "<a belief>"` traces a fact back to the commit that set it. See [features/memory.md](features/memory.md).

## 5. Make it proactive: reminders and cron

`urfael remind "call the dentist" --in 20` speaks a fixed line later. `urfael cron add "brief me on overnight email" --daily-at 07:30` runs the brain on a schedule and reports back (notify, silent, or pushed to a chat channel). A `--then` step chains a follow-up. See [features/automation.md](features/automation.md).

## 6. Reach it from chat: channels

Drive Urfael from eight owner-allowlisted channels (Telegram, Discord, Slack, iMessage, Email draft-only, Matrix, Signal, WhatsApp), by text or local voice memo. Every message is checked against your id before the brain sees it. For anything outside the eight, the universal relay turns any in/out webhook into a two-way channel. See [channels/overview.md](channels/overview.md) and [channels/setup.md](channels/setup.md).

## 7. Teach and extend it: skills and connectors

Skills are reusable procedures. Any skill, including from `urfael hub`, is scanned, sha-pinned, previewed, and never executed. Connectors are MCP servers that let Urfael reach your tools (`urfael connect add github`); each add shows a security preview, masks the secret you type, and loads only on owner turns. See [features/skills.md](features/skills.md) and [features/connectors.md](features/connectors.md).

## 8. Choose your security posture

Fortress mode (the default) keeps remote turns read-only with no egress. Full mode (chosen in `urfael setup`) gives remote owner and member turns web reach while keeping no-shell, no-bypass, and the credential-deny. Unrestricted shell (`URFAEL_YOLO=1`) is a separate, riskier setting: run it only in a VM, container, or throwaway account. See [security/modes.md](security/modes.md) and the fuller picture in [security/model.md](security/model.md).

## 9. Add other people: team mode

Several people can use one Urfael, each a sandboxed principal through the same fail-closed kernel, where a role can only narrow access, never escalate. `urfael team add` manages the roster and `urfael audit` hands an auditor the who/when/what trail. See [security/team.md](security/team.md).

## Where to go next

You now know the shape of the whole system. For the security reasoning behind these defaults, read [security/model.md](security/model.md). For the engineering, the [Threat Model](https://github.com/Grandillionaire/urfael/blob/main/docs/THREAT-MODEL.md) and the [Security Benchmark](https://github.com/Grandillionaire/urfael/blob/main/docs/SECURITY-BENCHMARK.md) lay out the attack classes and what the latest run resisted.

One honesty note worth repeating: macOS is the best-tested target, Linux is newer, and the live relay of the Matrix, Signal, and WhatsApp bridges is reviewed but not yet exercised against real accounts. See [What's lightly tested](https://github.com/Grandillionaire/urfael/blob/main/README.md#whats-lightly-tested) before you lean on those paths.
