# Skills

A skill is a procedure Urfael writes down and reuses. When it solves something with a non-obvious path, the brain saves the steps as a short markdown file under `~/Urfael/_urfael/skills/<slug>.md`, then reads it back the next time the same problem shows up. A skill is plain text. It is read, not run.

That last point is the whole design. A skill file is markdown the brain reads as a procedure. Urfael never executes it as code, never sources it, never feeds it to a shell. The worst a malicious skill can do is feed bad instructions to the brain, which is why installing one is paranoid by default.

## Where skills live

Local skills are every `*.md` file under `~/Urfael/_urfael/skills/`. (The vault root follows `URFAEL_VAULT_DIR`, default `Urfael`.) Each file's name and description are derived from its frontmatter or first heading. Nothing else is parsed and nothing is executed to read them.

The skill curator, an opt-in N-day loop, merges duplicates and prunes stale skills so the directory does not rot. See features/memory.md for the learning side.

## Installing a skill, paranoid by default

You can install a skill from a direct https URL or from the hub registry. Both paths run the same gate:

1. **Fetch.** https only. A private, loopback, or link-local host is refused (SSRF guard). The response must be `text/markdown` or `text/plain`. No HTML, no octet-stream. The body is capped at 256 KB.
2. **Integrity.** If the source pins a `sha256`, the fetched bytes must match it or the skill is refused before you ever see it. A registry entry cannot be swapped for a different payload at its URL.
3. **Static scan.** A pattern-matching pass flags dangerous content (see below). It never runs the file.
4. **Preview.** The full body is printed to your terminal, with terminal control and ANSI escapes stripped so the content cannot spoof the display. You see the literal bytes that would be stored.
5. **Confirm.** Nothing is written until you say yes. The file is stored `0600` (data, never executable), inside the skills directory only. Path traversal in the slug is defanged.

`--yes` only auto-installs a skill that scans completely clean and does not overwrite an existing one. Any flag, danger or warning, forces interactive review. A skill that dodges the danger tier but trips a warning cannot slip through unattended.

## What the scanner catches

The scan is a heuristic gate. It reads the file as untrusted text and errs toward flagging. It looks for, among others:

- Droppers: `curl | sh`, process-substitution `bash <(curl ...)`, base64-decode piped into a shell.
- Destructive ops (`rm -rf`, `mkfs`, raw-disk writes) and secret reads: `~/.ssh`, `/etc/shadow`, `.aws/credentials`, keychains, and Urfael's own stores (`bridge.env`, `~/.claude` credentials).
- Exfiltration: calls that ship local data out, known callback hosts (ngrok, webhook.site, telegram bot API), raw-IP URLs, DNS tunnels.
- Reverse shells, persistence (shell rc files, cron, launchd, git hooks), miners, anti-forensics, provider base-URL overrides.
- Prompt-injection phrasing, since this text is fed to the brain: "ignore previous instructions", "do not tell the user", and the like.
- Hidden, zero-width, or bidi-override unicode that could mask a payload.

An intent rule fires even on pure prose: a skill that both reads a secret and sends data out is flagged as a credential-exfiltration procedure, because the brain follows a skill as a procedure.

### Decode and rescan

The differentiating step: when the scanner sees an obfuscation layer (`\xNN` escapes, `String.fromCharCode` runs, or a base64 blob sitting next to a decoder), it decodes that one layer and runs the full scan again on the plaintext. A dropper hidden inside a base64 blob is caught instead of read as clean text. The decode is hard-bounded (at most 6 fragments, 4 KB each, 16 KB total, depth 2) so it can never be a decode-bomb.

The scan produces a capability summary (does this touch the network, read secrets, run a shell, persist?) and a `block` / `review` / `clean` verdict.

## The hub

`urfael hub` browses a registry: a plain JSON index in a curated git repo. The default index is the `urfael-skills` repo; point `URFAEL_HUB_INDEX` at your own. Installing from the hub goes through the exact same gate as a URL install: scan, sha256 pin, full preview, never executed. A poisoned listing is still caught by the scanner; a swapped payload at a listed URL is caught by the sha256 pin. Unpinned entries are marked `(unpinned)` so you know the integrity check will not run.

## Commands

```bash
urfael skills list                       # installed local skills with their descriptions
urfael skills scan <file>                # static scan a local .md (exit 1 if it has DANGER flags)
urfael skills export <name>              # print one skill file verbatim (to pipe or share)
urfael skills install <https-url>        # fetch, scan, preview, confirm, store. add --yes for clean ones

urfael hub                               # browse the registry
urfael hub search <term>                 # filter listings
urfael hub install <slug>               # install by slug through the same gate. --yes for clean ones
urfael hub publish <file>                # print the registry index entry (with sha256) for a local skill to PR
```

## The honest part

The scanner is a heuristic. Pattern matching cannot catch every malicious skill, and it will sometimes flag a benign one. So do not treat a clean scan as a guarantee. The real guarantee is the layer behind it: the full body is previewed before you confirm, nothing is written without your yes, and the brain never executes a skill. It is markdown the brain reads, stored `0600` and never marked executable. The scan is the loud first opinion; you are the decision.

For the full implementation, see [app/skillhub.js on GitHub](https://github.com/Grandillionaire/urfael/blob/main/app/skillhub.js).
