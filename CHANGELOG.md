# Changelog

All notable changes to Urfael are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/), and the project aims at [Semantic Versioning](https://semver.org/). Dates are ISO (YYYY-MM-DD).

Run `urfael version` to see what you are on, and `urfael update` to pull and reinstall the latest.

## [0.6.0] - 2026-06-21

The "match or beat the field" release. Every addition ships with unit tests, and the security-critical paths are frozen as benchmark checks (`npm run security`, now 95/95 across 10 attack classes).

### Added

- **Active recall.** Before every owner turn, the message itself retrieves the most relevant past turns and verified lessons and injects them into context automatically: hybrid BM25 plus optional local semantic vectors, content-gated so a conversational query cannot drag in noise, cross-session so it recalls rather than echoes, and reinforced in the learning ledger. `URFAEL_ACTIVE_RECALL=0` to disable.
- **Training-data export.** `urfael dataset export` turns your own runs and verified lessons into datasets (`sft`, `atropos`, and a verified-knowledge `lessons` set), provenance-stamped against the tamper-evident Ledger of Record and secret-redacted by default.
- **Cost-optimal provider routing.** `urfael model route --for cost|speed|quality|privacy` recommends the best provider, Pareto-aware and explainable, over a registry that grew to **30 named providers** (OpenRouter alone unlocks 300+ models).
- **Eight native webhook channels** on one loopback-only receiver: Mattermost, Google Chat, SMS (Twilio), DingTalk, Home Assistant, BlueBubbles, Feishu, WeCom. Channel count is now 19. Each verifies the platform's real signature (timing-safe) and runs the one fail-closed allowlist before the brain.
- **Discord voice channels.** The bot joins a VC and talks, reusing the local pipeline (whisper.cpp in, local TTS out, nothing leaves the machine), with every speaker allowlist-gated and owner barge-in. Optional `@discordjs/voice` stack, lazy-required so the core stays dependency-free.
- **Android via Termux.** A portability layer (`app/platform.js`) detects macOS / Linux / WSL / Windows / Termux and adapts notifications, TTS, and capability flags.
- **A2UI safe canvas.** The brain can emit interactive UI (cards, tables, buttons), validated to an allowlisted, sanitized schema so a generative canvas can never execute code.
- **A "/" command palette** in the TUI with live typeahead and bespoke value pickers for persona, model, and theme.
- **A hosted, searchable docs manual** (`docs/manual/`, docsify, zero build step) with an auto-generated CLI reference and `llms.txt`.
- **Release engineering.** This changelog, semantic versioning, and `urfael version` / `urfael update` for self-update.

### Changed

- The install scanner gained decode-and-rescan and 30 new check families, plus a severity score and a capability summary.
- The README and PARITY map were corrected against a source-level teardown of Hermes and OpenClaw, removing claims their actual code disproved.
- The landing page was brought current with all of the above.

### Honest status

Discord voice, the native webhook channels, and the Termux host are code-complete and unit-tested with the security properties frozen, but not yet certified against live accounts or a real device. A2UI ships as a protocol and validator; live rendering in the dashboard and Console is not yet built. These are labeled as such in the docs.

## [0.1.0] - 2026-06

Initial Urfael: the unix-socket brain daemon, the CLI and TUI, the vault and git-backed memory, local voice, the channel bridges, the fail-closed security model, the Ledger of Record and Sovereign Seal, the skill hub, connectors, plugins, the Council, and the runnable security benchmark.

[0.6.0]: https://github.com/Grandillionaire/urfael/releases/tag/v0.6.0
[0.1.0]: https://github.com/Grandillionaire/urfael/releases/tag/v0.1.0
