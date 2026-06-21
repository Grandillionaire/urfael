# Troubleshooting

Most problems have a one-command answer. Start with `urfael doctor`, fix what it flags, and only dig deeper if a symptom survives that.

## Start with doctor

`urfael doctor` prints one card of real, local state. Every line is either green or carries its own fix, printed right under it as a single command. It never spawns the brain, so it can diagnose a daemon that is down rather than hide the problem by starting one.

```bash
urfael doctor
```

It checks seven things and tells you the fix for each:

| Check | What a red line means | The fix it prints |
|---|---|---|
| `claude CLI` | The `claude` binary is not on `PATH` | install Claude Code |
| `brain` | The daemon is asleep | `urfael status` (wakes it) |
| `vault` | `~/Urfael` is missing or not writable | `./install.sh` |
| `memory` | `~/Urfael-memory` is missing, not a git repo, or not writable | `./install.sh` |
| `provider` | (informational) shows how it reaches a model | `urfael setup` to change |
| `persona` | `{{PLACEHOLDER}}` fields in `CLAUDE.md` are unfilled | `urfael setup` |
| `ledger` / `seal` | Only checked while the brain is up | `urfael audit --verify` / `urfael seal` |

Work top to bottom. The checks are ordered roughly by dependency, so a red `claude CLI` line usually explains the red lines below it.

## The daemon will not start, or a command hangs

The brain is a local daemon reachable only over a `0600` unix socket at `~/.claude/urfael/daemon.sock`. It opens no TCP port. If a CLI command hangs or returns "the brain is unreachable", the socket is the thing to check.

First, ask the daemon directly:

```bash
urfael health
```

That prints the raw health JSON from the socket. If it errors or returns nothing, the daemon is not answering. Confirm the socket file exists:

```bash
ls -l ~/.claude/urfael/daemon.sock
```

If the socket is missing or stale, load the service:

```bash
launchctl load -w ~/Library/LaunchAgents/com.urfael.daemon.plist   # macOS
systemctl --user enable --now urfael-daemon                        # Linux
```

Most CLI commands also try to spawn the daemon for you on first use. When that spawn fails the CLI tells you to run `urfael doctor` or to read `~/.claude/urfael/daemon.log`. That log is where a crash-on-boot leaves its reason. A turn that hangs mid-stream is a separate case: `Ctrl+C` aborts the current turn, and `urfael stop` aborts from another terminal.

## The brain spawned but nothing comes back

The daemon does not contain a model. It shells out to your installed `claude` CLI, so the answer to "the brain spawned but produces nothing" is almost always the CLI underneath it.

- Confirm `claude` is installed and on `PATH`. `urfael doctor` reports this as the `claude CLI` line.
- Confirm you are signed in. Run `claude` once in a plain terminal and check it answers. If `claude` works there, the daemon works. If it does not, fix that first. Urfael bundles no credentials and stores no tokens; it rides your login.
- If you are on the **Pro** plan, Opus escalation will fail unless you set `URFAEL_OPUS_MODEL=sonnet` in the daemon service's environment. Opus access needs **Max**. See [Models and plans](features/models.md).
- If `ANTHROPIC_API_KEY` is set in your environment, it overrides the subscription. That is by design, but it is worth knowing when you expected the subscription path.

## A chat channel is silent

A channel that never replies is usually doing exactly what it is supposed to: dropping a message that is not from your allowlisted id. Every message from Telegram, Discord, Slack, iMessage, Email, Matrix, Signal, and WhatsApp is checked against your own id and dropped (and audited) before the brain sees a single token. The honest first move is to check config, not code.

- **Allowlist.** Make sure your own chat or user id is the one in `~/.claude/urfael/bridge.env`. A message from any other id is dropped on purpose.
- **Bridge keys.** The bot token(s) and your id live in `bridge.env`. The installer scaffolds it from `config/bridge.env.example`, which has the step-by-step for each value. It should be `chmod 600`.
- **The bridge is loaded.** The installer writes the bridge service files but does not start them. Load the one you want, for example `launchctl load -w ~/Library/LaunchAgents/com.urfael.telegram.plist` on macOS.
- **The audit trail.** Every accepted turn is appended to `~/.claude/urfael/bridge-audit.log` and rate-limited. If your message is not in there, it was dropped before the brain, which points back at the allowlist.

Discord additionally needs the MESSAGE CONTENT intent enabled, and iMessage needs Full Disk Access on macOS. Channel-by-channel setup is in [Channel setup](channels/setup.md).

## The dashboard returns 401

The web dashboard binds `127.0.0.1` only and is gated by a constant-time token. A 401 means the token did not match. It returns no hint on purpose, so the fix is to use the real token rather than guess.

The simplest path is to let the CLI hand you the full tokened URL:

```bash
urfael dashboard
```

That prints `http://127.0.0.1:7717/?token=<token>`, spawning the dashboard process if it is not already up. The token itself lives in `~/.claude/urfael/dashboard.token`. Open the printed URL once and the dashboard sets an HttpOnly cookie, so later visits to the bare URL work without the query string. If you keep getting 401s, you are almost certainly pasting an old token; re-run `urfael dashboard` to get the current one.

A note on 500s: the only dependency here is the local daemon. A transient dashboard error is the dashboard failing to reach the socket, not a paused cloud service. Check `urfael health` and the socket, the same as the daemon section above.

## Still stuck

`urfael doctor` is the canonical health read and the one to quote when reporting a problem. For the full command surface see the [CLI reference](reference/cli.md). For the security reasoning behind the allowlist, the loopback binds, and the read-only sandbox, read [SECURITY.md on GitHub](https://github.com/Grandillionaire/urfael/blob/main/SECURITY.md).
