#!/usr/bin/env bash
# Urfael installer (macOS + Linux). Idempotent: scaffolds what's missing, never overwrites your vault
# or secrets, and enables NOTHING risky automatically. Read SECURITY.md first.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JDIR="$HOME/.claude/urfael"
VAULT="$HOME/Urfael"
MEM="$HOME/Urfael-memory"
LA="$HOME/Library/LaunchAgents"
SDU="$HOME/.config/systemd/user"

# ── presentation: a designed terminal experience (gold-on-dark; color on a TTY, plain when piped) ──────
if [ -t 1 ]; then
  G=$'\033[38;5;179m'; GB=$'\033[1;38;5;179m'; AM=$'\033[38;5;214m'; D=$'\033[2m'
  GR=$'\033[38;5;108m'; RD=$'\033[38;5;167m'; CY=$'\033[38;5;109m'; R=$'\033[0m'
else G=''; GB=''; AM=''; D=''; GR=''; RD=''; CY=''; R=''; fi
say(){  printf '%s\n' "$1"; }
ok(){   printf "    ${GR}✓${R}  %s\n" "$1"; }                 # done / present
warn(){ printf "    ${AM}●${R}  %s\n" "$1"; }                # optional / heads-up
bad(){  printf "    ${RD}✗${R}  %s\n" "$1"; }                # missing / problem
sect(){ printf "\n  ${GB}▌${R} ${GB}%s${R}  ${D}%s${R}\n" "$1" "${2:-}"; }   # a step group, like a menu section
banner(){
  printf "\n${G}"
  cat <<'LOGO'
    ██╗   ██╗██████╗ ███████╗ █████╗ ███████╗██╗
    ██║   ██║██╔══██╗██╔════╝██╔══██╗██╔════╝██║
    ██║   ██║██████╔╝█████╗  ███████║█████╗  ██║
    ██║   ██║██╔══██╗██╔══╝  ██╔══██║██╔══╝  ██║
    ╚██████╔╝██║  ██║██║     ██║  ██║███████╗███████╗
     ╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝╚══════╝╚══════╝
LOGO
  printf "${R}    ${AM}ᚢ${R}  ${D}an old intelligence, in service to one.${R}\n"
}

# Which platform are we on? Darwin = macOS, Linux = Linux. Everything else is unsupported.
OS="$(uname)"
case "$OS" in
  Darwin) ;;
  Linux)  ;;
  *) printf "  ${RD}✗ Urfael supports macOS and Linux only (uname=%s).${R}\n" "$OS"; exit 1 ;;
esac
banner
printf "\n  ${GB}I N S T A L L${R}   ${D}· idempotent · nothing risky enabled · keeps your vault & secrets${R}\n"

# ── shared steps ─────────────────────────────────────────────────────────────
# These behave identically on macOS and Linux (no platform-specific shell-outs).

# config dir + the local whisper model (~142MB, one time) so voice works out of the box — no API key.
# Pinned SHA-256 so a tampered/changed upstream artifact is rejected (fail-closed).
fetch_model(){
  mkdir -p "$JDIR"
  MODELDIR="$JDIR/models"; mkdir -p "$MODELDIR"
  WHISPER_SHA256="a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002"
  if [ -f "$MODELDIR/ggml-base.en.bin" ]; then ok "whisper model present"; else
    warn "downloading whisper base.en model (~142MB, one time)…"
    if curl -fsSL -o "$MODELDIR/ggml-base.en.bin" \
         https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin; then
      if echo "$WHISPER_SHA256  $MODELDIR/ggml-base.en.bin" | shasum -a 256 -c - >/dev/null 2>&1; then
        ok "local STT model ready (checksum verified)"
      else
        rm -f "$MODELDIR/ggml-base.en.bin"
        warn "model checksum MISMATCH — deleted for safety. Re-run, or set STT_PROVIDER=elevenlabs"
      fi
    else
      warn "model download failed — re-run, or set STT_PROVIDER=elevenlabs"
    fi
  fi
}

# secret templates (never overwrite an existing real file)
write_secret_templates(){
  for f in tts.env api-keys.env bridge.env; do
    if [ -f "$JDIR/$f" ]; then ok "$f already exists (kept)"; else cp "$REPO/config/$f.example" "$JDIR/$f"; chmod 600 "$JDIR/$f"; ok "wrote $JDIR/$f (add your keys)"; fi
  done
}

