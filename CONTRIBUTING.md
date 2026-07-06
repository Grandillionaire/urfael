# Contributing to Urfael

Thanks for considering a contribution! Urfael is a personal AI assistant on Claude Code — issues, ideas,
and PRs are all welcome.

## Ground rules
- **Never commit secrets or personal data.** Keys live in `~/.claude/urfael/*.env` (gitignored); your real
  vault (`~/Urfael`) and memory (`~/Urfael-memory`) are separate, private, and never part of this repo.
- **Keep the safe defaults safe.** `bypassPermissions`, computer-use MCPs, and the autonomous loop are
  **opt-in** by design — don't make them default. See [SECURITY.md](SECURITY.md).
- **Match the surrounding style.** Small, focused commits; no debug artifacts.

## Dev setup
```bash
git clone https://github.com/Grandillionaire/urfael.git && cd urfael
cd app && npm install
npm test             # 1014 unit tests (fast, pure modules: lib, council, personas, seal, audit-chain, registry, recall, …); no credentials, ~0.5s
npm run security     # 11/11 attack classes · 117/117 checks — boots a REAL daemon + dashboard and attacks them
npm run e2e          # live end-to-end against a real daemon (uses your real claude login)
```
Use `npm test` (the scoped `test/*.test.js` glob), not bare `node --test` — the latter also discovers the
two live-daemon harnesses (`e2e.js`, `security-benchmark.js`), which boot a real daemon on your `claude`
login. New to the codebase? Read **[ARCHITECTURE.md](ARCHITECTURE.md)**, then the five files in its "the moat,
in five files" section, and you understand the whole security posture. The engine lives in `app/` (Electron
overlay + the `daemon.js` brain + `voice.js`); vault-side logic (commands, hooks, scripts) is in
`vault-template/_urfael/`.

## High-value contributions
- **Linux / Windows ports** — the brain/daemon are portable; the blockers are macOS-only bits (launchd,
  AppleScript, `afplay`, `say`, `lsappinfo`). PRs that abstract these are very welcome.
- **More local voice backends** — Piper TTS, faster-whisper, etc.
- **New MCP "hands"** and slash commands.
- **Docs, examples, a demo GIF.**

## Pull requests
1. Fork, branch, make your change.
2. `npm test` (1014 unit tests) and `npm run security` (117/117 checks, 11/11 attack classes) pass, and the app still launches.
3. Describe the change and the "why." If it touches permissions or untrusted-data handling, call that out.

## Reporting bugs / security
- Bugs: open an issue with steps to reproduce + macOS version.
- **Security:** please use a private advisory, not a public issue (see [SECURITY.md](SECURITY.md)).
