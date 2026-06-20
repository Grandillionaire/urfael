# Parity map — Urfael vs OpenClaw vs Hermes Agent

> The standing goal: everything they have, we have — smoother. This file is the tracked work-list,
> built from deep teardowns of both projects (June 2026). Status: ✦ better · ✓ parity · ◐ partial · ✗ missing.
>
> **Strategy + sequenced roadmap:** [docs/IMPROVEMENT-PLAN.md](docs/IMPROVEMENT-PLAN.md) — how Urfael beats both *combined* via the trust-kernel thesis, not feature-union.
> Urfael's structural advantage: the brain is the `claude` CLI, so Claude Code's whole tool surface
> (files, shell, web, MCP, subagents, skills) is inherited, not reimplemented.

## Honesty calibration — adversarial code-audit (re-run June 2026, post-improvement-campaign)

A 21-agent audit re-verified every row against the *current* source, with a skeptic pass that downgraded any
claim the code didn't earn. **Code-verified tally: 12 better · 26 parity · 18 partial · 1 missing** (up from
9/24/25/1 before the campaign — `partial` fell 25→18 and the one "missing" changed from a real gap to a
deliberate non-goal). Verdict: **Urfael matches or beats Hermes on every *real* capability** — read the
`✦`/`✓` marks through these caveats:

- **Nothing real is missing.** The lone "missing" row is a *dedicated hosted user-modeling service/DB* (Honcho-
  style) — a deliberate architecture choice (Urfael keeps the model local in an auto-injected USER.md), not an
  absent capability. The earlier real gap (email-push triggers) is now shipped.
- **Genuinely ahead (the 12 wins):** the security posture (no inbound port, fail-closed roster, role-scoped
  sandboxes, SSRF-filtered relay, **91/91 benchmark across 10 attack classes**), self-verifying learning (quality
  gate before trusted memory), ranked persistent recall, the 7-day curator, the isolated never-push `/goal` loop,
  the migration importer, and the paranoid never-execute skill install.
- **A craft layer neither competitor invests in** (see "Craft & developer experience" below): `urfael doctor`
  (self-healing health card), the Hearth status card with a real token sparkline, `why`/`forget` rendered as
  checkable citations + tombstone receipts, did-you-mean, persona auto-fill, and the runic terminal identity.
  Net-new June 2026, benchmark-guarded against regression. The trust moat is the wedge; this is the wedge made
  *felt*.
- **Honest "parity, not better"** (the skeptic's repeat finding — "better" on an *unverified* Hermes baseline is
  not earned): voice, first-run onboarding, session search, the usage budget, curated USER.md, background jobs,
  cadence control. All real and complete; treat as parity.
- **Opt-in / off by default** (present + tested, dormant until enabled): semantic-vector recall, the per-turn
  user-model dialectic + predictive heartbeat, no-agent script cron + the script library, the webhook receiver +
  universal relay, pairing self-enroll (wired in the Telegram bridge so far). Secure-by-default off, not absent.
- **Deliberate non-goals** (a choice, not a loss): Claude-only vs 300+ providers / model routing; no paid
  serverless exec backends (local + Docker + SSH exist; Modal/Daytona do not).
- **Verification-gated:** the Electron GUI ships unsigned; Windows is code-complete but unproven (no hardware);
  the skill-hub registry URL 404s until stocked; voice/STT/TTS depend on install + opt-in.

