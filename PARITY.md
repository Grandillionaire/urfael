# Parity map — Urfael vs OpenClaw vs Hermes Agent

> The standing goal: everything they have, we have — smoother. This file is the tracked work-list,
> built from deep teardowns of both projects (June 2026). Status: ✦ better · ✓ parity · ◐ partial · ✗ missing.
>
> **Strategy + sequenced roadmap:** [docs/IMPROVEMENT-PLAN.md](docs/IMPROVEMENT-PLAN.md) — how Urfael beats both *combined* via the trust-kernel thesis, not feature-union.
> Urfael's structural advantage: the brain is the `claude` CLI, so Claude Code's whole tool surface
> (files, shell, web, MCP, subagents, skills) is inherited, not reimplemented.

## Surfaces
| Capability | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Desktop app (chat, streaming tool rows, sessions, settings) | menu-bar app | Electron+React | ✓ **Console** (chat, archive, reminders, jobs, hearth, settings) |
| CLI | `openclaw …` | TUI-first, rich | ✦ `urfael` CLI **and** `urfael tui` full-screen ANSI cockpit (streamed transcript + tool rows, Esc-abort, terminal-safe) |
| Voice (wake word, PTT, barge-in, local STT/TTS) | wake word, talk mode | CLI PTT, voice memos | ✦ orb (opt-in) + Console PTT + spoken remarks, all local |
| Web dashboard | ✓ | ✓ | ✦ token-gated localhost dashboard (now surfaces the learning ledger + the team audit trail, no terminal) (127.0.0.1-only, constant-time token, no path serving — hardened past both) |
| Mobile nodes / canvas | iOS/Android, A2UI canvas | ✗ | ✗ — non-goal for now (phone via bridges) |
| REST API | WS gateway | OpenAI-compatible REST | ✓ OpenAI-compatible `/v1/chat/completions`+`/v1/models` (127.0.0.1-only, token-gated) — drives Open WebUI/LibreChat/any OpenAI client |

## Onboarding & packaging
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| First-run onboarding | installer | guided | ✦ GUI first-run card in the Console (subscription / API key / local) **and** `urfael setup` CLI wizard |
| Packaged installer | ✓ | one-line curl | ✓ **one-line curl** (`get.sh` — clones + runs install.sh, read-it-first short) **and** electron-builder + CI pipeline (dmg/AppImage/nsis); GUI-installer signing still needs certs |
| OS coverage | broad | broad | ◐ macOS solid · Linux supported · Windows code-complete (notify/voice branches), unverified |

## Channels
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Count | 24+ | ~21 adapters | 8 (Telegram, Discord, Slack, iMessage, Email, Matrix, Signal, WhatsApp) + notify push |
| Voice memos | ✓ | ✓ | ✓ (local whisper, never cloud) |
| Pairing/allowlist security | pairing codes | pairing codes | ✦ **team mode**: per-channel roster of allowlisted principals + roles, role only NARROWS the sandbox (forged role never reaches local), per-principal attribution + `urfael audit` trail. See docs/TEAM-MODE.md |
| Next | — | — | (Telegram/Discord/Slack/iMessage/Email all shipped; owner-allowlisted + auto-sandboxed) |

## Memory & recall
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Curated memory file(s) | MEMORY.md + daily notes | MEMORY.md (2.2k cap) + USER.md | ✦ MEMORY/USER/LESSONS/WORKFLOW, no hard cap, git-versioned |
| Session search | memory_search (vector+kw) | FTS5 SQLite | ✦ **hybrid recall at scale**: a persistent BM25 **inverted index** (the FTS5-equivalent, pure-JS, no native dep) — built once, kept warm, persisted, caught up INCREMENTALLY by a per-file byte watermark, covering the **whole archive** (not a tail window) with O(query-term) lookups; the BM25 shortlist is re-ranked by optional local semantic vectors via RRF (paraphrases with zero shared tokens surface); fail-soft to a bounded scan, no cloud, no DB to corrupt |
| Consolidation | "dreaming" pass | post-turn background review | ✓ end-of-conversation distill (cheaper; per-turn review planned as opt-in) |
| User modeling | — | Honcho dialectic | ✓ structured **USER.md** + opt-in **per-turn theory-of-mind dialectic** (`URFAEL_USERMODEL`): infers the user's goals/intent/values and predicts likely next needs, refined IN PLACE each turn — framed-untrusted, write-scoped to USER.md, no separate service/DB. Distill still updates the durable model at conversation end |

## Interop & migration
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Migration importer | — | ✓ `claw migrate` (imports OpenClaw) | ✦ `urfael import` imports from **both** OpenClaw and Hermes (memory + skills; foreign skills safety-scanned, DANGER skipped) |
| OpenAI-client interop | ✗ | ✓ (OpenAI-compatible server) | ✓ token-gated localhost OpenAI API |

