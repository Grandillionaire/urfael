# install.ps1 — Urfael installer for native Windows. The PowerShell twin of install.sh: idempotent,
# scaffolds what is missing, never overwrites your vault or secrets, and enables NOTHING risky
# automatically. Read SECURITY.md first.
#
#   Run it from a PowerShell prompt:   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   (Double-clicking a .ps1 opens Notepad by design on Windows — use the command above.)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$REPO  = $PSScriptRoot
$JDIR  = Join-Path $HOME '.claude\urfael'
$VAULT = Join-Path $HOME 'Urfael'
$MEM   = Join-Path $HOME 'Urfael-memory'
$UBIN  = Join-Path $env:LOCALAPPDATA 'Urfael\bin'

# ── presentation (gold-on-dark when the host supports ANSI; plain otherwise) ─────────────────────────
$ANSI = $Host.UI.SupportsVirtualTerminal -or $env:WT_SESSION -or ($PSVersionTable.PSVersion.Major -ge 7)
function C($code, $s) { if ($ANSI) { "$([char]27)[$($code)m$s$([char]27)[0m" } else { $s } }
function Say($s)  { Write-Host $s }
function Ok($s)   { Write-Host ("    " + (C '38;5;108' ([char]0x2713)) + "  " + $s) }
function Warn($s) { Write-Host ("    " + (C '38;5;214' ([char]0x25CF)) + "  " + $s) }
function Bad($s)  { Write-Host ("    " + (C '38;5;167' ([char]0x2717)) + "  " + $s) }
$RUNES = @([char]0x16A2, [char]0x16B1, [char]0x16A0, [char]0x16A8, [char]0x16D6, [char]0x16DA)  # ᚢᚱᚠᚨᛖᛚ
$script:RI = 0
function Sect($title, $sub) {
  $rune = $RUNES[$script:RI % 6]; $script:RI++
  Write-Host ""
  Write-Host ("  " + (C '38;5;214' $rune) + "  " + (C '1;38;5;179' $title) + "  " + (C '2' $sub))
}
Write-Host ""
foreach ($l in @(
  '    ##     ## #######  ########  #####  ######## ##',
  '    ##     ## ##    ## ##       ##   ## ##       ##',
  '    ##     ## #######  #####    ####### #####    ##',
  '    ##     ## ##   ##  ##       ##   ## ##       ##',
  '     #######  ##    ## ##       ##   ## ######## #######')) { Write-Host (C '38;5;179' $l) }
Say ("    " + (C '38;5;214' ([string]::Join('', $RUNES))) + "   " + (C '2' 'Liquid Intelligence. At your service.'))
Say ""
Say ("  " + (C '1;38;5;179' 'I N S T A L L  (Windows)') + "   " + (C '2' '- idempotent - nothing risky enabled - keeps your vault & secrets'))

# ── 1) dependencies (report, don't auto-install heavy things) ────────────────────────────────────────
Sect 'DEPENDENCIES' 'what the brain + local voice need'
function Have($bin) { $null -ne (Get-Command $bin -ErrorAction SilentlyContinue) }
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $v = (& node --version) -replace '^v', ''
  if ([int]($v.Split('.')[0]) -ge 20) { Ok "node $v" } else { Bad "node $v is too old - Urfael needs Node 20+ (https://nodejs.org)"; exit 1 }
} else { Bad 'node MISSING - install Node 20+ first: https://nodejs.org'; exit 1 }
if (Have 'git') { Ok 'git' } else { Bad 'git MISSING - install Git for Windows: https://git-scm.com'; exit 1 }
# claude: the same shapes app/claude-bin.js resolves (native .exe, npm cli.js, PATH)
$claudeExe = Join-Path $HOME '.local\bin\claude.exe'
$claudeNpm = Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\cli.js'
if ((Test-Path $claudeExe) -or (Test-Path $claudeNpm) -or (Have 'claude')) { Ok 'claude CLI' }
else { Warn 'claude MISSING - install Claude Code first (https://claude.com/claude-code), then run `claude` once to sign in' }
if (Have 'ffmpeg') { Ok 'ffmpeg' } else { Warn 'ffmpeg missing - `winget install Gyan.FFmpeg` (local voice needs it)' }
Ok 'SAPI TTS (Windows built-in)'
if (Have 'python') { Ok 'python' } else { Warn 'python missing - optional, for charts (matplotlib)' }

