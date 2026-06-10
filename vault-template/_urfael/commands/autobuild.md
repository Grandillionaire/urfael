---
description: Autonomously pursue a coding goal until done (guardrailed loop)
argument-hint: <goal> (and which repo)
---

the user wants you to autonomously work toward a coding goal: $ARGUMENTS

This is a RISKY autonomous action, so:
1. **Confirm first.** Restate the goal, the target repo, and the caps you'll use, and get the user's
   explicit "go" before launching. If the repo isn't a git repo, say so — the loop requires one.
2. **Strongly prefer an isolated copy.** Offer to run it in a fresh `git worktree` so his main
   checkout is untouched: `git -C <repo> worktree add ../<name>-auto -b <name>-auto`.
3. **Launch the guardrailed loop** (it caps iterations + wall-clock, kills hung turns, and stops on
   no-progress — it does NOT push or merge):
   ```sh
   bash ~/Urfael/_urfael/goal-loop.sh "<the goal>" --repo <repo-or-worktree> --check "<verify cmd, e.g. npm test>" --max-iters 15 --max-mins 120
   ```
   Pass a `--check` command whenever there's a real way to verify success (tests/build) — the loop
   only declares done when the model says GOAL_COMPLETE *and* that command exits 0.
4. **Report back, don't auto-merge.** When it finishes (or a guardrail trips), summarize what
   happened, show `git -C <repo> diff --stat`, and let the user review + decide whether to merge/push.
   If you can reach him, ping him; otherwise leave the summary in the conversation.
