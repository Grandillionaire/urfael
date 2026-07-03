# Features overview

This is the map. Each entry is one honest sentence and a link to the page that goes deep. Everything below ships **off by default** unless noted, and you turn power on deliberately.

## Coding

`urfael code "<task>"` runs Claude Code in your own repo with three things the bare CLI lacks: per-repo memory loaded every turn (so it keeps your conventions instead of relearning them), an automatic checkpoint of the working tree onto a private git shadow ref before it touches anything (your branch and index untouched), and a one-command, itself-reversible undo with `urfael rewind`.

See [features/coding.md](features/coding.md).

## Memory and active recall

Every conversation is archived as plain JSONL and searchable through a persistent BM25 index over the **whole** archive, not just a recent window; with a local embedder configured, the lexical shortlist is re-ranked by semantic vectors so a paraphrase still surfaces. Active recall goes one step further: before every owner turn it injects a small, fenced block of the past turns and trusted lessons that bear on your message, so you do not have to remind it. It is on by default; set `URFAEL_ACTIVE_RECALL=0` to turn it off.

See [features/memory.md](features/memory.md).

## Skills

Urfael writes down procedures and reuses them, and any skill (including from the `urfael hub` registry) is scanned, sha-pinned, previewed, and **never executed**. The scanner decodes one obfuscation layer and re-scans the bytes, then hands you a `block` / `review` / `clean` verdict; the static scan is a heuristic, so the real guarantee is that the skill is previewed and never run. Manage them with `urfael skills list` and `urfael hub`.

See [features/skills.md](features/skills.md).

## Connectors

A connector lets Urfael reach your tools (GitHub, Notion, Postgres, your calendar, and more), and it is just an MCP server, the open standard the `claude` brain already speaks. `urfael connect add github` shows a pre-enable security preview and a static scan **before anything is written**, masks the secret you type so it never hits your shell history, and loads only on owner turns, so sandboxed remote and cron turns get none.

See [features/connectors.md](features/connectors.md).

## Plugins

Plugins are capability-scoped, sandboxed MCP extensions you install, scan, and enable with `urfael plugin`. They are inspected before they run and can be imported from an OpenClaw plugin directory.

See [features/plugins.md](features/plugins.md).

## Voice

The default voice tier is fully local, offline, and free: whisper.cpp transcribes on-device and macOS `say` (or Linux `espeak-ng`) speaks, with no cloud STT or TTS. A quality tier adds local Kokoro, and a premium tier uses ElevenLabs (paid, opt-in). A spoken wake word is optional via Picovoice.

See [features/voice.md](features/voice.md).

## Personas

`urfael persona` switches the voice it answers in: architect, sage, operator, muse, or analyst. It changes tone, not capability or access.

See [features/personas.md](features/personas.md).

## Automation

Reminders, background jobs, scheduled cron, and webhook triggers. `urfael cron add "brief me on overnight email" --daily-at 07:30` runs the brain on a schedule and reports back; a `--then` step chains a follow-up. A `--script` cron runs a no-LLM shell command, which is opt-in and owner-authored (it needs `URFAEL_SCRIPT_CRON=1`). Webhook triggers (`urfael hook add`) wake the brain from an external event through a loopback-only receiver gated by a per-hook secret, with the action sandboxed to no egress.

See [features/automation.md](features/automation.md).

## Models and providers

The brain runs your installed `claude` CLI and uses its model aliases (`sonnet` for most turns, `opus` for code and deep reasoning), so it tracks the latest models your plan supports. Opus needs a Max plan; on Pro, set `URFAEL_OPUS_MODEL=sonnet`. Because Urfael inherits your environment, any backend Claude Code supports works through it: Bedrock or Vertex, or any model via a translating proxy. Non-Anthropic models run on your own provider keys; the Claude subscription only covers Anthropic models. Pin a tier or switch provider with `urfael model`.

See [features/models.md](features/models.md).

## Channels

Drive Urfael from 19 owner-allowlisted channels (the certified core, exercised against real accounts, is Telegram, Discord, Slack, iMessage, and Email as draft-only; the Matrix, Signal, and WhatsApp bridges, the QQ, SimpleX, and PSTN phone bridges, and the eight native webhook channels are code-complete and reviewed, not yet battle-hardened), by text or by voice memo transcribed locally. Every channel is gated to your id before the brain sees anything and is sandboxed read-only by default. The universal `relay` turns any platform with an in/out webhook into a two-way channel. The maturity split is single-sourced from `CHANNEL_MATURITY` in `app/lib.js`.

See [channels/overview.md](channels/overview.md).

## The security model

The brain is a local daemon reachable only through a `0600` unix socket and never opens a TCP port; the topology is one-way, so nothing reaches in. Default **Fortress** mode keeps remote turns read-only with no egress, and you opt into **Full** mode deliberately. Security-critical paths ship with adversarial regression tests, and `npm run security` attacks the running daemon: the latest run resisted 10 of 10 attack classes across 101 checks. Real-world scale is still small, and the docs say so on purpose.

See [security/model.md](security/model.md). The full Threat Model and benchmark are summarised in [security/threat-model.md](security/threat-model.md), with the source documents at [docs/THREAT-MODEL.md](https://github.com/Grandillionaire/urfael/blob/main/docs/THREAT-MODEL.md) and [docs/SECURITY-BENCHMARK.md](https://github.com/Grandillionaire/urfael/blob/main/docs/SECURITY-BENCHMARK.md).

## Where to go next

New here? Start with [start/quickstart.md](start/quickstart.md). Want the whole architecture in one read? See [developer/architecture.md](developer/architecture.md).
