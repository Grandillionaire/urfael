#!/usr/bin/env bash
# Urfael — per-machine bootstrap. Run ONCE on each new Mac after Obsidian Sync has
# pulled the vault down. Sets up the three things that don't (and shouldn't) sync:
#   1. the .claude -> _urfael symlink (Claude Code reads commands/hooks/settings here)
#   2. ~/.claude/urfael/tts.env  (your ElevenLabs key — a secret, stays off sync)
#   3. the Obsidian MCP registration (points at THIS machine's localhost + local key)
#
# Idempotent: safe to re-run. Usage:  bash _urfael/bootstrap-machine.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAULT="$(dirname "$SCRIPT_DIR")"
PLUGIN_DATA="$VAULT/.obsidian/plugins/obsidian-local-rest-api/data.json"
TTS_ENV="$HOME/.claude/urfael/tts.env"

echo "Urfael bootstrap — vault: $VAULT"
command -v claude  >/dev/null || { echo "✗ Claude Code (claude) not installed. Install it first."; exit 1; }
command -v python3 >/dev/null || { echo "✗ python3 not found."; exit 1; }

# 1) .claude -> _urfael symlink ------------------------------------------------
if [ -L "$VAULT/.claude" ]; then
  echo "✓ .claude symlink already present"
elif [ -e "$VAULT/.claude" ]; then
  echo "✗ $VAULT/.claude exists and is NOT a symlink — move it aside, then re-run."; exit 1
else
  ( cd "$VAULT" && ln -s _urfael .claude )
  echo "✓ created .claude -> _urfael symlink"
fi

# 2) tts.env (voice config — free local default, no API key) -------------------
mkdir -p "$(dirname "$TTS_ENV")"
if [ -f "$TTS_ENV" ]; then
  echo "✓ tts.env already present (kept)"
else
  cat > "$TTS_ENV" <<'EOF'
# Urfael voice config. DEFAULT = free & local (macOS `say` + whisper.cpp), no API key.
# NEVER synced/committed. chmod 600.
TTS_PROVIDER=say
STT_PROVIDER=whispercpp
SAY_VOICE=Daniel
WHISPER_MODEL=base.en
# Optional paid upgrade — set TTS_PROVIDER=elevenlabs and add your key below:
ELEVENLABS_API_KEY=
TTS_VOICE_ID=JBFqnCBsd6RMkjVDRZzb
ELEVENLABS_TTS_MODEL=eleven_turbo_v2_5
EOF
  chmod 600 "$TTS_ENV"
  echo "→ wrote tts.env (free local voice by default; add an ElevenLabs key only for premium TTS)"
fi

# 2b) long-term memory repo ----------------------------------------------------
if [ -d "$HOME/Urfael-memory/.git" ]; then
  echo "✓ urfael-memory present"
elif command -v gh >/dev/null; then
  gh repo clone ${URFAEL_MEMORY_REPO:-} "$HOME/Urfael-memory" >/dev/null 2>&1 \
    && echo "✓ cloned urfael-memory" || echo "→ clone urfael-memory manually: gh repo clone ${URFAEL_MEMORY_REPO:-} ~/Urfael-memory"
else
  echo "→ install gh + run: gh repo clone ${URFAEL_MEMORY_REPO:-} ~/Urfael-memory"
fi

# 3) Obsidian MCP registration -------------------------------------------------
if curl -s --max-time 3 http://127.0.0.1:27123/ -o /dev/null; then
  KEY="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("apiKey",""))' "$PLUGIN_DATA" 2>/dev/null || true)"
  if [ -n "$KEY" ]; then
    ( cd "$VAULT" && claude mcp remove obsidian >/dev/null 2>&1 || true
      claude mcp add -s local --transport http obsidian "http://127.0.0.1:27123/mcp/" \
        --header "Authorization: Bearer $KEY" >/dev/null )   # -s local => key in ~/.claude.json, NOT a .mcp.json inside the synced vault
    echo "✓ registered Obsidian MCP (local scope, bound to this vault)"
  else
    echo "→ REST API up but no apiKey in data.json yet — open the vault in Obsidian, then re-run."
  fi
else
  echo "→ Obsidian REST API not reachable on :27123. In Obsidian: open this vault,"
  echo "  Settings → Community plugins → 'Turn on community plugins' (one-time trust), then re-run."
fi

echo
echo "Remaining manual steps on this machine:"
echo "  • Obsidian: open the synced Urfael vault + turn on community plugins (trust gate is per-machine)"
echo "  • Wispr Flow: install from wisprflow.ai, sign in, grant Mic + Accessibility"
echo "Then:  cd \"$VAULT\" && claude"
