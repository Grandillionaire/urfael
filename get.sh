#!/usr/bin/env bash
# Urfael one-line bootstrap — clones (or updates) the repo over HTTPS and hands off to ./install.sh.
#
#   curl -fsSL https://raw.githubusercontent.com/Grandillionaire/urfael/main/get.sh | bash
#
# This is a CONVENIENCE for parity with one-line installers. It is short on purpose so you can read it
# (and you should — piping any script to a shell is a trust decision). It installs NOTHING risky itself:
# it only fetches the source and runs install.sh, which is itself read-it-first friendly and enables
# nothing automatically. The auditable path is identical and recommended: clone the repo, read it, run
# ./install.sh by hand (see the README). Override the target dir with URFAEL_DIR, the source with URFAEL_REPO.
set -euo pipefail

REPO_URL="${URFAEL_REPO:-https://github.com/Grandillionaire/urfael.git}"
DIR="${URFAEL_DIR:-$HOME/urfael}"

say(){ printf '%s\n' "$1"; }
need(){ command -v "$1" >/dev/null 2>&1 || { say "✗ Urfael needs '$1' on your PATH first. Install it, then re-run."; exit 1; }; }

say "── Urfael bootstrap ─────────────────────────────"
need git; need node; need curl

if [ -d "$DIR/.git" ]; then
  say "→ updating the existing clone at $DIR"
  git -C "$DIR" pull --ff-only || say "  (pull skipped — local changes present; using what's already there)"
else
  [ -e "$DIR" ] && { say "✗ $DIR exists but is not a git clone. Move it aside or set URFAEL_DIR=… and re-run."; exit 1; }
  say "→ cloning $REPO_URL → $DIR"
  git clone --depth 1 "$REPO_URL" "$DIR"
fi

cd "$DIR"
say "→ handing off to ./install.sh (read-it-first friendly; enables nothing risky)"
exec ./install.sh
