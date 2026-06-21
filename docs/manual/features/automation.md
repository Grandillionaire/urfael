# Automation

Urfael can act without you asking. Four mechanisms cover it: reminders that speak a fixed text, scheduled jobs that run the brain and report back, background jobs you can inspect, and webhook triggers that let an outside event wake the brain. Every scheduled or webhook action runs sandboxed and fails closed. This page describes what the code does. Where a feature is opt-in or off by default, it says so.

## Reminders

`urfael remind` sets a one-shot or repeating reminder. A reminder speaks a fixed text at a time. No model runs.

```bash
urfael remind "call the dentist" --in 20
urfael remind "standup" --at "2026-06-19T09:30" --repeat weekly
urfael reminders                       # list what is scheduled
```

Reminders live in one JSON file (`~/.claude/urfael/reminders.json`), re-armed when the daemon boots and ticked on a coarse interval, so they are minute-grained, not millisecond-grained. A repeating spec dated in the past starts at its next occurrence. There is a cap of 200 stored reminders. See [features/memory.md](features/memory.md) for how the daemon persists its other state in the same directory.

## Scheduled jobs (cron)

`urfael cron` is the one that does work. Unlike a reminder, a cron job runs the brain on its schedule and delivers the result, fired as a notification, spoken aloud, or pushed to a chat channel (`--deliver notify|silent|push`).

```bash
urfael cron add "brief me on overnight email" --daily-at 07:30
urfael cron add "poll the deploy" --cron "*/15 9-17 * * 1-5"
urfael cron list
urfael cron cancel <id>
urfael cron run <id>
```

Two extras:

- `--then "<prompt>"` chains a follow-up that runs on completion, with the prior output threaded into it as `$URFAEL_PREV`. There is also `--then-script` for a shell follow-up.
- `--script "<cmd>"` makes the job a no-LLM shell command instead of a brain run. This is opt-in and owner-authored: the saved-script library and `--script` cron steps need `URFAEL_SCRIPT_CRON=1` set in the environment. Without it, scripts do not run. See [security/model.md](security/model.md) for why this gate exists.

The cron store (`~/.claude/urfael/cronjobs.json`) is separate from the reminder store but ticked in the same interval. The brain run is spawned as a sandboxed one-shot, injected into the scheduler by the daemon so the scheduler module never imports the brain.

## Background jobs

`urfael jobs` lists background jobs and their state. `urfael job <id>` shows one job's full record and a log tail; `urfael cancel <id>` cancels one by id.

```bash
urfael jobs
urfael job a1b2c3
urfael cancel a1b2c3
```

## The heartbeat

An opt-in heartbeat runs your `HEARTBEAT.md` checklist on a schedule and stays silent unless something genuinely needs you. It is off until you set it up, and like every scheduled spawn it runs in the read-only sandbox with no connectors loaded.

## Webhook triggers

`urfael hooks` and `urfael hook add` let an external event (a CI build finishing, a payment, a monitoring alert) wake the brain. The daemon itself never opens a port. The receiver is a separate process that binds `127.0.0.1` only, and it is off until you start it explicitly.

```bash
urfael hooks                              # start the loopback receiver
urfael hook add "CI build" --action ask   # prints the URL and secret ONCE
urfael hook list
urfael hook rm hk_xxxxxxxxxxxx
```

Each hook carries its own 256-bit secret, shown once at creation; only its `sha256` hash is stored, and the daemon validates it constant-time. A wrong secret or an unknown hook id returns an identical `401`, so the endpoint cannot be used to enumerate hooks. Send the secret as the `X-Urfael-Hook` header. The receiver port is `URFAEL_HOOKS_PORT` (default `7718`).

A hook's action is weaker than a chat message. `notify` pushes the payload to you and runs no model. `ask` runs the brain on the payload in a no-egress sandbox (`Read`/`Grep`/`Glob` only: no web, no write, no shell) with the payload framed as untrusted data and the result delivered only to you. `relay` adds an owner-fixed outbound reply (`--reply-url`, set at creation and SSRF-filtered, never read from the payload). So an event can wake the brain but cannot become an escalation.

The honest edges: exposing the loopback port to the internet is your decision and your own tunnel (`cloudflared`, `ngrok`, `ssh -R`); Urfael will not do it for you. Triggers are single-flight with the cron sandbox, so a flood of events cannot fork-bomb the brain. An `ask` while a brain run is already going is accepted (`202`) but its run is skipped rather than queued; `notify` always delivers. Every fire is written to the audit trail as a `webhook` principal.

Full detail, including the `relay` two-way channel, is in [docs/HOOKS.md](https://github.com/Grandillionaire/urfael/blob/main/docs/HOOKS.md).

## Related

- [features/overview.md](features/overview.md)
- [security/model.md](security/model.md)
- [start/quickstart.md](start/quickstart.md)
