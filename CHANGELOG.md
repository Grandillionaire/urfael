# Changelog

All notable changes to Urfael are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/), and the project aims at [Semantic Versioning](https://semver.org/). Dates are ISO (YYYY-MM-DD).

Run `urfael version` to see what you are on, and `urfael update` to pull and reinstall the latest.

## [0.11.0] - 2026-07-10

### Added

- **Idle-suspend for the outbound bridge pollers (opt-in, default off).** With `URFAEL_IDLE_SUSPEND=1`, a self-timed outbound poller stretches its own poll cadence once the owner has gone quiet, then snaps back to the hot cadence on the next owner message or on a scheduled/heartbeat push. It lives entirely in `app/bridge/*`: a pure, zero-dependency `IdleGovernor` cadence state machine plus a plain 0600 mtime-only "wake" doorbell file that `notifyAll()` bumps. There are ZERO edits to `app/daemon.js`, so the brain daemon, its 0600 unix socket, and the allowlist gate stay hot and byte-identical, and there is still no inbound port. A woken poll re-runs the SAME allowlist gate, same code, same order, before any message reaches the brain; suspension only changes how long the loop sleeps, never what it checks, and the governor module is structurally incapable of referencing the socket or the gate. Fail-closed and fail-safe: a missing, stale, or hostile doorbell can only make a poller poll MORE often (stay hot), never drop or fast-path a message, so the worst case is a bounded, tunable first-catch latency (never a lost message). Clock skew is `max()`-guarded to the same effect. Off by default (only `1`/`on`/`true` enable it), so the default poller paths are byte-identical. Honestly scoped: it targets iMessage (the one true 4s busy-poller, the flagship win) and email's non-IDLE fallback (secondary, and a no-op at the default knobs because email's fallback is already 60s). The long-poll bridges (Telegram/Matrix), the IMAP IDLE push path, the Signal streaming subprocess, and the WebSocket-heartbeat bridges (Discord/Slack/QQ/SimpleX) are deliberately NOT suspended, because they are already idle-cheap server-side and forcing them to a non-blocking probe would make them busier or drop the connection. Tuning knobs (inert unless the master flag is on): `URFAEL_IDLE_AFTER_MIN` (default 5) and `URFAEL_IDLE_PROBE_SECS` (default 60, floored so the idle probe is never faster than the bridge's native poll interval).

## [0.10.0] - 2026-07-09

A security and integrity wave on top of v0.9.0. Every feature is backend-verified, and the opt-in or default-off ones are labelled as such, so nothing here overclaims what protects you by default.

### Added
- **Detached async Council (opt-in, summary-only, local-only).** With `URFAEL_COUNCIL_ASYNC=1`, `urfael council --async "<task>"` runs the read-only Council DETACHED from your terminal, off the request/response cycle and off the turn chain, so a long background council never blocks a chat turn. It replies immediately with a job id; on completion it pushes a caveated, silent phone summary ("background, unreviewed by you") through the same `notifyOwner` sanitizer, and the synthesis is fetched with `urfael council --result <id>`. Double opt-in: the daemon flag AND an explicit `--async` are both required; a `POST /council` with no async field is byte-identical to today, and `{async:true}` without the flag returns a 403 with the enable hint. Every detached worker reuses the SAME single-sourced `councilDeps` read-only floor (a planner requesting Write/Edit/Bash/bypass is narrowed to Read/Grep/Glob), each run is a jobstore record you can cancel (`urfael council --cancel <id>`, id-scoped SIGKILL) or replay (`urfael council --replay <id>`) and is ledger-logged (`council_start`/`council_push`/`council_done`, `source:'async'`). Honest scope: detached from your terminal and reconciled to `interrupted` on restart, NOT crash-immortal. Zero new dependency, no new port; `app/council.js` is unchanged (zero-line diff).
- **Memory Journey graph (opt-in, read-only).** With `URFAEL_MEMGRAPH=1` on both the daemon and the dashboard, the dashboard gains a read-only "Memory journey" section: a projection over data Urfael already owns (the git-versioned memory plus the hash-chained Ledger of Record), computed server-side and rendered on demand. Nodes are beliefs and lessons; edges are real git revisions (a line removed and re-added in one commit), never LLM-inferred. Every node and edge resolves to an immutable git commit SHA (`git show <sha>` reproduces it) for beliefs and lessons alike, because `LESSONS.md` is itself git-versioned; whole-chain integrity is shown via `audit-chain.verify`, and if that chain is broken the view renders a red "LEDGER BROKEN" banner and withholds the provable badges. Honest by construction: the ledger stores only payload digests and learn verdicts are batch-count events, so there is no per-lesson seq and none is fabricated (a lesson's cryptographic handle is its git SHA; `/api/graph/prove?seq=N` is a passthrough to the existing `/audit/prove` for any recorded ledger seq). It runs one bounded, shell-free `git log -p` over the exact `urfael why` file set, caps nodes and truncates labels, and renders inline SVG via `createElementNS` with every label written as `textContent` on a tight allowlist (no script/iframe/foreignObject), so an adversarial distilled-memory label can never execute; the locked CSP is unchanged. 127.0.0.1-only, token-gated, another route on the existing 0600 unix socket. Zero new dependencies, no new inbound port, no new data model, no sub-agent. Off by default; with the flag unset the served dashboard page is byte-identical and the `/graph` route falls through to the existing 404.
- **The Familiar: an opt-in, code-drawn agent-state companion (`URFAEL_PET`, default off, cosmetic).** One pure module (`app/pet.js`) drives a small companion whose pose tracks the agent's state (idle / thinking / tool, wielding the real implement rune / waiting, pre-first-token / failed), plus the voice-native listening / speaking the orb already earns, across BOTH surfaces: a vector layer on the canvas orb HUD and a 1-2 cell Unicode glyph that prefixes the TUI worker row, with a plain 7-bit ASCII fallback for basic terminals and a single static pose under reduce-motion. It is provably free of any brain impact **by construction**: `pet.js` has zero imports and contains none of the network / process / cost-accounting symbols (a static source-scan test freezes that), so it cannot reach the daemon, its 0600 channel, the transcript, or the cost ledger; it is fed only UI state the surfaces already derived. Default byte-identical: with the flag off the orb frame and the worker row emit identical bytes (a full state × animation × reduce-motion parity fixture proves it) and the familiar layer is never drawn. OFF by default (only `1`/`on`/`true` enables it; the orb HUD stays independently gated by `URFAEL_ORB`), cosmetic and allowlisted through the existing self-settings path, zero new dependency, no new port, no new IPC channel. Drawn in code, never a sprite atlas. Clean-room re-implementation of the pattern (idea from NousResearch/hermes-agent, MIT; no code copied).

- **`urfael scan <path>`: a read-only, verified security audit of any codebase.** A read-only agent (Read, Grep, Glob only; no write, no shell, no egress) sweeps the source with an anti-fabrication prompt, then an independent skeptic verifier re-checks every candidate and refutes the false ones, so no AI slop ships. It prints an honest report (verified findings, a "checked and cleared" section, and a scope-and-limits block) or writes it with `--report file.md`. The target repo is treated as untrusted input, and the read-only floor holds even if a hijack is attempted. On any brain error (auth, usage-limit, overloaded, 5xx, timeout) it reports "the audit could not run", never a false "clean".
- **MCP tool-poisoning gate.** `urfael connect add` now poison-scans and pins an MCP server's tool descriptions, and `urfael connect verify` re-scans against the pin and refuses a server whose tools drifted (a rug-pull) until you re-approve. Fail-closed on a manifest it cannot fetch or parse. Detection is at add-time and on-demand verify, not a per-turn runtime interceptor.
- **Ledger transparency log (`urfael attest verify`).** The tamper-evident Ledger of Record gains an RFC-6962 Merkle transparency log with a C2SP signed-note checkpoint, plus inclusion and consistency proofs, so an append-only history can be proven rather than only asserted. Zero dependencies, socket-only, fail-closed on malformed proofs.
- **CaMeL-lite taint gate (opt-in, experimental).** A value-level taint tracker with a capability gate on privileged tool calls (write, edit, remember, shell), so untrusted data cannot silently reach a privileged sink. It is OFF by default and not wired into the default subscription path; enable it explicitly. Fail-closed at the gate.
- **Sleep-time reflection (opt-in).** With `URFAEL_REFLECT=1`, an offline, read-only, no-LLM idle pass consolidates the day into a dated vault note. No egress, no shell, and it writes only its own note. Off by default.
- **Pre-hand-off distill compaction (opt-in, experimental).** With `URFAEL_PRECOMPACT=1`, a very long end-of-conversation memory-distill transcript is condensed before its one-shot `claude` hand-off: the first and last few exchanges stay verbatim while the middle is replaced by a reference-only, secret-redacted summary produced by a read-only, no-egress sandboxed summarizer (`--strict-mcp-config`, Write/Edit/Bash/WebFetch/WebSearch disallowed, `scopedEnv()`, never bypass). Fail-safe: any summarizer outage hands off the raw transcript unchanged, and every compaction is hash-chained into the Ledger as a `precompact` event. OFF by default (only the exact value `1` enables it), so the default distill spawn stays byte-identical. It compacts only this pre-hand-off transcript, not the live subscription window. Tuning knobs: `URFAEL_PRECOMPACT_RATIO` (0.75), `URFAEL_PRECOMPACT_FIRSTN` (2), `URFAEL_PRECOMPACT_LASTN` (6).
- **Mixture-of-Agents / council brain mode (opt-in, experimental, local-only).** With `URFAEL_MOA_BRAIN=1` and after you pin it (`urfael brain council`, or say "council mode"), a local turn is answered by the read-only Council ensemble instead of the solo subscription. It reuses the existing council engine through one shared `councilDeps`, so every worker is narrowed to the read-only floor (Read/Grep/Glob; web tools only in full mode) and can never gain write/shell/bypass. Fail-closed: a bad orchestrator plan degrades to one read-only subtask, and an engine failure surfaces an honest council error rather than silently answering solo. Local-only twice over (`/brain` refuses a channel; the remote one-shot path never reads the brain pin), zero new dependency, no new port, and every turn is jobstore-persisted (`source:'brain'`) plus ledger-logged for replay. Off by default; the default subscription brain is unchanged and byte-identical. It runs a costlier, slower fan-out, so convene it deliberately.
- **Independent-verifier goal gate (opt-in, experimental; host + docker certified, ssh fails closed).** Turn on the guard-railed goal loop's two-key completion gate with `goal-loop.sh --verify` (env-equivalent `URFAEL_GOAL_VERIFY=1`, runner `spec.verify`, `POST /job {verify:true}`). It is MANDATORY-paired with an up-front, machine-checkable contract via `--criteria <file>` (env `URFAEL_GOAL_CRITERIA`, `spec.criteria`): `--verify` without `--criteria` exits non-zero (fail-closed), so the bar is always stated before any work. Layer 1 stays the existing deterministic `--check` (or the `URFAEL-GOAL-DONE` marker) — a red check never even spawns the verifier. Layer 2 is a SECOND, FRESH-session `claude` on the fortress read-only floor (Read/Grep/Glob, `--strict-mcp-config`, `--permission-mode acceptEdits`, no Write/Edit/Bash, no bypass, no `--resume`) whose only job is to REFUTE completion by reading the actual tree; the goal, the worker's claim, `git diff --stat` and the criteria are wrapped as untrusted data in a per-call random-nonce envelope. Done requires BOTH a green Layer 1 AND a well-formed `pass` citing non-empty evidence for EVERY criterion; refute / error / timeout / unparseable / missing-evidence all mean NOT done, and the refutation reason is fed into the next turn's prompt. The up-front `goal_contract` and every `goal_verify` verdict are hash-chained into the tamper-evident Ledger of Record through the daemon's single-writer `logEvent` over one new owner-socket-only, closed-schema route `POST /goal/ledger` (the child cannot forge chain position; the verdict is a log record, not the control signal), and `urfael audit --verify` covers them. Beats a self-grading contract on independence (a fresh refuter that can only VETO, never edit itself to pass), a deterministic first key, a fail-closed veto, hash-chained auditable verdicts, injection-hardening, and no new surface. OFF by default — with none of the flags the goal loop is byte-identical to before. `app/package.json` `dependencies` stays `{}`, no new inbound port. All prompt-building + verdict-parsing live in one new pure module `app/goal-verify.js` (reusing `scan.js`'s read-only floor + finder/skeptic split and `learn-verify.js`'s nonce envelope). Benchmark now `123/123` checks; `1164` unit tests.

### Changed

- **Native engine hardening.** The native compactor gains a prune pass and secret redaction, and the agent loop gains a real-token compaction trigger and a loop guard. The native engine stays opt-in; the default subscription brain is unchanged.

## [0.9.0] - 2026-06-25

The "JARVIS" release (feat/jarvis-pillars). A large feature wave, each backend live-or-unit verified; UI surfacing is in progress.

### Added

- **Concurrent provider chats.** Open multiple chats at once, each bound to its own model/provider warm session, side by side, without disconnecting the others. New endpoints `/chat`, `/chat/<id>/ask`, `/chat/<id>/disconnect`, `/providers`. The dashboard now has a "+ New chat" button and per-chat tiles.
- **Ask Urfael to change itself.** Plain-language requests to change its persona, verbosity, TUI theme/animation, or voice are proposed, confirmed ("yes"), and applied live. A hard allowlist + fail-closed denylist means it can never self-modify permissions, credentials, or security keys.
- **Dedicated Reminders & Calendar channel.** A local-first, git-versioned calendar plus a `/schedule` chat that manages reminders and events in place (confirm-gated, local-only).
- **Self-update.** Urfael notices a newer official version and, when you ask, fast-forwards the official remote (source installs) and reloads. Never silent; human-confirmed; official-source only.
- **Cross-session awareness + UI customization primitives** (session bus, unified theming with a CSS sanitizer, per-model memory formatting + consolidation).
- **Dashboard key-point highlighting.** On the dashboard, Urfael marks the load-bearing phrases of an answer with a gold highlight, after it finishes generating.

### Changed

- **Voice overlay reworked**: deterministic press-to-talk (tap to record, tap again to send) plus graduated dormancy (idle fade, then shrink into the corner, hover to revive).

## [0.8.7] - 2026-06-25

The "the app actually opens" release.

### Fixed

- **The macOS app would not open.** The build skipped code signing, which left the app with a broken, half-applied signature (no sealed resources). Apple Silicon macOS rejects that outright as "Urfael is damaged and can't be opened", a hard block with no easy way past it. The build now applies a clean ad-hoc signature to the packaged app (`build/afterPack.js`), so the signature is valid and the app opens through the normal "unidentified developer" path. This is not notarization: the app is still unsigned by an Apple Developer ID, so on first open you click Open Anyway in System Settings, Privacy and Security (or strip the quarantine flag with `xattr -dr com.apple.quarantine /Applications/Urfael.app`). The install copy now says exactly that.

## [0.8.6] - 2026-06-25

The "one-click download" release.

### Fixed

- **The download buttons now download.** The site's "Download for macOS" and "Download for Linux" buttons used to land you on the GitHub releases page, where you had to find the right file yourself. They now point straight at the installer. To make those links survive every future release, the installers ship with stable, version-less names (`Urfael-arm64.dmg`, `Urfael-x86_64.AppImage`) so `releases/latest/download/...` always resolves to the current build.

## [0.8.5] - 2026-06-24

The resilience release.

### Changed

- **Automatic fallback retry.** A turn that fails for a retryable reason (model overloaded, model unavailable, network, timeout) retries once on the other native tier and adopts that result only if it succeeds. An account-wide rate limit fails both, so the original error is kept rather than giving false hope. The hop is logged, and `URFAEL_FALLBACK=0` disables it.

## [0.8.4] - 2026-06-23

### Changed

- **Failed turns now explain themselves.** The warm session drains `claude`'s stderr, and a pure, unit-tested classifier names the failure (not signed in, rate limited, model overloaded, context too long, network, model unavailable, claude not installed, timeout) with a retryable flag. Instead of a generic "(brain spawn failed)" you now get the actual reason, the category is logged for diagnostics, and the failure messages no longer carry em or en dashes. This also lays the groundwork for an automatic fallback retry.

## [0.8.3] - 2026-06-23

The "borrow the best, keep our edges" release. A source-level audit of Hermes Agent (MIT, Nous Research) surfaced a handful of genuinely useful improvements that fit Urfael's principles (zero runtime dependencies, no inbound port, fortress default); these are them. Prompt caching was investigated and dropped as a no-op, the `claude` CLI already caches the system prompt and conversation.

### Added

- **Persistent input history in the cockpit** (`^P` older, `^N` newer). It survives restarts, is multi-line-aware, and is stored `0600`; the navigation is pure and unit-tested.
- **`urfael doctor --json`** for machine-readable health (cron, scripts, dashboards) and **`urfael update --check`** to report what is new without pulling.
- **Ctrl+V pastes from the OS clipboard** (alongside bracketed paste), fail-soft across pbpaste / wl-paste / xclip / xsel / Get-Clipboard.

### Changed

- **The TUI sanitizer is hardened**: multi-pass, and now strips OSC sequences (hyperlinks, clipboard, title) and stray or incomplete escapes in addition to CSI, defending the cockpit against adversarial tool output while keeping newlines.
- **Backspace is grapheme-aware** (Intl.Segmenter): it removes a whole cluster (emoji, combining marks) instead of a single code unit.
- **The daemon watches its own V8 heap** and logs a throttled warning before it could silently run out of memory on a very long session.

## [0.8.2] - 2026-06-23

The "real installers, and a smoother first hour" release.

### Fixed

- **Installers now actually build and attach to the release.** The packaging pipeline is green on macOS (Apple Silicon) and Linux, verified end to end on CI. Beyond the SVG-icon fix in 0.8.1, two CI-only failures were cleared: electron-builder was auto-publishing on the tag (now `--publish never`, with the release handled by an explicit step), and unset signing secrets were being passed as empty strings that pushed macOS into a broken signing path (now an unsigned build with no certificate env).
- **The cockpit scrolls again.** The TUI could not scroll up to read history: it uses the alternate screen buffer, which disables native terminal scroll, and the bare Up arrow recalled the last message instead of scrolling. Now the mouse wheel scrolls the transcript, Up/Down/PageUp/Home/End scroll reliably, recall moved to Ctrl+P, and the controls are shown in the status line and the startup hint.
- **No more em dashes in chat answers.** Answers are generated by the brain, and the existing de-dasher only covered the help menu. Because the anchor spawn is a frozen security invariant, the fix filters the output: em and en dashes are stripped from both the live stream and the final answer, while hyphens in CLI flags are left alone.

### Added

- **`urfael quickstart`** (alias `quick`), a fast onboarding path shown on the start-here card. It connects you (reusing the setup wizard, or skipping if already configured), then hands you the whole moat with one line to try each, recall, the Council, checkpointed coding, attest, and the runnable security benchmark, plus one thirty-second first win.

## [0.8.1] - 2026-06-23

The "it actually installs" release. Fixes the packaging pipeline so a published release carries real, downloadable installers.

### Fixed

- **The installer build now produces binaries.** electron-builder was pointed at an SVG icon, which it cannot consume, so every `npm run dist` failed and v0.8.0 shipped with no installers attached. The app icon is now a real raster set generated from the Uruz mark (a multi-resolution `.icns` for macOS, a 512px `.png` for Linux), and the macOS DMG and ZIP and the Linux AppImage build cleanly, verified locally before tagging.

### Changed

- **The build matrix matches the platforms Urfael actually supports.** macOS on Apple Silicon and Intel, plus Linux, build native installers. Native Windows is intentionally not a target: the daemon's whole security boundary is a `0600` unix-domain socket, a POSIX guarantee that does not hold on native Windows, so Windows is supported through WSL rather than a native build that would quietly weaken the model. The site's install section says so plainly.

## [0.8.0] - 2026-06-22

The "prove it, and sell the proof" release. Turns the security and honesty posture into a single artifact, and hardens the public surface ahead of launch.

### Added

- **`urfael attest`, the Attestation Report.** One command bundles the facts that are each independently verifiable, the Ledger of Record hash-chain is intact, the ed25519 Sovereign Seal over its head is valid, and the no-egress posture is in force, into one human and JSON report a reviewer, auditor, or client can keep, anchored by the seal. It is scoped honestly: a test freezes the wording so it can never drift into "guarantees nothing leaves" overclaim, and it states plainly what it does not prove. See [docs/ATTEST.md](docs/ATTEST.md).
- **An honest Editions page** on the landing: Sovereign (free, MIT, the whole single-user agent) available now; Pro/Teams and Managed-Sovereign labelled "coming". Paid editions never meter tokens. A Sponsor button, a watch-releases link, and an email-capture stub.

### Changed

- **Cost framing is now provider-agnostic.** The site leads with "runs on your Claude subscription, or any of 30 providers, or a local model", and a new FAQ states plainly that subscription use depends on Anthropic's terms (which Urfael does not control) and that the same product, with the same guarantees, runs on any provider if they change. The Anthropic dependency is a disclosed, mitigated tradeoff, not a hidden single point of failure.
- **Breach narrative hedged.** Specific, unsourced incident statistics about named competitors were softened to attributed, hedged language; the fair-use capability comparison stays.
- **Terminal help carries no em or en dashes** (a central de-dash, matching the generated CLI reference), frozen by a test.
- The doc-consistency guard now fails loudly if it cannot find the files it polices (no vacuous pass), and the suite grows to 520.

## [0.7.0] - 2026-06-22

The "better Claude Code" release. Urfael's brain is the `claude` CLI, so this turns it into a superior coding harness: a first-class coding session in your own repo, with a safety net the bare CLI does not have.

### Added

- **Coding mode (`urfael code "<task>"`).** Runs Claude Code in your repo with three layers stacked on. **Per-project memory:** a stable, per-repo `CONVENTIONS.md` plus a `HISTORY.md`, kept under the private memory repo and loaded as context every time, so it picks up that repo's conventions instead of relearning them each session. The project id derives from the git remote, so the same repo shares one memory across clones. **Auto-checkpoint:** before the brain touches a file, the whole working tree (tracked and untracked) is snapshotted onto a private git shadow ref (`refs/urfael/checkpoints/`) through a temp index, capturing everything yet never touching your branch, index, or working tree. **A record of the turn:** each run appends to the project `HISTORY.md` and an append-only log, both inside the git-versioned memory repo.
- **Checkpoints and rewind (`urfael checkpoints`, `urfael rewind [<id>]`).** An undo for the agent. `rewind` restores your tracked files to a snapshot; it checkpoints the current state first, so a rewind is itself reversible, and files created since the snapshot are kept, never silently deleted. The ids, refs, message encoding, and list parsing are pure and unit-tested; the git surgery has a real-repo integration test that proves a checkpoint captures the tree, a rewind restores it, new files survive, and your branch history is never polluted.

### Changed

- Test suite grows to 520 (the coding-mode modules `project.js` and `checkpoint.js` are pure and frozen with tests, plus the real-repo integration test).

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