# ── 2) config dir + local speech model (checksum-pinned) + whisper-server.exe ───────────────────────
Sect 'VOICE & CONFIG' 'local speech model + whisper-server (both checksum-pinned) + secret templates'
New-Item -ItemType Directory -Force -Path $JDIR, (Join-Path $JDIR 'models'), $UBIN | Out-Null
$model = Join-Path $JDIR 'models\ggml-base.en.bin'
$MODEL_SHA = 'A03779C86DF3323075F5E796CB2CE5029F00EC8869EEE3FDFB897AFE36C6D002'
if (Test-Path $model) { Ok 'whisper model present' }
else {
  Warn 'downloading whisper base.en model (~142MB, one time)...'
  try {
    Invoke-WebRequest -UseBasicParsing -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin' -OutFile $model
    if ((Get-FileHash $model -Algorithm SHA256).Hash -eq $MODEL_SHA) { Ok 'local STT model ready (checksum verified)' }
    else { Remove-Item $model -Force; Warn 'model checksum MISMATCH - deleted for safety. Re-run, or set STT_PROVIDER=elevenlabs' }
  } catch { Warn 'model download failed - re-run, or set STT_PROVIDER=elevenlabs' }
}
# whisper-server.exe: the official whisper.cpp Windows build, pinned by release tag AND SHA-256 (fail-closed,
# same discipline as the model above). Extracted into %LOCALAPPDATA%\Urfael\bin, which main.js probes.
$wserver = Join-Path $UBIN 'whisper-server.exe'
$WZIP_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip'
$WZIP_SHA = '7D8BE46ECD31828E1EB7A2ECDD0D6B314FEAFD82163038AB6092594B0A063539'
if (Test-Path $wserver) { Ok 'whisper-server present (local STT)' }
else {
  Warn 'downloading whisper.cpp v1.9.1 win64 build (one time)...'
  $wzip = Join-Path $env:TEMP 'urfael-whisper-bin-x64.zip'
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $WZIP_URL -OutFile $wzip
    if ((Get-FileHash $wzip -Algorithm SHA256).Hash -eq $WZIP_SHA) {
      $tmp = Join-Path $env:TEMP 'urfael-whisper-extract'
      if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
      Expand-Archive -Path $wzip -DestinationPath $tmp -Force
      Copy-Item (Join-Path $tmp 'Release\whisper-server.exe') $UBIN -Force
      Copy-Item (Join-Path $tmp 'Release\*.dll') $UBIN -Force
      Remove-Item $tmp -Recurse -Force
      Ok "whisper-server ready (checksum verified) -> $UBIN"
    } else { Warn 'whisper zip checksum MISMATCH - skipped for safety (voice STT will need a manual whisper-server on PATH)' }
  } catch { Warn 'whisper download failed - voice STT needs whisper-server.exe on PATH (re-run to retry)' }
  finally { if (Test-Path $wzip) { Remove-Item $wzip -Force } }
}
# secret templates (never overwrite an existing real file). NTFS under your profile already restricts these
# to you + SYSTEM + Administrators - the POSIX chmod 600 statement, made by the filesystem default here.
foreach ($f in 'tts.env', 'api-keys.env', 'bridge.env') {
  $dst = Join-Path $JDIR $f
  if (Test-Path $dst) { Ok "$f already exists (kept)" }
  else { Copy-Item (Join-Path $REPO "config\$f.example") $dst; Ok "wrote $dst (add your keys)" }
}

# ── 3) vault (never overwrite) ───────────────────────────────────────────────────────────────────────
Sect 'VAULT & MEMORY' 'your second brain (PARA + daily notes) + a private, git-versioned memory repo'
if (Test-Path $VAULT) { Ok "$VAULT already exists (kept - not overwritten)" }
else {
  Copy-Item -Recurse (Join-Path $REPO 'vault-template') $VAULT
  Remove-Item -Recurse -Force (Join-Path $VAULT 'memory') -ErrorAction SilentlyContinue   # memory lives in ~\Urfael-memory
  # Claude Code reads commands/hooks via .claude - a JUNCTION needs no admin rights (a symlink would)
  $dotClaude = Join-Path $VAULT '.claude'
  if (-not (Test-Path $dotClaude)) { New-Item -ItemType Junction -Path $dotClaude -Target (Join-Path $VAULT '_urfael') | Out-Null }
  Ok "scaffolded $VAULT  (run ``urfael setup`` - it fills your details for you)"
}

