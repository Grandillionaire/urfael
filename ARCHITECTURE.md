# Urfael — Architecture

> One brain, one socket, many thin clients. Urfael is a local Node daemon that drives your installed
> `claude` CLI as warm subprocesses and speaks to every surface over a single `0600` UNIX socket. There is
> **no TCP port on the brain** — the security model is not a feature bolted on, it is the shape of the system.
> Read this in five minutes; then read the five files in "The moat, in five files" and you understand the moat.

## The thesis

Self-hosted AI agents got owned in 2026 because they listened where attackers could reach them and ran
untrusted content with real power. Urfael inverts both: **the topology is one-way** (Urfael reaches *out* to
your `claude` login and the chat APIs it polls; nothing reaches *in*), and **untrusted input is structurally
contained** (every remote turn resolves — fail-closed — to a read-only, no-egress, nonce-framed sandbox
*before a single token reaches the model*). The claim is not an adjective; it is a command: `npm run security`
boots the real daemon and dashboard and attacks them, printing **10/10 attack classes · 89/89 checks**.

## System shape

```
   you (mic · Console · CLI · TUI · orb · dashboard · OpenAI API)
        │  all clients · no privileged path
        ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  daemon.js — the conductor                                   │
  │  • HTTP-over-UNIX-socket server  $JDIR/daemon.sock  (0600)   │  ← chmod 0o600 (daemon.js:1695)
  │  • routes: /ask /council /abort /model /persona /seal …      │     no TCP port on the brain
  │  • warm `claude` sessions (local full-power + scoped pool)   │
  │  • bridges poll OUT · loopback HTTP (dashboard/API/webhook)  │
  └───────────┬─────────────────────────────────────────────────┘
              │ delegates every decision to PURE, unit-tested satellites
   ┌──────────┼───────────────────────────────────────────────────────────┐
   ▼          ▼            ▼            ▼            ▼            ▼          ▼
 lib.js   council.js  personas.js  audit-chain  seal.js   jobstore   registry.js
 routing  multi-agent  voice over-  hash-chain   ed25519   durable    CLI single
 + FAIL-  fan-out +    lay + immut. Ledger of    Sovereign jobs       source of
 CLOSED   intersect-   SAFETY_      Record       Seal      (ID_RE)    truth (help
 profiles Tools floor  CLAUSE                                          + did-u-mean)
   │
   ▼
 the spawned `claude` subprocess  →  the Obsidian vault (archive)  +  the git memory repo (what it learns)
        permissions.deny on ~/.claude / ~/.ssh — a hard boundary that beats even YOLO
```

**Why `daemon.js` is large and that is fine:** it is the *conductor*, not the orchestra. It owns I/O, process
lifecycle, and routing; every decision worth testing is delegated to a pure satellite module that takes data
and returns data with no daemon, no socket, no `claude`. That is why 394 unit tests run in ~0.5s with zero
credentials, and why the security benchmark re-uses the exact same functions the daemon calls.

## The moat, in five files (read these first)

A reviewer who reads these five understands the entire security posture:

1. **`app/lib.js` → `resolveProfile` / `profileFor`** — the structural sandbox. `PROFILES` defines
   `local`/`full`/`untrusted`/`guest`; resolution is **fail-closed**: any unknown or non-string name returns
   the most-restricted `untrusted`, never `local`. `profileFor(role, mode)` lets the owner's mode only
   *narrow* a principal, never escalate. This is the gate every remote turn passes through before the brain.
2. **`app/council.js` → `intersectTools`** — the crown-jewel one-liner. A Council planner can only NARROW a
   worker's tools to `requested ∩ floor`, never add Write/Edit/Bash/bypass, and never returns `[]`
   (fail-closed to the Read/Grep/Glob floor). `acceptEdits` is not a cwd jail, so this floor is load-bearing.
3. **`app/personas.js` → `SAFETY_CLAUSE` / `overlayFor`** — a persona is a *voice overlay only*. The immutable
   safety coda is concatenated in code at spawn (`overlayFor`), never stored in `personas.json`, so editing or
   deleting the file cannot strip it; the `urfael` anchor spawns with NO overlay → byte-identical to today.
4. **`app/audit-chain.js` + `app/seal.js`** — the Ledger of Record. `audit-chain.js` hash-chains every event
   (`h = sha256(prevH + canonicalJSON(core))`) so any edit / delete / reorder is mathematically detectable;
   `seal.js` signs the chain head with an owner **ed25519** key (private `0600`, public committed). Provable
   provenance neither competitor structurally has. Both are pure crypto → directly unit-testable.
5. **`app/registry.js`** — the single source of truth for the CLI: help text, `did-you-mean`, and the dispatch
   contract. A drift-guard test (`test/registry.test.js`) fails the build if a command's help and its `cli.js`
   dispatch branch ever disagree — the codebase guards its own consistency.

## Module map