## Surfaces
| Capability | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Desktop app (chat, streaming tool rows, sessions, settings) | menu-bar app | Electron+React | ✓ **Console** (chat, archive, reminders, jobs, hearth, settings) |
| CLI | `openclaw …` | TUI-first, rich | ✦ `urfael` CLI **and** `urfael tui` — a **flicker-free** full-screen cockpit (differential renderer: only changed rows repaint, one `2J` the whole session — verified live at 48 animation frames/turn). A **runic worker animation** (the wordmark `ᚢᚱᚠᚨᛖᛚ` lighting one rune at a time, wall-clock-timed so a dropped tick never stutters) with dry-voice status verbs (divining / recalling / scrying afar), elapsed, an **honest `~`-prefixed token estimate that snaps to the authoritative count on done**, and the live tool. Gold title bar (rune wordmark + `ᚦ` mode + 7-day sparkline), a `┤you├` pill, a `ᚢ urfael` sigil column, collapsed tool rows, a streaming `▌` caret, per-answer done-footer. **Customizable**: themes (gold/ember/mono/custom accent) + `^T`/`^Y` live cycling, fps, compact, timestamps, and an auto `reduce-motion` for ssh/screen-readers — all via `URFAEL_TUI_*`. Zero deps; restore-discipline intact |
| Voice (wake word, PTT, barge-in, local STT/TTS) | wake word, talk mode | CLI PTT, voice memos | ✓ all local, all real — but **off by default / verification-gated**: PTT + spoken remarks in the Console; wake-word + barge-in + voice memos live in the opt-in orb HUD (`URFAEL_ORB=1`, wake-word also needs a Picovoice key); local STT/TTS are install-gated (whisper-cpp / espeak-ng). Parity, not a demonstrated edge |
| Web dashboard | ✓ | ✓ | ✓ token-gated localhost dashboard (surfaces vitals, usage+budget, reminders, jobs, the learning ledger + team audit trail; **ask now STREAMS token-by-token** to the browser). Functionally parity; **security-hardened** — 127.0.0.1-only, constant-time token, no path serving (off-box access needs your own tunnel) |
| Mobile nodes / canvas | iOS/Android, A2UI canvas | ✗ | ✗ — non-goal for now (phone via bridges) |
| REST API | WS gateway | OpenAI-compatible REST | ✓ OpenAI-compatible `/v1/chat/completions`+`/v1/models` (127.0.0.1-only, token-gated) — drives Open WebUI/LibreChat/any OpenAI client |
| Inbound agent-serve (editor/agent drives it) | — | `mcp serve` (messaging inbox) | ✦ `urfael acp` — an **Agent Client Protocol** stdio bridge (Zed/JetBrains/Neovim/VS Code spawn it) that streams Urfael as the editor's backend brain, **opening NO new inbound port**: it rides the existing `0600` socket, never `.listen()`s (frozen benchmark). Pure translator unit-tested; live editor round-trip is the cert step. Honest: spawning it grants the editor owner-equivalent authority (single-user), and editor-supplied MCP servers are dropped to keep the owner-turns-only moat. See docs/ACP.md |

## Onboarding & packaging
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| First-run onboarding | installer | guided | ✓ dual-surface (GUI first-run card in the Console + `urfael setup` CLI wizard, both wired, 0600-atomic). Real and complete; "better than a guided flow" is an unverifiable comparative → parity |
| Packaged installer | ✓ | one-line curl | ✓ **one-line curl** (`get.sh` — clones + runs install.sh, read-it-first short) **and** electron-builder + CI pipeline (dmg/AppImage/nsis); GUI-installer signing still needs certs |
| OS coverage | broad | broad | ◐ macOS solid · Linux supported · Windows code-complete (notify/voice branches), unverified |

