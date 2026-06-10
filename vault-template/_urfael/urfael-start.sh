#!/usr/bin/env bash
# Start Urfael: load the always-on brain daemon (launchd) + open the overlay UI.
set -uo pipefail
PLIST="$HOME/Library/LaunchAgents/com.urfael.daemon.plist"
OVERLAY="$HOME/urfael/app"

echo "Starting Urfael…"
launchctl load -w "$PLIST" 2>/dev/null && echo "  ✓ brain daemon loaded (launchd)"
for i in $(seq 1 15); do [ -S "$HOME/.claude/urfael/daemon.sock" ] && { echo "  ✓ brain online"; break; }; sleep 1; done
( cd "$OVERLAY" && npm start >/tmp/urfael.log 2>&1 & ) && echo "  ✓ overlay opening"
echo "  Urfael is up. Say “Urfael” or tap the orb."
