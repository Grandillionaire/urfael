# Urfael Improvement Plan

How Urfael becomes better than Hermes and OpenClaw **combined, for everyone** without becoming a worse clone of either. This is the strategy and the sequenced engineering work. The feature-status matrix lives in [PARITY.md](../PARITY.md); this is the *why* and the *order*.

## The thesis: trust is a kernel, not a property of being small

Today Urfael's security comes from being narrow. That is fragile: every new feature threatens the `npm run security` benchmark, which is why "more breadth" reads as "dilute the moat."

The strategic flip is to stop treating the wedge as a side effect of a small surface and start treating it as a **kernel every surface plugs into**. Urfael already has two such kernels:

1. **The fail-closed permission/sandbox kernel** — `app/lib.js` `resolveProfile`, the two-profile model, the credential `permissions.deny`, the no-egress untrusted profile.
2. **The verify-before-trust learning kernel** — `app/learn-verify.js` + `app/skillhub.js` (the independent verifier and the safety scanner).

Once every new channel, provider route, team member, and shared artifact is forced through those kernels, **reach stops adding attack surface and starts enrolling into the guarantee.** That is the move neither competitor can copy cheaply: their architectures put trust at the edges (broad surface, optional sandboxing); Urfael puts it at the kernel (mandatory, fail-closed). They would have to rebuild; Urfael only has to extend.

Design rule for everything below: **a feature ships only when it routes through both kernels, and `npm run security` still passes.** If a feature cannot, it is a non-goal (see the last section).

## Who each workstream serves

| Workstream | Consumers | Developers | Business |
|---|---|---|---|
| 1. Hybrid semantic recall | ✅ continuity | ✅ | ✅ |
| 2. Team / multi-owner mode | | | ✅✅ unlock |
| 3. GUI onboarding + signed installer + Windows | ✅✅ unlock | ✅ | ✅ |
| 4. Safe skill hub | ✅ | ✅✅ | ✅ |
| 5. First-class verified multi-provider | | ✅✅ | ✅ |
| 6. Launch | ✅ | ✅ | ✅ |

---

## Workstream 1 — Hybrid semantic recall *(start here)*

**Gap.** Recall is lexical BM25 only (`app/recall.js`). A paraphrased query that shares no tokens with a past turn will not surface it. This degrades the *core* promise (memory continuity) for every audience, and it is Hermes's strongest non-research differentiator (FTS5 + LLM-summarized recall + Honcho user-modeling).

**Approach (local-first, dep-free, design-aligned).**
- Add an **optional embedding backend**: an OpenAI-compatible `/v1/embeddings` endpoint (Ollama, LM Studio, or any), configured via `urfael setup` / `provider.env` (`URFAEL_EMBED_URL`, `URFAEL_EMBED_MODEL`). Reuses the local-GPU plumbing already shipped.
- Persist a **vector index** alongside the session archive in `~/Urfael-memory` (a compact JSONL of `{id, vec}`); embed each archived turn once, incrementally.
- **Hybrid ranker** in `recall.js`: keep BM25, add cosine over the vector index, fuse with **Reciprocal Rank Fusion** (robust, no score-scale tuning). New `rank()` stays backward-compatible; add `rankHybrid(entries, query, opts)`.
- **Graceful degradation**: no embedder configured → pure BM25, exactly as today. No behavior change for users who do not opt in.

**Moat-safety.** Pure-local, no cloud, no new attack surface; the embedder is the user's own endpoint. Same fail-closed posture (a corrupt index → fall back to BM25, never throw).

**Files.** `app/recall.js` (hybrid ranker, pure), a small `app/embed.js` (the optional embedder client, fail-soft), `app/daemon.js` (`/recall` uses hybrid when configured; embed-on-archive hook), `urfael setup` (configure the embedder), `app/test/recall.test.js` (RRF correctness, degradation).

**Acceptance.** A paraphrased query with zero shared tokens surfaces the right past turn when an embedder is set; identical BM25 results when it is not; index corruption degrades to BM25; unit tests + `npm run security` green.

## Workstream 2 — Team / multi-owner mode

**Gap.** Single hard-coded owner per channel. This blocks the highest-value audience (business), where the security thesis is strongest. Hermes does DM-pairing for many users.

**Approach.** Generalize the existing single-owner allowlist into **principals**: each teammate is an allowlisted principal with a role (`owner` | `member` | `guest`), and **every principal routes through the same `resolveProfile` sandbox** — a guest is just a more-restricted profile. Per-principal memory namespacing where required; shared team memory is itself passed through the verify-before-trust kernel before it becomes trusted. Admin can run `npm run security` and export the threat model + an activity log for auditors.

**Moat-safety.** This is the one place security and the business need *reinforce* each other: multi-user done as "more sandboxed principals" strengthens rather than dilutes the model. **Explicitly NOT** a hosted multi-tenant cloud that pools subscriptions (that breaks the threat model and the ToS — see non-goals). Self-hosted, each org on its own login.

**Files.** `app/lib.js` (principal resolution + roles), the bridges (principal lookup before relay), `app/daemon.js` (per-principal scoping), docs (the "agent a CISO can approve" story).