## Channels
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Count | 24+ | ~21 adapters | 11 first-class (Telegram, Discord, Slack, iMessage, Email, Matrix, Signal, WhatsApp, QQ, SimpleX, **+ a live two-way PSTN phone channel** via Twilio — Twilio does the STT/TTS, Urfael fronts a **loopback-only** receiver behind your own tunnel and opens no public port, HMAC-verified before the brain, the caller number allowlisted; the relay can't reach QQ/SimpleX/phone, so these are native bridges, allowlist-before-the-brain, code-complete + unit-tested but not yet live-certified, same honest status as Matrix/Signal/WhatsApp) **+ a universal `relay` channel** (`urfael hook add --action relay`): one verified code path turns ANY platform with an in/out webhook — Teams, Mattermost, Google Chat, **or Zapier/n8n/Make → hundreds of apps** — into a two-way channel, **plus** Matrix as a federation hub (its bridge ecosystem reaches Telegram/Discord/WhatsApp/IRC/SMS/…). Breadth is architectural, not 21 bespoke adapters to maintain |
| Voice memos | ✓ | ✓ | ✓ (local whisper, never cloud) |
| Pairing/allowlist security | pairing codes | pairing codes | ✦ **team mode** + **self-enroll pairing** (`urfael team pair`): owner mints a single-use, TTL-bounded code; a new sender DMs it and is enrolled as a **guest ONLY** (the role is hard-coded — a code can never mint owner/member, even if leaked), redemption constant-time + single-use. Plus the per-channel roster, role-only-narrows sandbox (forged role never reaches local), per-principal attribution + `urfael audit`. See docs/TEAM-MODE.md |
| Next | — | — | (Telegram/Discord/Slack/iMessage/Email all shipped; owner-allowlisted + auto-sandboxed) |

## Memory & recall
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Curated memory file(s) | MEMORY.md + daily notes | MEMORY.md (2.2k cap) + USER.md | ✦ MEMORY/USER/LESSONS/WORKFLOW, no hard cap, git-versioned |
| Session search | memory_search (vector+kw) | FTS5 SQLite | ✓ **ranked recall at scale**: a persistent BM25 **inverted index** (FTS5-equivalent, pure-JS, no native dep) — warm, persisted, incrementally caught up by a per-file byte watermark, covering the **whole archive** with O(query-term) lookups; BM25 shortlist re-ranked by optional local vectors via RRF; fail-soft, no cloud. Architecturally parity-grade with FTS5 (a genuine win only vs substring grep) |
| Consolidation | "dreaming" pass | post-turn background review | ✓ end-of-conversation distill (cheaper; per-turn review planned as opt-in) |
| User modeling | — | Honcho dialectic | ✓ structured **USER.md** + opt-in **per-turn theory-of-mind dialectic** (`URFAEL_USERMODEL`): infers the user's goals/intent/values and predicts likely next needs, refined IN PLACE each turn — framed-untrusted, write-scoped to USER.md, no separate service/DB. Distill still updates the durable model at conversation end |

## Interop & migration
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Migration importer | — | ✓ `claw migrate` (imports OpenClaw) | ✦ `urfael import` imports from **both** OpenClaw and Hermes (memory + skills; foreign skills safety-scanned, DANGER skipped) |
| OpenAI-client interop | ✗ | ✓ (OpenAI-compatible server) | ✓ token-gated localhost OpenAI API, now with **real token usage** in responses (`prompt`/`completion`/`total_tokens`, cached reads counted as input) + an opt-in `stream_options.include_usage` final chunk — so LibreChat/cost-meter clients read true spend, not zeros |

## Skills & self-improvement
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Skill hub / marketplace | ClawHub (~20% malware) | agentskills.io | ✦ `urfael hub` — every install scanned + **sha256-pinned** + previewed, **never executed**: the app store with a security guarantee (the poisoned-listing class can\'t install) |
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Skill files | ClawHub registry | reflective phase + curator + hub | ✓ reflective distill + opt-in per-turn review (URFAEL_REVIEW) → `_urfael/skills/`; prove-wrong → fix/delete |
| Skill registry | ✦ (and poisoned — 20% malware) | hub + trust tiers | deliberately none (security); Claude Code skills work natively |
| Periodic curator | — | ✓ (7-day cycle, usage telemetry) | ✦ N-day curator **ON by default (7-day)**, `URFAEL_CURATOR_DAYS=0` to disable: consolidate/fix/delete stale skills, cadence survives restarts — and **safer** than Hermes's (it never *executes* a skill). Ledger pruning is genuinely **usage-weighted** — a lesson the distiller re-derives is reinforced (confidence climbs), bad lessons retire via the verify gate + confidence floor |

## Proactivity & scheduling
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Heartbeat (main-session checklist, silence contract) | ✦ invented it | ✗ | ✦ HEARTBEAT.md + HEARTBEAT_OK + active hours + busy-backoff, **plus opt-in predictive mode** (`URFAEL_PREDICT=1`): the heartbeat reads USER.md's "likely next" and PREPARES a ready-to-act offer for any prediction already ripe — surface-only, never acts |
| Cron / NL scheduling | ✓ | ✓ rich (chaining, no-agent scripts) | ✦ reminders + **scheduled jobs** (`/cron`) with the **richest repeat vocabulary**: natural-language + **5-field cron-syntax** (`*/15 9-17 * * 1-5`) + **weekday recurrence** (`mon,wed,fri @07:30`, `weekdays`, `weekend`) + dailyAt + everyMins. Runs the brain (read/fetch-only sandbox) OR a **no-agent shell script** (`--script`, opt-in `URFAEL_SCRIPT_CRON`), **chains** a `--then` follow-up (output threaded as `$URFAEL_PREV`, depth-bounded), delivers via notify/say/push/[silent] |
| Event triggers (webhooks, email push) | ✓ | ✓ | ✓ **webhook triggers** — a LOOPBACK-only receiver (the daemon never opens a port; OFF until `urfael hooks`, tunnel it yourself for public events), per-hook 256-bit secret (sha256-hashed, constant-time), payload framed UNTRUSTED, no-egress `ask`. **AND native email-push triggers** — `EMAIL_TRIGGERS=[{from?,subject?,action:notify\|ask}]`: a matching inbound email fires a one-way push to the owner (the "when email matching X arrives, do Y" primitive). See docs/HOOKS.md |

## Agents & execution
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Subagents | sessions_* tools | delegate_task + orchestrator depth | ✓ inherited (Claude Code Agent tool) |
| Background jobs | ✓ | ✓ | ✓ detached, cancellable, phone-push |
| Goal loop | — | /goal Ralph-loop | ✦ guard-railed goal-loop (caps, kill-switches, never pushes) |
| Exec backends | local + sandboxes | 6 (Docker/SSH/Modal/…) | local + Docker-isolated goal-loop (--sandbox docker[-net], --network none, staged auth only, caps) |
| Connectors / integrations | ClawHub plugins `install <src>:<pkg>` (secret value in a 0600 config, **restart required**) | `hermes mcp` + 300+ tools (0600 config/env, **restart required**) | ✦ `urfael connect` — connectors **are MCP servers**, so the whole **18,000+ server ecosystem** is reachable; the popular ones are one command with a **pre-enable security preview + static scan**, a **masked secret prompt** (passed as an `execFile` argv → never in `~/.zsh_history`), **no restart**, and **owner-turns-only** (`--strict-mcp-config` on every sandbox). The setup the rest of the field doesn't ship; frozen as a benchmark check (91/91) |
| Code-exec RPC | — | execute_code w/ tool RPC | ✦ inherited Bash + a **saved-script library** (`urfael script add/run`, opt-in `URFAEL_SCRIPT_CRON`): register an owner shell body once, call `/script/<name>/run` with args from any turn — the *trustworthy* execute_code. The body is owner-registered; caller args arrive as positional `$1..$N` (argv, **never** concatenated → injection-safe, proven in the benchmark), so an injected turn can only parameterize a pre-approved script, never run arbitrary code |

## Model layer
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Providers | many | 300+ via portals | ✦ **first-class provider management** (`urfael model providers` / `use <id>` / `test <id>`): the flat-rate Claude subscription is the default + the thesis, AND a curated registry (`config/providers.json`, twin of connectors) switches the brain to OpenRouter/DeepSeek/Ollama/LM Studio/vLLM/Bedrock/Vertex/your-proxy in one command, on **your own key/hardware** (masked prompt, 0600, never shell history). One write point, forwarded to every spawn (a frozen drift-guard proves it); tier-pin composes within a provider; NL "use ollama" / "back to my subscription" is recognized (anti-hijack tested). Honest: reach is not hosting (no proprietary-model padding), a local model is not Claude-grade, and v1 reaches proxies rather than supervising them |
| Routing | fallback chains | manual + aux models | ✓ sticky Sonnet↔Opus auto-escalation **+ explicit per-turn override** (`/opus …` / `/sonnet …`, stripped before the brain) + env overrides |
| Usage visibility | ✓ | /usage + quotas | ✓ tokens/turn telemetry + Hearth + CLI status + an **enforced self-imposed budget** (`URFAEL_BUDGET_TURNS`/`_TOKENS` rolling window; warn 80%, hard-stop at 100% under `URFAEL_BUDGET_HARD=1`) in honest turns+tokens. Parity: it can't read the provider's real subscription quota, and enforcement is double-opt-in |

## Security (our moat — keep it)
| | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Track record | CVE-2026-25253, 20-40k exposed gateways, poisoned registry | clean but lightly audited | ✦ no network port (unix socket 0600), fail-closed profiles, nonce envelopes, read-only remote default |
| **Ledger of Record** (prove what your agent did) | ✗ (YOLO, no per-action record) | ✗ (plain rewritable telemetry) | ✦ **NET-NEW**: every turn / remote turn / job / cron / hook / learn-verdict is appended to a **tamper-evident sha256 hash chain** (`h = sha256(prevH + canonicalJSON(entry))`) in the git-tracked memory repo. `urfael audit --verify` walks it and pinpoints the FIRST broken link — any edit, deletion, or reorder is mathematically detectable. Provenance neither competitor structurally has |
| **Sovereign Seal** (a signed record) | ✗ | ✗ | ✦ **NET-NEW**: an owner **ed25519** keypair (private 0600 + credential-denied; public committed) signs the ledger head — `urfael seal` mints a signed attestation, `urfael seal --verify` proves only the owner's key could have, AND re-verifies that history wasn't rewritten *below* the seal. Honest scope: it proves authorship + integrity of the record at a moment, not that any claim is true |
| **`urfael why`** (where a belief came from) | ✗ | ✗ (beliefs trusted blind) | ✦ **NET-NEW**: a git pickaxe walks any stored belief back to the exact commit / date / pass that introduced it — a checkable SHA, or an honest "inferred live, not stored" |
| **Memory time-travel + honest forgetting** | ✗ | ✗ (in-place rewrite, accrue-only) | ✦ **NET-NEW** trio over the git-versioned memory: `urfael as-of <date>` reconstructs what it believed on a past date (can't leak present knowledge backward); `urfael drift` shows the belief changelog (what was added/revised/removed, when); `urfael forget "<phrase>"` removes a belief + leaves a git **tombstone** (date + content + reason) + a ledger entry — so even *deletion* is consented and provable |

## Craft & developer experience (the "made for you" layer — neither competitor invests here)
| Capability | OpenClaw | Hermes | Urfael |
|---|---|---|---|
| Terminal identity | text banner | text banner | ✦ gold ANSI-shadow logo + the Elder Futhark name **ᚢᚱᚠᚨᛖᛚ** woven through every surface (install sections spell URFAEL top-to-bottom); a runed `ᚦ fortress` glyph marks the security posture at a glance |
| Health diagnostics | — | — | ✦ **`urfael doctor`** — one framed card: deps, brain, memory (readable **AND writable**), provider, persona, ledger, seal; **every red line carries its own one-command fix**, and it runs *before* spawning the brain so it can diagnose a down daemon. Built directly from the QA-found memory bug — it would have caught it |
| Status / vitals | flat text | flat text | ✦ **the Hearth** — a bordered gold card: model, a real **7-day token sparkline** (additive `/vitals` field, scaled to actual logged turns — never a fabricated trend), facts-known count, live ledger-seal badge, uptime |
| Provenance display | — | — | ✦ **`urfael why`** renders a **paste-ready citation** ("distilled on 10 June 2026 · `<sha>` · `git show <sha>`") — a checkable source, the date a pure reformat of the stored commit (no present-time leak) |
| Provable deletion UX | — | — | ✦ **`urfael forget`** prints a dignified **tombstone receipt** (struck-through removed lines + the git-committed record) — deletion made as visible as the data it removed |
| Typo handling | — | — | ✓ **did-you-mean**: a lone mistyped command (`urfael stauts`) is caught (edit-distance ≤1, transposition-aware) and suggested **before** it silently spends a turn — a genuine correctness fix; a real one-word question still reaches the brain. (Table-stakes for a good CLI → parity, but neither competitor does it) |
| Help & discoverability | full manual dumped | full manual dumped | ✦ **progressive disclosure** from one `registry.js` source of truth: bare `urfael` → a framed "start here" card (the ~6 first-use commands + an honest "N more"), `urfael help` → the full reference **grouped** into 7 labelled sections, `urfael help <cmd>` → focused usage + 2-3 copy-pasteable examples + related. Pipe-clean / `NO_COLOR`-aware; a drift-guard test fails the build if a command's help and its dispatch branch ever disagree. (Replaces a 40-line wall that also leaked code comments) |
| Verbal model switching | `/model` slash, per-turn | per-turn | ✦ **just ask in chat** — "switch to opus", "use the fast model", "go back to auto", "what model are you on" — a persistent pin that overrides auto-routing, survives restarts, shared by every channel (TUI/CLI/voice/chat). Also `urfael model [opus\|sonnet\|auto]`; the Hearth shows it. A precise NL parser (44 cases incl. negatives) never hijacks a real task |
| Selectable personas | — | — | ✦ **switchable personalities** (Urfael the dry butler + Architect ᚨ / Sage ᛖ / Operator ᛏ / Muse ᚹ / Analyst ᛁ) — same capability, different *approach* to dialogue and advice. Switch by asking ("be the architect", "back to urfael") or `urfael persona <id>`; **user-authorable** (git-versioned `personas.json`). A persona is a **voice overlay only** — the moat is harness/vault-enforced, so even an authored "you have root" persona rides under an **un-removable safety clause** (4 benchmark checks; 91/91). The anchor = absence of overlay → byte-identical to today |
| Onboarding friction | manual edits | guided | ✦ `urfael setup` **auto-detects + fills** the `{{USER_NAME}}`/`{{CITY}}`/`{{TIMEZONE}}`/`{{LANGUAGE}}` placeholders (git/email/system tz+locale) on one Enter — kills the #1 forgotten first-run step (the brain used to literally address you as "{{USER_NAME}}") |
| Voice under failure | raw errors | raw errors | ✓ the composed "sir" register holds in the highest-visibility error paths (brain unreachable/asleep), each pointing at `urfael doctor` — character integrity without papering over a real failure |

*All of the above are net-new in June 2026, unit- + benchmark-guarded (91/91, incl. a "correctness & craft regressions" class that fails the build if did-you-mean, the doctor's writability check, the real sparkline, or the provenance SHA ever regress). Scored honestly: did-you-mean is parity (table-stakes), the rest are genuine differentiation because the felt experience — not the raw capability — is the point.*

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

SHIPPED since (the "every Hermes feature" sweep, each adversarially reviewed + tested + committed):
- **webhook event triggers** (`urfael hooks` + `urfael hook add`) — the last hard ✗. A loopback-only receiver
  forwards (secret, payload) to the daemon over the socket; the daemon checks a per-hook 256-bit secret
  constant-time against a sha256-hashed registry and runs a `notify` (no LLM) or a no-egress, untrusted-framed
  `ask`. No daemon port, no enumeration, no shell/write/web on a trigger.
- **recall at scale** — a persistent BM25 inverted index (the FTS5-equivalent, pure-JS): warm, persisted,
  caught up incrementally by a byte watermark, covering the WHOLE archive with O(query) lookups; the BM25
  shortlist is re-ranked by semantic vectors via RRF. Fail-soft to the legacy scan.
- **per-turn user-model dialectic** (`URFAEL_USERMODEL`) — Honcho-equivalent theory-of-mind: infers goals/
  intent/values + likely next needs, refines a structured USER.md in place, framed-untrusted + write-scoped.
- **cron chaining + no-agent script jobs** — `--script` (no-LLM shell, opt-in `URFAEL_SCRIPT_CRON`) and `--then`
  chaining (output threaded as `$URFAEL_PREV` / untrusted context, depth-bounded).
- **one-line curl installer** (`get.sh`) — clones + runs install.sh; read-it-first short, clone path recommended.

REMAINING — only VERIFICATION-blocked residuals + deliberate non-goals (*italic*); no missing Hermes *capability*:
1. *200+ model providers* — conflicts with the claude-CLI harness (speed, flat-rate, the clean ToS story); other models work today via a documented proxy on the user's own keys.
2. *Serverless exec backends (Modal/Daytona)* — paid third-party infra; SSH covers remote.
3. Channel breadth — **answered architecturally** (the universal `relay` channel + Matrix federation hub), so breadth is one verified code path, not 21 bespoke adapters. A few platforms still warrant a *native* first-class bridge (richer than a webhook relay); those are account-gated to verify, so we won't ship them claiming they work.
4. Windows port — code-complete (notify/voice branches), **hardware-gated** verification; richer TUI (modal pickers, live multi-session) is polish.
5. *Battle-testing at scale* — only real users and time add this.