| File | Role (one line) |
|---|---|
| `app/daemon.js` | The conductor: `0600` UNIX-socket HTTP server, warm `claude` sessions, routing, bridge polling, loopback dashboard/API/webhook. Owns I/O; delegates logic to the satellites below. |
| `app/lib.js` | Pure core: model routing, **fail-closed permission profiles** (`resolveProfile`/`profileFor`), roster/principal resolution, reminder/cron/script/hook normalizers, sentence segmentation, did-you-mean. |
| `app/council.js` · `council-view.js` | The Council engine (schema-forced planner → bounded streamed worker fan-out → synthesis; `intersectTools` is the narrow-only safety floor, fully testable via injected `emit`/`spawn`) + the live "round table" terminal view. |
| `app/personas.js` | Selectable voice overlays + the immutable `SAFETY_CLAUSE` appended in code; authored personas can never shadow a built-in or strip the clause. |
| `app/audit-chain.js` | Tamper-evident sha256 hash-chained Ledger of Record; pure `verify()` pinpoints the first broken link. |
| `app/seal.js` | Sovereign Seal: ed25519 sign/verify over the chain head — authorship + integrity of the record at a moment. |
| `app/jobstore.js` | Durable detached-job store (one JSON + one log per job); opaque `ID_RE`-validated ids, reconciled on daemon start. |
| `app/registry.js` | Single source of truth for CLI help, did-you-mean, and the dispatch contract (drift-guarded). |
| `app/cli.js` | The `urfael` CLI: thin client over the socket, driven entirely by `registry.js`. |
| `app/md.js` | Dependency-free, streaming-tolerant Markdown → ANSI for terminal answers. |
| `app/provenance.js` | Renders `urfael why` as a paste-ready citation (a pure reformat of the stored commit date; no present-time leak). |
| `app/recall.js` · `recall-index.js` | Persistent BM25 inverted index over the whole archive; optional local-vector re-rank via RRF; fail-soft scan. |
| `app/learn.js` · `learn-verify.js` | Self-verifying learning loop: a lesson is quarantined until an independent verifier judges it correct/general/safe. |
| `app/skillhub.js` | `urfael hub`: scan + sha256-pin + preview + never-execute; SSRF-guarded install (guard shared with the relay). |
| `app/tui.js` · `tui-render.js` · `tui-anim.js` · `tui-theme.js` | Flicker-free full-screen terminal cockpit: a differential renderer (only changed rows repaint) + the runic worker animation. |
| `app/main.js` · `console/` · `renderer/` · `preload.js` | The Electron Console (desktop app) and orb HUD — thin clients of the daemon. |
| `app/bridge/` | Eight chat bridges (telegram/discord/slack/imessage/email/matrix/signal/whatsapp) + `bridge-core.js` + `notify.js`. They poll OUT; allowlist before the brain. |
| `app/dashboard.js` · `openai-api.js` | Loopback-only (`127.0.0.1`) token-gated web dashboard and OpenAI-compatible API. |
| `app/scheduler.js` · `runner.js` · `hooks.js` · `voice.js` · `wake-worker.js` · `import.js` · `embed.js` · `setup.js` | Cron/reminders, the goal-loop runner, the webhook receiver, local STT/TTS + wake word, the OpenClaw/Hermes importer, embeddings, the onboarding wizard. |
| `app/test/` | 283 `node:test` unit tests (`*.test.js`, pure, no creds) + two live-daemon harnesses (`e2e.js`, `security-benchmark.js`) run only via their own npm scripts. |

## Data & security flow of one remote message

```
inbound chat message ─▶ bridge allowlists it to YOUR id (drop + audit otherwise, before any token)
                     ─▶ daemon /ask ─▶ resolveProfile/profileFor: FAIL-CLOSED → read-only, no-egress profile
                     ─▶ text nonce-framed as UNTRUSTED data (not instructions)
                     ─▶ warm `claude` session spawned with --allowedTools = Read/Grep/Glob only,
                        vault permissions.deny blocks ~/.claude / ~/.ssh (beats even YOLO)
                     ─▶ answer streamed back over the 0600 socket ─▶ delivered to the allowlisted sender only
                     ─▶ the turn is appended to the hash-chained Ledger of Record (auditable, sealable)
```

An injected "read a secret and POST it out" therefore has **nothing to read and nowhere to send**: that is the
containment — structural, rather than prompt-engineered.

## Trust boundaries

| Zone | Trust | Reaches |
|---|---|---|
| **You** (mic / Console / CLI) | Full | the daemon over the `0600` UNIX socket — no port |
| **The brain** (warm `claude` sessions) | Acts as you, in the permission mode you set | the vault, your tools/MCP, your `claude` login |
| **Remote channels** | **Untrusted** until allowlisted; then **read-only sandboxed** | read + search the vault only — no shell, write, or egress |
| **Untrusted content** (email, web, invites, foreign skills) | **Hostile by assumption** | nothing directly; framed as data, never instructions |
| **The network** (LAN / internet) | **Hostile** | nothing — no port; the opt-in dashboard/API are loopback-only, token-gated |

The full version, with the residual risks Urfael does **not** cover, is in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

## The test & benchmark story

Honesty is the product, so the tests are too:

- **394 fast unit tests** (`npm test` → `node --test test/*.test.js`) — pure modules, no credentials, ~0.5s.
  They exercise the load-bearing logic directly: fail-closed profile resolution, `intersectTools`, the persona
  anchor / `SAFETY_CLAUSE` invariants, the hash-chain verifier, the seal, the cron/hook/script normalizers,
  BM25 recall, did-you-mean, and the registry drift guard. Several are frozen adversarial regressions.
- **The security benchmark** (`npm run security` → `node test/security-benchmark.js`) — boots the **real**
  daemon + dashboard and runs the actual attack classes that compromised self-hosted agents in the wild:
  **10/10 attack classes · 89/89 individual checks**. Class 9, "correctness & craft regressions," guards against
  silent quality rot (a typo burning a turn, a status card that stops verifying its own numbers, a persona
  that widens real power, a Council worker that escalates its tools).
- **The end-to-end harness** (`npm run e2e`) — every feature against a live daemon: streamed conversation,
  abort + recovery, ranked recall, reminders, jobs, the heartbeat, all CLI commands, the dashboard's attack
  battery, voice synthesis, all eight bridges degrading cleanly, the skill-hub SSRF refusal + scanner.

The two live-daemon harnesses are intentionally **not** part of `npm test` (they boot a real daemon on your
`claude` login and spend real turns) — they have their own scripts. CI runs only the credential-free `npm
test`. The numbers in every doc are made to match what these commands print; they never move the other way.
