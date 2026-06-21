# Contributing

Urfael is a personal AI assistant on Claude Code. Issues, ideas, and pull requests are welcome. This page summarises what to run before you open a PR and the conventions the codebase holds to. The full guide lives in [CONTRIBUTING.md](https://github.com/Grandillionaire/urfael/blob/main/CONTRIBUTING.md).

## Dev setup

The engine lives in `app/` (the Electron overlay, the `daemon.js` brain, and `voice.js`). Vault-side logic (commands, hooks, scripts) is in `vault-template/_urfael/`.

```bash
git clone https://github.com/Grandillionaire/urfael.git && cd urfael
cd app && npm install
```

## The checks

Three commands cover most of the surface. Run them from `app/`.

```bash
npm test          # fast unit tests over pure modules, no credentials, runs in about half a second
npm run security  # boots a real daemon + dashboard and attacks them
npm run fuzz       # input-boundary fuzz harness over the real parsers and guards
```

`npm test` uses a scoped `test/*.test.js` glob. Use it instead of bare `node --test`. The bare command also discovers the two live-daemon harnesses (`e2e.js` and `security-benchmark.js`), which boot a real daemon on your `claude` login.

`npm run security` is the citable proof of the moat. It takes real 2026 attack classes against self-hosted agents (token theft, malicious skills, data exfiltration) and runs each one against the live daemon and dashboard. Output is a pass/fail table mapping every defense to the incident it answers. Exit 0 means all held.

`npm run fuzz` runs a seeded random pass plus a frozen crash corpus that replays first. Each call is checked against four oracles: it never throws unhandled, it stays bounded in time (this is the ReDoS check), it stays bounded in output, and it fails closed in shape (a normaliser returns null or a valid value, a sandbox never reaches `local`). A finding prints a replay seed and the minimised input. You can reproduce a run with `URFAEL_FUZZ_SEED`, `FUZZ_ITERS`, and `FUZZ_BUDGET_MS`.

There is also `npm run e2e`, a live end-to-end run against a real daemon. It uses your real `claude` login, so it is not part of the standard PR gate.

## Conventions

- **Keep modules pure and testable.** The fast suite covers `lib`, `council`, `personas`, `seal`, `audit-chain`, and the rest because they are pure modules with no credentials. New logic should fit that shape so it can be unit tested directly.
- **Fail closed.** A guard stays safe on bad input, a normaliser returns null rather than a half-parsed value, and a sandbox never escalates to `local`. The fuzzer enforces this as an oracle, so a fail-open path will get caught.
- **Freeze a regression test for every fix.** When the fuzzer finds something, freeze the minimised input in `fuzz-corpus.json` so it replays on every future run and cannot come back. Do the same for any bug you fix: add the test that would have caught it.
- **Keep the safe defaults safe.** `bypassPermissions`, computer-use MCPs, and the autonomous loop are opt-in by design. Do not make them default. See [security/modes.md](security/modes.md).
- **Never commit secrets or personal data.** Keys live in `~/.claude/urfael/*.env` (gitignored). Your real vault (`~/Urfael`) and memory (`~/Urfael-memory`) are separate, private, and never part of this repo.
- **Match the surrounding style.** Small, focused commits, no debug artifacts.

## Opening a PR

1. Fork, branch, make your change.
2. Confirm `npm test` and `npm run security` pass and the app still launches.
3. Describe the change and the why. If it touches permissions or untrusted-data handling, call that out.

New to the codebase? Read [developer/architecture.md](developer/architecture.md) first, then the five files in its "the moat, in five files" section. For background on the defenses the security benchmark probes, see [security/threat-model.md](security/threat-model.md).
