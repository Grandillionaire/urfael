---
description: Run, check, or cancel a long background job (so it doesn't block the conversation)
argument-hint: list | status <id> | cancel <id> | <a long task to run in the background>
---

$ARGUMENTS

The brain daemon runs detached background jobs over its local socket so long work (autonomous coding,
deep research) doesn't tie up the live conversation. Talk to it with `curl --unix-socket`:

- **List jobs:** `curl -s --unix-socket ~/.claude/urfael/daemon.sock http://x/jobs`
- **Status + log tail:** `curl -s --unix-socket ~/.claude/urfael/daemon.sock http://x/job/<id>`
- **Cancel (real kill switch):** `curl -s -X POST --unix-socket ~/.claude/urfael/daemon.sock http://x/job/<id>/cancel`
- **Start a job:** POST `/job` with one of these JSON specs:
  - **Autonomous coding** (guard-railed: needs an isolated worktree, caps, never pushes):
    `{"kind":"goal","goal":"<what to build>","repo":"<path to an isolated git worktree>","maxIters":15,"maxMins":120}`
  - **Long research / writing** (sandboxed: no shell, no computer-use; writes a note into the vault):
    `{"kind":"research","prompt":"<the task>"}`
  ```bash
  curl -s -X POST --unix-socket ~/.claude/urfael/daemon.sock http://x/job \
    -H 'Content-Type: application/json' -d '{"kind":"research","prompt":"..."}'
  ```

How to behave:
1. If the user said "list" / "what's running", call `/jobs` and report each job's id, kind, and state in one line each.
2. If they asked for status of an id, call `/job/<id>` and summarize state + the tail of the log.
3. If they asked to cancel, confirm which id, then POST the cancel and report the result.
4. Otherwise treat the arguments as a task to run in the background: pick `goal` (coding, with an isolated
   `--repo` worktree — never the live checkout) or `research`, start it, and tell the user the job id and that
   you'll get a notification when it finishes. Caps are clamped by the daemon; don't try to exceed them.
