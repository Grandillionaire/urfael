#!/usr/bin/env bash
# Urfael Obsidian auto-heal. Keeps the Local REST API (port 27123) alive so the Obsidian MCP tools
# stay connected. Run by launchd every ~2 min. SAFE BY DESIGN (hardened after adversarial review):
#  - Only acts when the port is genuinely down (HTTP 200 = healthy).
#  - If Obsidian is CLOSED → do nothing (the user closed it on purpose; the vault still works via files).
#  - If Obsidian is FRONTMOST (the user is actively in it) → do nothing this cycle (never disrupt active work).
#  - NEVER force-kills Obsidian: a graceful `quit` (which saves) is used at most ONCE per 2h, and only
#    when Obsidian is not frontmost — so no data loss and no fighting the user.
#  - Single-instance lock (atomic mkdir, auto-reclaimed if a prior run hung) → no overlapping/looping runs.
#  - Notifies once when it can't self-heal; then backs off silently until the port recovers.
#  - Pause anytime:  touch ~/.claude/urfael/obsidian-heal.pause
set -uo pipefail

PORT=27123
VAULT_URI="obsidian://open?path=$HOME/Urfael"
DIR="$HOME/.claude/urfael"
LOG="$DIR/obsidian-heal.log"; STATE="$DIR/obsidian-heal.state"; PAUSE="$DIR/obsidian-heal.pause"
LOCKDIR="$DIR/obsidian-heal.lock.d"; LASTHARD="$DIR/obsidian-heal.lasthard"
HARD_COOLDOWN=7200   # min seconds between graceful restarts (anti-flap)

ts(){ date '+%F %T'; }
log(){ printf '%s %s\n' "$(ts)" "$1" >>"$LOG" 2>/dev/null; }
port_up(){ [ "$(curl -s --max-time 4 "http://127.0.0.1:$PORT/" -o /dev/null -w '%{http_code}' 2>/dev/null)" = "200" ]; }
obsidian_running(){ pgrep -x Obsidian >/dev/null 2>&1; }
obsidian_frontmost(){ lsappinfo info -only name "$(lsappinfo front 2>/dev/null)" 2>/dev/null | grep -q '"Obsidian"'; }

[ -f "$PAUSE" ] && exit 0

# single-instance lock; reclaim a stale lock if a previous run hung (>5 min) — exit traps don't fire on hangs
if [ -d "$LOCKDIR" ] && [ -n "$(find "$LOCKDIR" -maxdepth 0 -mmin +5 2>/dev/null)" ]; then rmdir "$LOCKDIR" 2>/dev/null; fi
mkdir "$LOCKDIR" 2>/dev/null || exit 0
trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT

if port_up; then echo 0 >"$STATE" 2>/dev/null; exit 0; fi          # healthy
obsidian_running || { echo 0 >"$STATE" 2>/dev/null; exit 0; }      # closed on purpose → respect it
obsidian_frontmost && exit 0                                       # the user is actively in Obsidian → don't disrupt

fails=$(cat "$STATE" 2>/dev/null || echo 0); case "$fails" in ''|*[!0-9]*) fails=0;; esac
fails=$((fails + 1)); echo "$fails" > "$STATE" 2>/dev/null

if [ "$fails" -le 2 ]; then
  # gentle, non-destructive: reload the Urfael vault (fixes the common "wrong vault open" case)
  log "REST API down — gentle vault reload (#$fails)"
  open "$VAULT_URI" >/dev/null 2>&1
  for i in $(seq 1 15); do port_up && { log "✓ healed in ${i}s (gentle)"; echo 0 > "$STATE" 2>/dev/null; exit 0; }; sleep 1; done
elif [ "$fails" -eq 3 ]; then
  # gentle didn't work (plugin server likely died) → ONE graceful restart, max once per cooldown
  last=$(cat "$LASTHARD" 2>/dev/null || echo 0); case "$last" in ''|*[!0-9]*) last=0;; esac
  if [ $(( $(date +%s) - last )) -ge "$HARD_COOLDOWN" ]; then
    log "gentle reload failed — graceful restart of Obsidian (quit saves first, no data loss)"
    date +%s > "$LASTHARD" 2>/dev/null
    osascript -e 'tell application "Obsidian" to quit' >/dev/null 2>&1
    for i in $(seq 1 12); do obsidian_running || break; sleep 1; done
    open "$VAULT_URI" >/dev/null 2>&1
    for i in $(seq 1 25); do port_up && { log "✓ healed after graceful restart"; echo 0 > "$STATE" 2>/dev/null; exit 0; }; sleep 1; done
  else
    log "skipping restart (within ${HARD_COOLDOWN}s cooldown)"
  fi
  log "✗ still down — notifying the user; backing off (community plugins likely OFF / Restricted Mode — needs a manual toggle)"
  osascript -e 'display notification "Obsidian connection is down. Open the Urfael vault and make sure community plugins are enabled." with title "Urfael"' 2>/dev/null
fi
# fails >= 4: silent back-off — do nothing until the port recovers (port_up resets state to 0)
exit 0
