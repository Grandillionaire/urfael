# Coding

Urfael's brain is the `claude` CLI, so it makes a sharper coding tool than the bare CLI. `urfael code "<task>"` runs Claude Code in your own repo with three things stacked on it: it remembers each repo, it checkpoints the whole working tree before it touches anything, and it gives you a one-command undo.

```bash
urfael code "add a retry to the API client"
urfael checkpoints
urfael rewind            # undo the last coding turn
```

## What a coding turn does

Run from inside a git repo (or point at one with `--dir`):

1. **Resolves the repo and its memory.** The project id derives from the git remote, so the same repo shares one memory across clones. With no remote it falls back to the directory name plus a hash of the path, so two repos with the same basename never collide.
2. **Loads per-project memory.** A `CONVENTIONS.md` and `HISTORY.md` for that repo live under the private memory repo (`~/Urfael-memory/projects/<id>/`). The conventions load as context every turn, fenced as reference, not instructions. The first run seeds a `CONVENTIONS.md` for you to fill in.
3. **Checkpoints first.** Before the brain runs, the working tree (tracked and untracked, the set `git add -A` stages) is snapshotted onto a private git shadow ref (`refs/urfael/checkpoints/<id>`) through a temporary index. This captures that set yet touches nothing live: not your branch, not your index, not your working tree.
4. **Runs Claude Code in the repo,** seeded with the project conventions and your task.
5. **Records the turn.** The task and its checkpoint id are appended to the repo's `HISTORY.md` and an append-only log, both inside the git-versioned memory repo.

## Per-project memory

Claude Code forgets each repo between sessions. Urfael keeps a stable memory per repo so it picks up your conventions instead of relearning them:

- `CONVENTIONS.md` is yours to edit. Put the stack, the layout, the conventions, and the gotchas that bit you before. It loads every turn.
- `HISTORY.md` is appended automatically, one entry per coding turn, each with the checkpoint to rewind to.

Edit the conventions file at the path the command prints after a run. Disable memory for one run with `--no-memory`.

## Checkpoints and rewind

A checkpoint is a snapshot of your whole working tree, stored as a commit on a private shadow ref. It does not appear in `git log`, does not move your branch, and does not touch your index. List them:

```bash
urfael checkpoints
```

Rewind restores your tracked files to a snapshot:

```bash
urfael rewind                 # the latest checkpoint
urfael rewind k3xq9z-1a2b     # a specific one
```

Rewind is safe by construction:

- It **checkpoints the current state first**, so the rewind is itself reversible. The command prints the id that undoes it. If that pre-checkpoint cannot be made (so the rewind would be irreversible), it refuses rather than overwrite your files; `--force` overrides.
- It **keeps files you created since** the snapshot rather than deleting them, and lists them. It never runs a destructive clean.
- It **leaves only your working tree changed.** After restoring, it unstages, so `git status` shows the restored files as ordinary working-tree edits for you to review, not a surprise staged commit.
- It asks before it touches anything. Pass `--yes` to skip the prompt in a script.

## Flags

- `--dir <path>` run against a repo other than the current directory.
- `--no-checkpoint` skip the snapshot for this run.
- `--no-memory` skip loading and writing per-project memory.
- `--no-run` checkpoint and load memory but do not run the brain (a quick way to take a snapshot).
- `--yes` (on `rewind`) skip the confirmation prompt.
- `--force` (on `rewind`) proceed even if the pre-rewind checkpoint of the current state could not be made.

## Honest scope

The checkpoint mechanism relies on git, so `urfael code` needs a git repo (it tells you to run `git init` if you are not in one).

A checkpoint covers tracked and untracked files, the same set as `git add -A`. Files matched by `.gitignore` (often `.env`, local config, build output) are deliberately left out, so a secret is never copied into a shadow ref. If the agent might change an ignored file you care about, back it up yourself.

Rewind restores files to a snapshot and keeps newer files rather than deleting them, which is the safe default but means a rewind is an overlay, not a byte-for-byte mirror. For unattended, self-committing work, that is the separate, sandboxed `/goal` loop, not this. `urfael code` is the supervised, undoable coding session.

## Related

- [features/memory.md](features/memory.md)
- [features/automation.md](features/automation.md)
- [reference/cli.md](reference/cli.md)
