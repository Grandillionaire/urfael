#!/usr/bin/env bash
# goal-loop.sh — guardrailed autonomous coding loop for Urfael (wraps Claude Code).
#
# SAFETY (the user's hard rule: kill-switches, not just exit traps):
#   • requires a git repo (so you can `git reset --hard`)
#   • caps iterations AND wall-clock time
#   • `timeout` SIGKILLs a hung turn — exit traps don't fire on hung subprocesses
#   • no-progress circuit breaker (git state unchanged N turns → abort)
#   • needs a real completion signal (GOAL_COMPLETE marker + optional --check command)
#   • prints everything; logs to .urfael-goal.log; never auto-merges, never auto-pushes
# Run it in a git worktree or container, not your only copy. Supervise the first run.
set -uo pipefail

GOAL=""; REPO=""; MAX_ITERS=15; MAX_MINS=120; TURN_TIMEOUT=900; CHECK=""; MODEL="sonnet"; STALE_LIMIT=3
usage(){ echo 'Usage: goal-loop.sh "<goal>" [--repo DIR] [--max-iters N] [--max-mins M] [--turn-timeout S] [--check "cmd"] [--model NAME]'; }
while [ $# -gt 0 ]; do case "$1" in
  --repo) REPO="$2"; shift 2;; --max-iters) MAX_ITERS="$2"; shift 2;; --max-mins) MAX_MINS="$2"; shift 2;;
  --turn-timeout) TURN_TIMEOUT="$2"; shift 2;; --check) CHECK="$2"; shift 2;; --model) MODEL="$2"; shift 2;;
  -h|--help) usage; exit 0;; *) if [ -z "$GOAL" ]; then GOAL="$1"; else echo "unknown arg: $1"; usage; exit 1; fi; shift;; esac; done

[ -n "$GOAL" ] || { echo "✗ no goal given."; usage; exit 1; }
# SECURITY (M6): never default to the current dir. Require an explicit --repo pointing at an ISOLATED git
# worktree/container so a runaway loop can't touch your real work. Bypass mode is opt-in (URFAEL_YOLO=1).
[ -n "$REPO" ] || { echo "✗ no --repo given. Point this at an ISOLATED git worktree/container, not your live checkout."; usage; exit 1; }
[ -d "$REPO/.git" ] || { echo "✗ $REPO is not a git repo (need one so you can reset). Aborting."; exit 1; }
command -v claude >/dev/null || { echo "✗ claude not found."; exit 1; }
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"   # macOS coreutils installs as gtimeout
[ -n "$TIMEOUT_BIN" ] || { echo "✗ no 'timeout'/'gtimeout' (brew install coreutils) — needed for the hung-turn watchdog. Aborting."; exit 1; }
CLAUDE_BIN="$(command -v claude)"; LOG="$REPO/.urfael-goal.log"; : > "$LOG"

cat <<BANNER
── Urfael goal-loop ──────────────────────────────────
  goal:       $GOAL
  repo:       $REPO
  caps:       $MAX_ITERS iters · ${MAX_MINS}m wall · ${TURN_TIMEOUT}s/turn · stop after $STALE_LIMIT stale
  completion: GOAL_COMPLETE marker${CHECK:+ + check: $CHECK}
  model:      $MODEL   (perm mode: ${URFAEL_YOLO:+bypassPermissions}${URFAEL_YOLO:-acceptEdits} — supervise; isolated worktree/container)
──────────────────────────────────────────────────────
BANNER

START=$(date +%s); cd "$REPO" || exit 1; prev=""; stale=0; errs=0; sid=""; DONE=""; MARKER="URFAEL-GOAL-DONE"
parse_field(){ printf '%s' "$1" | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('$2',''))
except Exception: print('')"; }

# Pre-flight: if a verify command is given and already passes, the goal's done — don't burn a turn.
if [ -n "$CHECK" ] && bash -c "$CHECK" >>"$LOG" 2>&1; then echo "✅ goal already satisfied (verify passes)."; exit 0; fi

for (( i=1; i<=MAX_ITERS; i++ )); do
  now=$(date +%s); (( (now-START)/60 >= MAX_MINS )) && { echo "⏰ wall-clock cap (${MAX_MINS}m) hit. Stopping."; break; }
  echo "── iteration $i/$MAX_ITERS · $(( (now-START)/60 ))m elapsed ──"
  PROMPT="Work toward this goal in this repo: ${GOAL}
Make concrete, committed progress this turn. When the goal is fully achieved and verified${CHECK:+ (so '$CHECK' passes)}, end your reply with a line containing only: ${MARKER}. If you are blocked or it is unsafe to proceed, explain why and stop."
  PERM="${URFAEL_YOLO:+bypassPermissions}"; PERM="${PERM:-acceptEdits}"; FLAGS=(--model "$MODEL" --permission-mode "$PERM" --output-format json)
  [ -n "$sid" ] && FLAGS+=(--resume "$sid")     # pin OUR session so a stray claude in this dir can't be hijacked
  out=$("$TIMEOUT_BIN" -k 10 "$TURN_TIMEOUT" "$CLAUDE_BIN" -p "$PROMPT" "${FLAGS[@]}" 2>>"$LOG"); rc=$?
  if [ $rc -eq 124 ]; then echo "⏰ turn $i exceeded ${TURN_TIMEOUT}s — killed. Continuing."; errs=0
  elif [ $rc -ne 0 ]; then errs=$((errs+1)); echo "⚠️ claude exited $rc (error $errs/2).";
    (( errs >= 2 )) && { echo "🛑 claude failing repeatedly — stopping (check $LOG: API key / quota / crash)."; break; }
    continue
  else errs=0; fi

  text=$(parse_field "$out" result)
  [ -z "$sid" ] && sid=$(parse_field "$out" session_id)
  printf '\n===== iter %s =====\n%s\n' "$i" "$text" >> "$LOG"
  printf '%s\n' "$text" | tail -4

  # Completion: the verify command is the source of truth; the marker only counts (as last line) if no check given.
  if [ -n "$CHECK" ]; then
    if bash -c "$CHECK" >>"$LOG" 2>&1; then echo "✅ verify command passes — done."; DONE=1; break; fi
  else
    last=$(printf '%s' "$text" | grep -v '^[[:space:]]*$' | tail -1)
    [ "$last" = "$MARKER" ] && { echo "✅ completion marker (no verify command given)."; DONE=1; break; }
  fi

  state="$(git rev-parse HEAD 2>/dev/null)$(git status --porcelain 2>/dev/null | shasum | awk '{print $1}')"
  if [ "$state" = "$prev" ]; then stale=$((stale+1)); else stale=0; fi; prev="$state"
  (( stale >= STALE_LIMIT )) && { echo "🛑 no git progress for $STALE_LIMIT turns — circuit breaker. Stopping."; break; }
done

echo "──────────────────────────────────────────────────────"
if [ -n "$DONE" ]; then echo "Result: COMPLETED after $i iters. Review:  git -C \"$REPO\" diff"; OUTCOME="completed ✅"
else echo "Result: STOPPED (not confirmed complete) after $i iters. Review $LOG and:  git -C \"$REPO\" diff"; OUTCOME="stopped (needs you) ⚠️"; fi
echo "Nothing was pushed or merged — that's yours to do."
# phone push (best-effort; silent no-op if no bridge.env / node)
NOTIFY="$HOME/urfael/app/bridge/notify.js"
[ -f "$NOTIFY" ] && command -v node >/dev/null 2>&1 && node "$NOTIFY" "Goal $OUTCOME after $i iters: $GOAL" >/dev/null 2>&1 || true
