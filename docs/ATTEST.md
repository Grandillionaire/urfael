# Attestation Report (`urfael attest`)

The three-word brand (security, honesty, sovereignty) turned into one command. `urfael attest` bundles the facts that are each independently verifiable into a single report a reviewer, auditor, or client can keep: the Ledger of Record is intact, the owner key signed it, and the containment posture is in force. It is the artifact a security review or a compliance file actually needs, and it is the thing a hosted, SaaS-shaped agent cannot produce for the user, because the data leaves the user's machine by design.

```bash
urfael attest                                  # human-readable report
urfael attest --json --out attestation.json    # machine-readable bundle for an auditor / SIEM

urfael attest checkpoint                        # publish a signed, third-party-verifiable checkpoint of the ledger
urfael attest prove <seq>                       # an inclusion proof that entry <seq> is in the log (reveals only it)
urfael attest verify <proof.json>               # verify a checkpoint or inclusion proof against the published key (offline)
```

## What it proves

- **Integrity.** The Ledger of Record is an unbroken sha256 hash chain, so any edit, deletion, or reorder of past actions is detectable (`urfael audit --verify`).
- **Authorship.** The owner ed25519 Sovereign Seal signed the ledger head, so the record is authentic and history below the seal was not rewritten (`urfael seal --verify`).
- **Third-party verifiability.** A signed **transparency-log checkpoint** (an RFC 6962 Merkle root over the same ledger entries, in [C2SP signed-note](https://github.com/C2SP/C2SP/blob/main/signed-note.md) format) lets anyone with the published key confirm that N actions are present, in order, with none deleted, from a small **inclusion** or **consistency** proof, **without seeing the contents** (`urfael attest checkpoint` / `prove` / `verify`).
- **Posture in force.** The brain opens no inbound TCP port (a `0600` unix socket only), and untrusted turns run a read-only profile with no shell, no write, no network egress, and a credential-deny boundary.

## The transparency log

Verifying the private hash chain today means the owner re-walks every entry, and a machine could in principle rewrite history under a re-signed head. The transparency log closes that gap the way [Sigstore Rekor v2](https://github.com/C2SP/C2SP/blob/main/tlog-tiles.md) does:

- **Leaves** are the ledger's own entries, hashed over the *same canonical bytes* the chain commits to, with RFC 6962 domain separation: `leaf = SHA-256(0x00 || canonical(entry))`, `interior = SHA-256(0x01 || left || right)`.
- A **checkpoint** is the signed-note `origin\n<tree-size>\n<base64(root)>\n`, signed by the **same** ed25519 Sovereign-Seal key (no new key), with a `— <key-name> <base64(signature)>` line.
- An **inclusion proof** reveals one entry plus opaque sibling hashes; the verifier recomputes the root and checks it against the signed checkpoint — proving *that* one action is logged without exposing the others.
- A **consistency proof** shows an older checkpoint's tree is a prefix of a newer one — proving the log is **append-only** (nothing below it was deleted or rewritten).

A rewritten or deleted entry can no longer reproduce the signed root, so it is provably detected (frozen as a benchmark check). The verifier is `node:crypto` only and runs offline against the git-published `~/Urfael-memory/seal.pub`.

## What it deliberately does NOT prove

Honesty is the wedge, so the report is scoped precisely and the scope is frozen by a test (`app/test/attest.test.js`) that fails the build if the wording ever drifts into overclaim:

- It does **not** prove that any individual claim recorded inside the ledger is true. The seal proves authorship and integrity of the record, not the truth of its contents.
- It is **not** an absolute guarantee of zero egress. It states the no-egress deny-policy that is in force, not a per-packet runtime capture of every turn.

The report carries both lists in its body, on purpose. An attestation that overclaims is one a researcher can publicly break, which would do more damage to a trust-first product than any missing feature.

## The bundle

The JSON bundle (`--out`) contains the verdict (`ATTESTED` / `LEDGER INTACT (unsealed)` / `NOT ATTESTED`), a content fingerprint, the ledger and seal verification results, the **signed transparency-log checkpoint**, the posture, and the scope. It is **anchored by the Sovereign Seal**: the seal's signature over the ledger head is the cryptographic root, and the bundle records the verified head so a reader can re-check it with `urfael seal --verify`. The checkpoint travels with the bundle so a reviewer can extract inclusion/consistency proofs.

## Roadmap

- **v1:** composed the verified ledger, the verified seal, and the in-force posture into one honestly-scoped report, anchored by the seal.
- **v2 (now):** folds in a **third-party-verifiable transparency log** — an RFC 6962 Merkle tree over the ledger under a C2SP signed-note checkpoint, with inclusion + consistency proofs an outside auditor can verify offline against the published key, without seeing the contents.
- **v3 (next):** a live egress observation and observed socket-table capture during an attested turn (so the report can state "deny-policy in force **and** observed zero egress during this turn"), plus appending the act of attesting itself to the ledger so an attestation becomes part of the tamper-evident record it describes. Still scoped to what is observed, never to an absolute guarantee.

## Why it is the flagship

It serves the user's real fear (did this agent leak my data, and can I show someone it didn't), it is the clearest paid trigger (compliance and security buyers pay for a signed artifact, not for chat channels), and it deepens the moat (a hosted agent cannot honestly emit a "we hold none of your data" proof). It is roughly 80% existing code: `audit-chain.js`, `seal.js`, and the no-egress untrusted profile already exist; `attest.js` is the assembly and the honest scoping on top.
