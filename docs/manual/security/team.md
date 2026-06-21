# Team mode

Team mode lets several people share one Urfael. Each person is a sandboxed principal forced through the same fail-closed kernel. Adding a teammate can only add a more-restricted identity. It can never escalate anyone. That is the property a security review can actually sign off on.

This is self-hosted, not a multi-tenant cloud. Each org runs Urfael on its own login. Pooling subscriptions across orgs is an explicit non-goal: it breaks the threat model and the terms of service.

## The roster

A per-channel roster lists allowlisted principals, each with a role. It lives at `~/.claude/urfael/team.json` (copy from `config/team.json.example`).

```json
{
  "telegram": [
    { "id": "111", "name": "Maxim", "role": "owner" },
    { "id": "222", "name": "Sam", "role": "member" },
    { "id": "333", "name": "Contractor", "role": "guest" }
  ]
}
```

A sender who is not in the roster is dropped before the brain ever sees the message. Editing `team.json` takes effect live, no restart. Without the file, Urfael stays single-owner via the `*_OWNER_*` ids in `bridge.env`, so existing setups are unchanged.

## Roles

The role maps to a sandbox profile, and a role can only narrow access.

| Role | Sandbox profile | Can do |
|---|---|---|
| `owner` / `member` | `untrusted` | read and search the shared vault (no shell, no write, no network egress) |
| `guest` | `guest` | read a known path only (no Grep or Glob, so it cannot browse or search your notes) |
| unknown or missing | `guest` | fails closed to the most-restricted tier |

The invariant that makes this safe: no role value, not even a forged `"owner"`, ever reaches the full-power `local` profile. `local` is reachable only by an absent channel (the on-machine mic). A remote turn is always `untrusted` or `guest`. This is proven in `npm run security` and `app/test/lib.test.js`: every role attempt, including forged and coerced values, stays sandboxed.

All eight bridges route through the roster: telegram, discord, slack, whatsapp, matrix, signal, email, and iMessage.

## Pairing a guest

Instead of editing the file, an owner can mint a single-use code. The new person DMs that exact code to the bot and is enrolled as a guest.

```bash
urfael team pair telegram --ttl 60
```

The role is hard-coded to guest. A code can never mint an owner or member, even if it leaks. Redemption is single-use. Self-enroll pairing is wired in the Telegram bridge so far.

## The audit trail

Every remote turn is attributed to its principal and logged: who, when, which channel, which sandbox profile, and in/out sizes.

```bash
urfael team            # show the roster
urfael audit           # the per-principal activity trail
urfael audit --json    # the same, machine-readable, for an SIEM or compliance export
urfael audit --verify  # walk the tamper-evident hash chain, pinpoint the first broken link
```

The trail is a sha256 hash chain (the Ledger of Record). Any edit, deletion, or reorder is detectable.

## The owner-signed seal

An owner ed25519 keypair signs the ledger head, giving the record a cryptographic identity. The private key is `0600`, the public key is committed at `~/Urfael-memory/seal.pub`.

```bash
urfael seal            # sign the current ledger head
urfael seal --verify   # prove only the owner key could have signed, and that history was not rewritten below the seal
```

Honest scope: a seal proves authorship and integrity of the record at a moment. It does not prove that any claim in the record is true.

## Honest caveat

The kernel, roster, daemon scoping, audit, and seal are unit-tested and benchmark-verified. The live relay of each bridge is not exercised by the test suite, since it needs real accounts (the same paths the e2e harness skips). The bridge changes mirror the verified Telegram reference and are syntax- and sandbox-checked.

For the full engineering write-up, see the [Improvement Plan threat model](https://github.com/Grandillionaire/urfael/blob/main/docs/TEAM-MODE.md). Related manual pages: [reference/cli.md](reference/cli.md), [start/quickstart.md](start/quickstart.md), and [start/learning-path.md](start/learning-path.md).