## Skills & self-improvement
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Skill hub / marketplace | ClawHub (~20% malware) | agentskills.io | ✦ `urfael hub` — every install scanned + **sha256-pinned** + previewed, **never executed**: the app store with a security guarantee (the poisoned-listing class can\'t install) |
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Skill files | ClawHub registry | reflective phase + curator + hub | ✓ reflective distill + opt-in per-turn review (URFAEL_REVIEW) → `_urfael/skills/`; prove-wrong → fix/delete |
| Skill registry | ✦ (and poisoned — 20% malware) | hub + trust tiers | deliberately none (security); Claude Code skills work natively |
| Periodic curator | — | ✓ (7-day cycle, usage telemetry) | ✓ opt-in N-day curator (URFAEL_CURATOR_DAYS): consolidate/fix/delete stale skills, cadence survives restarts |

## Proactivity & scheduling
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Heartbeat (main-session checklist, silence contract) | ✦ invented it | ✗ | ✓ HEARTBEAT.md + HEARTBEAT_OK + active hours + busy-backoff |
| Cron / NL scheduling | ✓ | ✓ rich (chaining, no-agent scripts) | ✦ reminders + **scheduled jobs** (`/cron`): run the brain (read/fetch-only sandbox) OR a **no-agent shell script** (`--script`, opt-in `URFAEL_SCRIPT_CRON`, no-LLM, owner-authored), **chain** a `--then` follow-up on completion (output threaded as `$URFAEL_PREV` / untrusted context, depth-bounded), deliver via notify/say/push/[silent] |
| Event triggers (webhooks, email push) | ✓ | ✓ | ✦ **webhook event triggers** — a LOOPBACK-only receiver (the daemon never opens a port), each hook gated by its own 256-bit secret (sha256-hashed, constant-time), payload framed UNTRUSTED; the `ask` action runs the brain NO-EGRESS (Read/Grep/Glob), result to the owner only. Tunnel it yourself for external events. See docs/HOOKS.md |

## Agents & execution
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Subagents | sessions_* tools | delegate_task + orchestrator depth | ✓ inherited (Claude Code Agent tool) |
| Background jobs | ✓ | ✓ | ✓ detached, cancellable, phone-push |
| Goal loop | — | /goal Ralph-loop | ✦ guard-railed goal-loop (caps, kill-switches, never pushes) |
| Exec backends | local + sandboxes | 6 (Docker/SSH/Modal/…) | local + Docker-isolated goal-loop (--sandbox docker[-net], --network none, staged auth only, caps) |
| Code-exec RPC | — | execute_code w/ tool RPC | ✓ inherited (Bash + scripts) |

## Model layer
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Providers | many | 300+ via portals | Claude only — **by design** (flat-rate subscription, zero keys) |
| Routing | fallback chains | manual + aux models | ✓ sticky Sonnet↔Opus escalation; env overrides |
| Usage visibility | ✓ | /usage + quotas | ✓ tokens/turn telemetry, Hearth, CLI status |

## Security (our moat — keep it)
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Track record | CVE-2026-25253, 20-40k exposed gateways, poisoned registry | clean but lightly audited | ✦ no network port (unix socket 0600), fail-closed profiles, nonce envelopes, read-only remote default |

## UX bar (from the 2026 HIG/NN-G research — applies to every surface)
- pin-to-bottom streaming with jump-to-latest; never fight the reader's scroll ✓
- tool activity as one-line rows, collapsed by default ✓ · Stop control during generation ✓ (POST /abort: Console Stop+Esc, ⌘., orb barge, CLI Ctrl+C/stop)
- Enter/Shift+Enter, ↑ recall, ⌘1-6 views ✓ · ⌘K/⌘P command palette ✓ (fuzzy, focus-trapped) · ⌘F archive search
- WCAG: ≥4.5:1 body text, focus-visible rings, ≥24px targets, prefers-reduced-motion ✓
- empty states teach with suggested prompts ✓ · native menu bar with full accelerators ✓ · dock badge while thinking ✓
- 70ch reading width, dark elevation via borders not shadows ✓

## Build order
DONE (workflow 1+2, adversarially reviewed): abort/stop everywhere · ⌘K command palette ·
native menu bar + dock badge · Slack + iMessage bridges · Docker-isolated goal-loop ·
token-gated localhost dashboard · skill curator (URFAEL_CURATOR_DAYS) · per-turn review (URFAEL_REVIEW).

SHIPPED since (workflow 3, adversarially reviewed): Email bridge (IMAP IDLE, draft-only) ·
`urfael tui` full-screen cockpit · BM25 ranked recall (daemon /recall) · macOS menu-bar tray.

SHIPPED since: OpenAI-compatible API (`urfael serve`), scheduled agent jobs (`urfael cron`), migration importer (`urfael import`), email MIME decode, Linux port.

SHIPPED since (workflow 4, adversarially reviewed): **webhook event triggers** (`urfael hooks` + `urfael hook add`) —
the last hard ✗. A loopback-only receiver forwards (secret, payload) to the daemon over the socket; the daemon
checks a per-hook 256-bit secret constant-time against a sha256-hashed registry and runs a `notify` (no LLM) or a
no-egress, untrusted-framed `ask`. The moat holds: no daemon port, no enumeration, no shell/write/web on a trigger.

REMAINING (deliberate non-goals in *italic*, real-but-optional otherwise):
1. *200+ model providers* — conflicts with the claude-CLI harness (speed, flat-rate, the clean ToS story); other models work today via a documented proxy on the user's own keys.
2. *Serverless exec backends (Modal/Daytona)* — paid third-party infra; SSH covers remote.
3. Channel breadth beyond 8 (Mattermost/Teams/etc.) — low value per unit, each unverified without an account.
4. ~~Honcho-style per-turn dialectic user modeling~~ shipped — opt-in `URFAEL_USERMODEL` theory-of-mind dialectic refines a structured USER.md per turn; distill still keeps the durable model at conversation end.
5. Windows port; richer TUI (modal pickers, live multi-session). ~~embedding recall over BM25~~ and ~~recall-at-scale~~ shipped (persistent inverted index + RRF vector re-rank).
6. *Battle-testing at scale* — only real users and time add this.
