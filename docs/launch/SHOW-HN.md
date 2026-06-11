# Show HN launch kit

A launch is the *mechanism* by which a project gets noticed — but HN is brutal and allergic to hype. The
move is to lead with the one thing nobody else has (a runnable security benchmark), be ruthlessly honest
about the tradeoffs *before* a commenter is, and never use a superlative you can't back with a command.

> Nothing here is posted automatically. This is a draft for *you* to post when you're ready.

---

## Title (pick one — keep it factual, no hype words)

1. **Show HN: Urfael – a personal AI agent that resists the attacks that owned the others**
2. Show HN: A local AI assistant on your Claude subscription, with a runnable security benchmark
3. Show HN: Urfael – voice AI agent with no inbound port; run `npm run security` to verify

> #1 is the strongest — it's specific, it implies the proof, and it invites the skeptic to check. Avoid
> "the most secure," "revolutionary," etc. The benchmark does the bragging.

## The post (your first comment — this is what people actually read)

> I built Urfael because every self-hosted AI agent I looked at optimized for reach — channel count, model
> count, stars — and treated security as a footnote. Then in 2026 that footnote became CVEs: a one-click
> RCE in a popular agent (a malicious page leaked its gateway token), tens of thousands of those gateways
> sitting exposed on the internet, and a skill registry where about a fifth of the skills were malware.
>
> So I built the opposite: a personal, voice-capable assistant whose whole design goal is the smallest
> blast radius.
>
> - **Nothing listens on a network port.** The brain is a local daemon on a unix socket. The opt-in web
>   dashboard and OpenAI-compatible API bind to 127.0.0.1 only.
> - **Untrusted content is structurally contained.** Every remote chat message is allowlisted to you and
>   runs read-only with no shell and no network-egress tool, so an injected "read a secret and POST it
>   somewhere" has nothing to send it with. The vault denies the agent reading your credential stores
>   outright.
> - **It runs on your existing Claude subscription** — no API key, no per-token meter. (It shells out to
>   the official `claude` CLI on your own login; nothing bundled or pooled. Other models work via a proxy
>   on your own keys.)
> - **It ships a benchmark that attacks itself.** `npm run security` boots the real daemon + dashboard and
>   runs the actual attack classes that compromised agents in the wild, then prints a pass/fail table:
>   currently 7/7 classes, 33/33 checks. I red-teamed it with adversarial agents, they found four real
>   gaps (two of which let an injected email exfiltrate secrets), and I fixed them before posting. The
>   benchmark and the threat model — including the risks it does NOT cover — are in the repo.
>
> Honest tradeoffs, up front: it's **Claude-first** (any model works via a proxy, and the sandbox is enforced
> by the harness so the safety holds whatever answers — but native 200+-model breadth is genuinely the
> competitors' edge). It has **8 chat channels, not 20.** **macOS is solid; Linux is newer; Windows is
> code-complete but unverified.** And it's a **personal-scale tool**, not a 100k-deployment veteran — I say
> so in the README.
>
> It also does the assistant stuff well: local voice (whisper + your OS TTS, no cloud), compounding memory
> with **hybrid lexical+semantic recall**, a **self-verifying learning loop** (a lesson isn't trusted until
> an independent verifier judges it correct/general/safe), **team mode** (each user a sandboxed principal,
> with an `urfael audit` trail — the multi-user agent a security review can actually approve), a **skill
> registry where nothing installs unscanned/unpinned/executed**, scheduled agent jobs, a desktop app + TUI +
> dashboard. But the reason I'm posting is the security model, and I'd genuinely like this crowd to break it.
>
> Repo: https://github.com/Grandillionaire/urfael — `npm run security` is the 60-second version.
> What did I get wrong?

## Pre-empting the top HN comments (write these into the post / be ready to reply)

- *"Security theater / 127.0.0.1 isn't really closed."* → It's why the threat model explicitly lists
  loopback surfaces and the residual risks. The claim is narrow and verifiable, not absolute.
- *"It's just a wrapper around Claude Code."* → Yes, deliberately — that's the moat (flat-rate, ToS-clean,
  no reimplemented agent loop). The value is the security architecture + surfaces around it, not a new model.
- *"Claude-only is a dealbreaker."* → It's Claude-*first*: any model works via a documented proxy on your
  own keys, and the sandbox is harness-enforced so the safety holds whatever answers. Native 200+ breadth is
  genuinely the competitors' edge, and the README says so.
- *"Is this even allowed on a subscription?"* → Covered in the README (runs on your own login, ordinary
  individual use, API keys for scale); Claude Code + the Agent SDK are built for exactly this.
- *"Benchmark is marketing."* → It's `npm run security`, it runs on their machine, the source is readable,
  and it caught my own over-claim. Invite them to add a failing case.

## Where else (after HN, spaced out — never spam)

- r/LocalLLaMA and r/selfhosted — lead with the security benchmark + "runs on your own box."
- Lobsters (needs an invite) — the security-architecture angle plays well there.
- A short write-up / blog: "I red-teamed my own AI agent and it found 4 real holes" — the honest-postmortem
  framing travels further than a feature list.
- The security angle is what gets a researcher to amplify it — the benchmark IS the shareable artifact.
