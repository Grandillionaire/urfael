# Changelog

All notable changes to Urfael are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/), and the project aims at [Semantic Versioning](https://semver.org/). Dates are ISO (YYYY-MM-DD).

Run `urfael version` to see what you are on, and `urfael update` to pull and reinstall the latest.

## [0.7.0] - 2026-06-22

The "better Claude Code" release. Urfael's brain is the `claude` CLI, so this turns it into a superior coding harness: a first-class coding session in your own repo, with a safety net the bare CLI does not have.

### Added

- **Coding mode (`urfael code "<task>"`).** Runs Claude Code in your repo with three layers stacked on. **Per-project memory:** a stable, per-repo `CONVENTIONS.md` plus a `HISTORY.md`, kept under the private memory repo and loaded as context every time, so it picks up that repo's conventions instead of relearning them each session. The project id derives from the git remote, so the same repo shares one memory across clones. **Auto-checkpoint:** before the brain touches a file, the whole working tree (tracked and untracked) is snapshotted onto a private git shadow ref (`refs/urfael/checkpoints/`) through a temp index, capturing everything yet never touching your branch, index, or working tree. **A record of the turn:** each run appends to the project `HISTORY.md` and an append-only log, both inside the git-versioned memory repo.
- **Checkpoints and rewind (`urfael checkpoints`, `urfael rewind [<id>]`).** An undo for the agent. `rewind` restores your tracked files to a snapshot; it checkpoints the current state first, so a rewind is itself reversible, and files created since the snapshot are kept, never silently deleted. The ids, refs, message encoding, and list parsing are pure and unit-tested; the git surgery has a real-repo integration test that proves a checkpoint captures the tree, a rewind restores it, new files survive, and your branch history is never polluted.

### Changed

- Test suite grows to 514 (the coding-mode modules `project.js` and `checkpoint.js` are pure and frozen with tests, plus the real-repo integration test).

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