# ── 4) private memory repo ───────────────────────────────────────────────────────────────────────────
if (Test-Path (Join-Path $MEM '.git')) { Ok "$MEM already exists" }
else {
  New-Item -ItemType Directory -Force -Path $MEM | Out-Null
  Copy-Item (Join-Path $REPO 'vault-template\memory\*.md') $MEM
  git -C $MEM init -q; git -C $MEM add -A; git -C $MEM commit -q -m 'init: Urfael memory' 2>$null | Out-Null
  Ok "created private local memory repo at $MEM"
}

# ── 5) record where the repo lives (vault scripts + goal-loop read this) ─────────────────────────────
Set-Content -NoNewline -Path (Join-Path $JDIR 'repo') -Value $REPO
Ok "repo path recorded ($REPO)"

# ── 6) app deps + the `urfael` terminal command ──────────────────────────────────────────────────────
Sect 'APP & CLI' 'node deps + the `urfael` terminal command'
if (Test-Path (Join-Path $REPO 'app\node_modules')) { Ok 'app deps installed' }
else { Push-Location (Join-Path $REPO 'app'); npm install --silent; Pop-Location; Ok 'npm install (app)' }
# a .cmd shim in %LOCALAPPDATA%\Urfael\bin + a one-time user-PATH append (no admin, no system PATH)
$shim = Join-Path $UBIN 'urfael.cmd'
Set-Content -Path $shim -Value ("@echo off`r`nnode `"$REPO\app\cli.js`" %*")
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$UBIN*") {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $UBIN), 'User')
  Ok "linked ``urfael`` CLI into $UBIN (added to your user PATH - open a NEW terminal to pick it up)"
} else { Ok "linked ``urfael`` CLI into $UBIN" }

# ── 7) background service helpers - written, NOT registered (you decide what runs) ───────────────────
Sect 'BACKGROUND SERVICES' 'autostart helpers - written, NOT registered (you decide what runs)'
$nodeExe = (Get-Command node).Source
# start-daemon.cmd: foreground, for a terminal. start-daemon-hidden.vbs: windowless, for the Run key.
Set-Content -Path (Join-Path $UBIN 'start-daemon.cmd') -Value ("@echo off`r`n`"$nodeExe`" `"$REPO\app\daemon.js`"")
Set-Content -Path (Join-Path $UBIN 'start-daemon-hidden.vbs') -Value ("CreateObject(`"WScript.Shell`").Run `"`"`"$nodeExe`"`" `"`"$REPO\app\daemon.js`"`"`", 0, False")
Ok "wrote start-daemon helpers to $UBIN (not registered)"

Write-Host ""
Write-Host ("  " + (C '38;5;214' $RUNES[5]) + "  " + (C '1;38;5;179' 'FIRST STEPS') + "   " + (C '2' 'you choose what runs - nothing was started for you'))
Say '1. Voice works out of the box - FREE & local (Windows SAPI + whisper.cpp), no API key needed.'
Say ("   Optional: edit `"$JDIR\tts.env`" for a higher-quality local voice (Kokoro) or an ElevenLabs key.")
Say '2. Optional, not needed to start: the brain already reads + writes ~\Urfael with its file tools.'
Say '3. urfael setup  auto-detects + fills your name / city / timezone / language into ~\Urfael\CLAUDE.md'
Say '4. Start the brain + UI (new terminal so PATH refreshes):'
Say ("      " + (C '38;5;109' 'urfael status') + "                          # starts the always-on brain on demand")
Say ("      " + (C '38;5;109' "cd `"$REPO\app`"; npm start") + "            # the overlay UI")
Say '   Autostart at login (optional, your call):'
Say ("      " + (C '38;5;109' ("reg add HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v UrfaelDaemon /t REG_SZ /d `"wscript.exe \`"$UBIN\start-daemon-hidden.vbs\`"`" /f")))
Say '5. WARNING: hands/eyes, the autonomous loop, and full permissions are OFF by default.'
Say '   Read SECURITY.md, then opt in deliberately.'
Say ''
Say ("  " + (C '38;5;214' ([char]0x25B8)) + " " + (C '1;38;5;179' 'Run  urfael setup') + "  " + (C '2' '- pick how Urfael reaches Claude (your subscription, an API key, or a local model).'))
Say ''
Say ("  " + (C '1;38;5;179' ([string]$RUNES[0] + '  Ready, sir.')) + "  " + (C '2' 'Talk to Urfael - run ') + (C '38;5;109' 'urfael "hello"') + (C '2' ' from any terminal.'))
