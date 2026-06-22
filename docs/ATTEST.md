# Attestation Report (`urfael attest`)

The three-word brand (security, honesty, sovereignty) turned into one command. `urfael attest` bundles the facts that are each independently verifiable into a single report a reviewer, auditor, or client can keep: the Ledger of Record is intact, the owner key signed it, and the containment posture is in force. It is the artifact a security review or a compliance file actually needs, and it is the thing a hosted, SaaS-shaped agent cannot produce for the user, because the data leaves the user's machine by design.

```bash
urfael attest                                  # human-readable report
urfael attest --json --out attestation.json    # machine-readable bundle for an auditor / SIEM
```

## What it proves

- **Integrity.** The Ledger of Record is an unbroken sha256 hash chain, so any edit, deletion, or reorder of past actions is detectable (`urfael audit --verify`).
- **Authorship.** The owner ed25519 Sovereign Seal signed the ledger head, so the record is authentic and history below the seal was not rewritten (`urfael seal --verify`).
- **Posture in force.** The brain opens no inbound TCP port (a `0600` unix socket only), and untrusted turns run a read-only profile with no shell, no write, no network egress, and a credential-deny boundary.

## What it deliberately does NOT prove

Honesty is the wedge, so the report is scoped precisely and the scope is frozen by a test (`app/test/attest.test.js`) that fails the build if the wording ever drifts into overclaim:

- It does **not** prove that any individual claim recorded inside the ledger is true. The seal proves authorship and integrity of the record, not the truth of its contents.
- It is **not** an absolute guarantee of zero egress. It states the no-egress deny-policy that is in force, not a per-packet runtime capture of every turn.

The report carries both lists in its body, on purpose. An attestation that overclaims is one a researcher can publicly break, which would do more damage to a trust-first product than any missing feature.

## The bundle

The JSON bundle (`--out`) contains the verdict (`ATTESTED` / `LEDGER INTACT (unsealed)` / `NOT ATTESTED`), a content fingerprint, the ledger and seal verification results, the posture, and the scope. It is **anchored by the Sovereign Seal**: the seal's signature over the ledger head is the cryptographic root, and the bundle records the verified head so a reader can re-check it with `urfael seal --verify`.

## Roadmap

- **v1 (now):** composes the verified ledger, the verified seal, and the in-force posture into one honestly-scoped report, anchored by the seal.
- **v2 (next):** a live egress observation, a sandbox deny-policy snapshot plus an observed socket-table capture during an attested turn, so the report can state "deny-policy in force **and** observed zero egress during this turn" rather than the policy alone. Still scoped to what is observed, never to an absolute guarantee.
- **v3:** the report signed in its own right (not only anchored by the seal) and the act of attesting itself appended to the ledger, so an attestation is part of the tamper-evident record it describes.

## Why it is the flagship

It serves the user's real fear (did this agent leak my data, and can I show someone it didn't), it is the clearest paid trigger (compliance and security buyers pay for a signed artifact, not for chat channels), and it deepens the moat (a hosted agent cannot honestly emit a "we hold none of your data" proof). It is roughly 80% existing code: `audit-chain.js`, `seal.js`, and the no-egress untrusted profile already exist; `attest.js` is the assembly and the honest scoping on top.
