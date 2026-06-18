# Team mode — the agent a CISO can approve

Most multi-user AI agents ask the business to *trust* them. Urfael's team mode is built the other way around: **every additional person is just another sandboxed principal forced through the same fail-closed kernel.** Adding teammates can only ever add *more-restricted* identities; it can never escalate anyone. That is what makes a multi-user agent something a security review can actually sign off on.

This is Workstream 2 of the [Improvement Plan](IMPROVEMENT-PLAN.md), and it is self-hosted, **not** a multi-tenant cloud — each org runs Urfael on its own login. (Pooling subscriptions across orgs is an explicit non-goal: it breaks the threat model and the ToS.)

## How it works

A per-channel **roster** lists allowlisted principals, each with a **role**:

```jsonc
// ~/.claude/urfael/team.json  (copy from config/team.json.example)
{
  "telegram": [
    { "id": "111", "name": "Maxim", "role": "owner" },
    { "id": "222", "name": "Sam",   "role": "member" },
    { "id": "333", "name": "Contractor", "role": "guest" }
  ]
}
```

- A sender **not in the roster is dropped** before the brain ever sees the message (fail-closed allowlist).
- The role maps to a sandbox profile, and **a role can only narrow access**:

| Role | Sandbox profile | Can do |
|---|---|---|
| `owner` / `member` | `untrusted` | read **and search** the shared vault (no shell, no write, no network egress) |
| `guest` | `guest` | read a **known path only** — **no** Grep/Glob, so it can't browse or search your notes |
| *(unknown/missing)* | `guest` | fail-closed to the most-restricted tier |

The invariant that makes this safe: **no role value — not even a forged `"owner"` — ever reaches the full-power `local` profile.** `local` is reachable *only* by an absent channel (the on-machine mic). A remote turn is always one of `untrusted` or `guest`. (Proven in `npm run security` and `app/test/lib.test.js`: every role attempt, including forged and coerced values, stays sandboxed.)

Editing `team.json` takes effect **live** — no restart. Without the file, Urfael stays single-owner via the `*_OWNER_*` ids in `bridge.env` (existing setups are unchanged).

## The audit trail

Every remote turn is attributed to its principal and logged: who, when, which channel, which sandbox profile, in/out sizes. Export it for an auditor:

```bash
urfael team            # show the roster (principals + roles per channel)
urfael audit           # the recent per-principal activity trail
urfael audit --json    # the same, machine-readable, for an SIEM / a compliance export
```

Combined with `npm run security` (the 9/9 benchmark, now including the team-mode escalation checks) and [docs/THREAT-MODEL.md](THREAT-MODEL.md), that's the package you hand a security team: *here is who can reach it, what each can do, the structural proof they can't escalate, and the log of what they did.*

## Channel support

**All 8 bridges** route through the roster now: telegram, discord, slack, whatsapp, matrix, signal, email, and iMessage. Each resolves its sender to a principal (`core.resolvePrincipal(channel, id)`), relays the turn role-scoped + attributed, and replies to the actual sender (matrix replies to the originating room; email drafts a reply to the From; iMessage stays single-handle — its chat.db query is bound to one handle, so it gets roles + attribution but true multi-handle is a SQL follow-up).

ID formats per channel: telegram = chat id · discord/slack = user id · whatsapp/signal = E.164 number (signal also accepts the uuid) · matrix = `@you:server` · email = the From address (gate stays `EMAIL_ALLOWED_SENDERS`; team.json assigns roles) · iMessage = the handle.

Honest caveat: the kernel + roster + daemon scoping + audit are unit-tested and benchmark-verified, but the **live relay of each bridge is not exercised by the test suite** (it needs real accounts — the same paths the e2e harness SKIPs). The changes mirror the verified telegram reference and are syntax- + sandbox-checked.