# scaffold the vault from the template (never overwrite an existing vault)
scaffold_vault(){
  if [ -e "$VAULT" ]; then ok "$VAULT already exists (kept — not overwritten)"; else
    cp -R "$REPO/vault-template" "$VAULT"
    rm -rf "$VAULT/memory"                                        # memory lives in ~/Urfael-memory, not the vault
    ( cd "$VAULT" && [ -L .claude ] || ln -s _urfael .claude )   # Claude Code reads commands/hooks via .claude
    chmod +x "$VAULT"/_urfael/*.sh 2>/dev/null
    ok "scaffolded $VAULT (fill the {{PLACEHOLDERS}} in CLAUDE.md)"
  fi
}

# local, private memory repo (never public)
scaffold_memory(){
  if [ -d "$MEM/.git" ]; then ok "$MEM already exists"; else
    mkdir -p "$MEM"; cp "$REPO/vault-template/memory/"*.md "$MEM/"
    ( cd "$MEM" && git init -q && git add -A && git commit -q -m "init: Urfael memory" 2>/dev/null )
    ok "created private local memory repo at $MEM"
  fi
}

# record where the repo lives — service units get the literal path baked in; vault scripts read this file.
#   (No canonical ~/urfael: on macOS the filesystem is case-INsensitive, so ~/urfael would collide
#   with the ~/Urfael vault. Clone the repo anywhere; everything resolves through this.)
record_repo(){ printf '%s' "$REPO" > "$JDIR/repo"; ok "repo path recorded ($REPO)"; }

# app deps + the `urfael` terminal command
install_app_and_cli(){
  if [ -d "$REPO/app/node_modules" ]; then ok "app deps installed"; else ( cd "$REPO/app" && npm install --silent ) && ok "npm install (app)"; fi
  BINDIR="$(dirname "$(command -v node || echo /opt/homebrew/bin/node)")"
  if [ -w "$BINDIR" ]; then ln -sfn "$REPO/app/cli.js" "$BINDIR/urfael" && chmod +x "$REPO/app/cli.js" && ok "linked \`urfael\` CLI into $BINDIR"
  else warn "can't write $BINDIR — run: npm link --prefix \"$REPO/app\" (or alias urfael=\"node $REPO/app/cli.js\")"; fi
}

if [ "$OS" = "Darwin" ]; then
  # ════════════════════════════ macOS ════════════════════════════
  # 1) dependency check (report, don't auto-install heavy things)
  sect "DEPENDENCIES" "what the brain + local voice need"
  for c in claude node npm; do command -v "$c" >/dev/null && ok "$c" || warn "$c MISSING — install it (claude: https://claude.com/claude-code)"; done
  command -v uv >/dev/null && ok "uv" || warn "uv missing — https://docs.astral.sh/uv (needed for some MCP servers)"
  { command -v gtimeout >/dev/null || command -v timeout >/dev/null; } && ok "timeout/gtimeout" || warn "gtimeout missing — 'brew install coreutils' (needed for the autonomous loop)"
  python3 -c 'import matplotlib' 2>/dev/null && ok "matplotlib" || warn "matplotlib missing — 'pip3 install --user matplotlib numpy' (for charts)"
  # local, API-free voice deps
  ok "say (macOS TTS, built-in)"
  command -v ffmpeg >/dev/null && ok "ffmpeg" || warn "ffmpeg missing — 'brew install ffmpeg' (local voice needs it)"
  command -v whisper-server >/dev/null && ok "whisper-cpp (local STT)" || warn "whisper-cpp missing — 'brew install whisper-cpp' (free local speech-to-text)"

  # 2) config dir + model + secret templates
  sect "VOICE & CONFIG" "local speech model (checksum-pinned) + secret templates (chmod 600)"
  fetch_model
  write_secret_templates

  # 3) scaffold the vault from the template (never overwrite an existing vault)
  sect "VAULT & MEMORY" "your second brain (PARA + daily notes) + a private, git-versioned memory repo"
  scaffold_vault

  # 4) local, private memory repo (never public)
  scaffold_memory

  # 5) record where the repo lives — plists get the literal path baked in; vault scripts read this file.
  record_repo

  # 6) app deps + the `urfael` terminal command
  sect "APP & CLI" "node deps + the \`urfael\` terminal command"
  install_app_and_cli

  # 7) launchd plists — fill placeholders, but DO NOT auto-load (you choose what runs in the background)
  sect "BACKGROUND SERVICES" "launchd units — written, NOT loaded (you decide what runs)"
  NODE="$(command -v node || echo /opt/homebrew/bin/node)"
  mkdir -p "$LA"
  for t in "$REPO"/config/launchagents/*.plist.template; do
    out="$LA/$(basename "${t%.template}")"
    sed -e "s|{{HOME}}|$HOME|g" -e "s|{{NODE}}|$NODE|g" -e "s|{{REPO}}|$REPO|g" "$t" > "$out"
  done
  ok "wrote launchd plists to $LA (not loaded)"

  cat <<NEXT

${GB}▌ FIRST STEPS${R}   ${D}you choose what runs — nothing was started for you${R}
1. Voice works out of the box — FREE & local (macOS \`say\` + whisper.cpp), no API key needed.
   Optional: edit "$JDIR/tts.env" for a higher-quality local voice (Kokoro) or to add an ElevenLabs key.
2. Open ~/Urfael as a vault in Obsidian → enable community plugins → install "Local REST API",
   then register it:  cd ~/Urfael && claude mcp add -s local --transport http obsidian \\
      http://127.0.0.1:27123/mcp/ --header "Authorization: Bearer <your REST key>"
3. Fill the {{USER_NAME}} / {{CITY}} / {{TIMEZONE}} / {{LANGUAGE}} placeholders in ~/Urfael/CLAUDE.md
4. Start the brain + UI:
      launchctl load -w "$LA/com.urfael.daemon.plist"      # the always-on brain
      cd "$REPO/app" && npm start                          # the overlay UI
   (optional, opt-in:  launchctl load -w the morningbrief / obsidian-heal plists)
5. ⚠️  Hands/eyes, the autonomous loop, and full permissions are OFF by default.
   Read SECURITY.md, then opt in (URFAEL_YOLO=1 in a sandbox; uncomment MCPs in config/mcp.json.example).

  ${AM}▸${R} ${GB}Run  urfael setup${R}  ${D}— pick how Urfael reaches Claude (your subscription, an API key, or a local model).${R}

  ${GB}ᚢ  Ready, sir.${R}  ${D}Talk to Urfael — tap the orb, or just run  ${R}${CY}urfael "hello"${R}${D}  from any terminal.${R}
NEXT

else
  # ════════════════════════════ Linux ════════════════════════════
  # 1) dependency check (report, don't auto-install heavy things). Package names vary by distro;
  #    we name the binary/library so you can `apt`/`dnf`/`pacman` it however your distro wants.
  sect "DEPENDENCIES" "what the brain + local voice need"
  for c in claude node npm; do command -v "$c" >/dev/null && ok "$c" || warn "$c MISSING — install it (claude: https://claude.com/claude-code)"; done
  command -v uv >/dev/null && ok "uv" || warn "uv missing — https://docs.astral.sh/uv (needed for some MCP servers)"
  command -v timeout >/dev/null && ok "timeout" || warn "timeout missing — install GNU coreutils (needed for the autonomous loop)"
  python3 -c 'import matplotlib' 2>/dev/null && ok "matplotlib" || warn "matplotlib missing — 'pip3 install --user matplotlib numpy' (for charts)"
  # local, API-free voice deps. The in-app Console/orb TTS (voice.js) REQUIRES espeak-ng/espeak (renders to a
  # file via ffmpeg); spd-say alone only covers the daemon's spoken notifications. So espeak is the one to have.
  if command -v espeak-ng >/dev/null || command -v espeak >/dev/null; then ok "espeak-ng/espeak (Linux TTS)"
  elif command -v spd-say >/dev/null; then warn "only spd-say found — notifications speak, but in-app voice needs 'espeak-ng' (apt install espeak-ng)"
  else warn "no Linux TTS — install 'espeak-ng' (apt install espeak-ng) for in-app voice + the morning brief"; fi
  command -v ffmpeg >/dev/null && ok "ffmpeg" || warn "ffmpeg missing — install 'ffmpeg' (local voice needs it)"
  command -v whisper-server >/dev/null && ok "whisper-cpp (local STT)" || warn "whisper-cpp missing — build whisper.cpp and put 'whisper-server' on PATH (free local speech-to-text)"
  # desktop notifications: libnotify's notify-send
  command -v notify-send >/dev/null && ok "notify-send (libnotify)" || warn "notify-send missing — install 'libnotify' / libnotify-bin (desktop notifications)"
  # screenshot/vision tool — any one of these works (Wayland: grim; X11: scrot/maim; ImageMagick: import)
  for s in grim scrot maim import; do command -v "$s" >/dev/null && { ok "screenshot tool ($s)"; SHOT_OK=1; break; }; done
  [ "${SHOT_OK:-0}" = 1 ] || warn "no screenshot tool — install 'grim' (Wayland) or 'scrot'/'maim' (X11) for vision"

  # 2) config dir + model + secret templates  (identical to macOS)
  sect "VOICE & CONFIG" "local speech model (checksum-pinned) + secret templates (chmod 600)"
  fetch_model
  write_secret_templates

  # 3) scaffold the vault from the template (never overwrite an existing vault)  (identical to macOS)
  sect "VAULT & MEMORY" "your second brain (PARA + daily notes) + a private, git-versioned memory repo"
  scaffold_vault

  # 4) local, private memory repo (never public)  (identical to macOS)
  scaffold_memory

  # 5) record where the repo lives — systemd units get the literal path baked in; vault scripts read this file.
  record_repo

  # 6) app deps + the `urfael` terminal command  (identical to macOS)
  install_app_and_cli

  # 7) systemd --user units — fill placeholders, but DO NOT enable (you choose what runs in the background)
  sect "BACKGROUND SERVICES" "systemd --user units — written, NOT enabled (you decide what runs)"
  NODE="$(command -v node || echo /usr/bin/node)"
  mkdir -p "$SDU"
  for t in "$REPO"/config/systemd/*.template; do
    out="$SDU/$(basename "${t%.template}")"
    sed -e "s|{{HOME}}|$HOME|g" -e "s|{{NODE}}|$NODE|g" -e "s|{{REPO}}|$REPO|g" "$t" > "$out"
  done
  command -v systemctl >/dev/null && systemctl --user daemon-reload >/dev/null 2>&1
  ok "wrote systemd --user units to $SDU (not enabled)"

  cat <<NEXT

${GB}▌ FIRST STEPS${R}   ${D}you choose what runs — nothing was started for you${R}
1. Voice works out of the box — FREE & local (espeak-ng/spd-say + whisper.cpp), no API key needed.
   Optional: edit "$JDIR/tts.env" for a higher-quality local voice (Kokoro) or to add an ElevenLabs key.
2. Open ~/Urfael as a vault in Obsidian → enable community plugins → install "Local REST API",
   then register it:  cd ~/Urfael && claude mcp add -s local --transport http obsidian \\
      http://127.0.0.1:27123/mcp/ --header "Authorization: Bearer <your REST key>"
3. Fill the {{USER_NAME}} / {{CITY}} / {{TIMEZONE}} / {{LANGUAGE}} placeholders in ~/Urfael/CLAUDE.md
4. Start the brain + UI:
      systemctl --user enable --now urfael-daemon          # the always-on brain
      cd "$REPO/app" && npm start                          # the overlay UI
   (optional, opt-in:  systemctl --user enable --now urfael-morningbrief.timer)
   Tip: to keep --user units running after logout, run:  loginctl enable-linger "\$USER"
5. ⚠️  Hands/eyes, the autonomous loop, and full permissions are OFF by default.
   Read SECURITY.md, then opt in (URFAEL_YOLO=1 in a sandbox; uncomment MCPs in config/mcp.json.example).

  ${AM}▸${R} ${GB}Run  urfael setup${R}  ${D}— pick how Urfael reaches Claude (your subscription, an API key, or a local model).${R}

  ${GB}ᚢ  Ready, sir.${R}  ${D}Talk to Urfael — tap the orb, or just run  ${R}${CY}urfael "hello"${R}${D}  from any terminal.${R}
NEXT

fi