**Acceptance.** Two allowlisted principals with different roles get correctly-scoped sandboxes; a non-enrolled sender is still dropped; the benchmark still passes with multi-principal enabled; an audit export exists.

## Workstream 3 — GUI onboarding + signed installer + Windows

**Gap.** Onboarding is CLI-only; no notarized `.dmg` / `.AppImage`; macOS + Linux only. Pure adoption gaps that exclude most consumers. Zero moat cost to close.

**Approach.**
- **First-run GUI** in the Console: if `provider.env` is unset, show a setup card (the same three choices as `urfael setup`, in the app).
- **Signed/notarized builds**: an electron-builder pipeline producing a notarized macOS `.dmg`, a Linux `.AppImage`, and (then) a Windows build, in CI.
- **Windows port**: the headless core is mostly portable; the work is the OS-specific paths (notify, voice backend, launch-on-login, paths).

**Moat-safety.** Adoption only; no new privileged surface. Windows widens the OS target, tested separately.

**Acceptance.** A non-technical user installs a signed build, completes onboarding in the GUI, and talks to Urfael without a terminal; Windows runs the core + voice.

## Workstream 4 — Safe skill hub

**Gap.** OpenClaw's ClawHub shipped ~20% malware; Hermes uses an external standard. Both are "marketplaces with risk." Urfael already has the scanner + verifier + never-executes-a-skill, so it can offer the *only safe* version.

**Approach.** A lightweight hub (publish/browse/install) where **every skill passes the safety scanner and the verifier before it can be installed**, the body is always shown, and the agent never executes it. Reuse `app/skillhub.js` and the learning kernel; signed/provenanced skills; a confidence/usage signal from the ledger. Could be as simple as a curated git index to start.

**Moat-safety.** This is a category-definer, not a feature-match: "the app store with a security guarantee." It strengthens the wedge by making the verifier user-visible.

**Acceptance.** A poisoned skill cannot be installed via the hub; a clean skill installs after preview + scan; provenance is recorded.

## Workstream 5 — First-class verified multi-provider

**Gap.** Developers want model freedom; Urfael is Claude-first (others via a manual proxy today).

**Approach.** Make the proxy path first-class via `urfael setup`: pick a model/provider, Urfael wires the Anthropic-shaped proxy and tier mapping. The key differentiator: **the untrusted-content sandbox and credential-deny are enforced at the harness level, so the safety guarantees hold no matter which model answers.** "Use any model, keep the guarantees."

**Moat-safety.** Safety is decoupled from model choice (harness-enforced), so this does **not** require reimplementing the agent loop or abandoning the `claude` core. Cost meter already adapts (`LOCAL_MODE`).

**Acceptance.** A non-Anthropic model answers a turn while the remote/untrusted profile still blocks egress and secret reads; the benchmark still passes.

## Workstream 6 — Launch

**Gap.** None of the above matters unseen. The wedge (the runnable benchmark, the verified-learning loop, the red-team postmortem) is the most shareable asset Urfael has, and nobody has seen it.

**Approach.** Record the demo (opening on `npm run security`), enable the landing page (already live at urfael.vercel.app), post the Show HN + the "I red-teamed my own agent" blog (both drafted in `docs/launch/`). Lead with the security proof, never with a feature list.

**Acceptance.** The demo GIF is in the README; the launch posts go out; traction is measurable.

---

## Sequencing

1. **Now:** Workstream 1 (semantic recall) — the one gap that degrades the core for everyone, and the foundation 2 and 4 lean on.
2. **Then:** Workstream 2 (team mode) — unlocks the highest-value audience.
3. **In parallel with 2:** Workstream 3 (onboarding/installer/Windows) — unlocks reach; independent of the kernels.
4. **Then:** Workstreams 4 and 5 (safe hub, verified multi-provider) — the category-definers.
5. **As soon as the demo exists:** Workstream 6 (launch) — does not block on the rest.

## Explicit non-goals (what we refuse, and why)

These would make Urfael a blurrier clone, not a better product. Each conflicts with a kernel.

- **Native 200+ model providers** (vs the proxy) — would require ripping out the `claude`-CLI core that gives flat-rate cost, the clean ToS story, and harness-level safety.
- **Hosted multi-tenant cloud that pools subscriptions** — breaks the single-owner threat model and the ToS (the OpenClaw legal-letter zone). Self-hosted multi-user (Workstream 2) is the sanctioned form.
- **Serverless backends (Modal / Daytona / Singularity)** — paid third-party infra; conflicts with local-first sovereignty. Docker + SSH cover the need.
- **A large first-party tool gateway** (vs MCP) — Urfael routes tools through MCP so they inherit the sandbox, rather than bundling an unverifiable catalog.
- **The CN/enterprise channel long tail** — low value per unit; add high-value channels (SMS, Teams, Google Chat) only as they pass through the kernel.

## The one-line measure of success

Every capability Hermes or OpenClaw has, Urfael offers in its **only trustworthy form** — and `npm run security` still prints 7/7. That is "better than both combined, for everyone who values being able to trust the thing acting on their behalf," which in the age of agents is becoming everyone.
