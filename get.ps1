# get.ps1 — one-line Urfael bootstrap for native Windows (the twin of get.sh):
#   irm https://raw.githubusercontent.com/Grandillionaire/urfael/main/get.ps1 | iex
# Clones the repo to ~\urfael-src (or updates an existing official clone) and runs install.ps1.
$ErrorActionPreference = 'Stop'
function Need($bin, $hint) {
  if (-not (Get-Command $bin -ErrorAction SilentlyContinue)) { Write-Host "x $bin is required first - $hint"; exit 1 }
}
Need git  'install Git for Windows: https://git-scm.com'
Need node 'install Node 20+: https://nodejs.org'

$dest = Join-Path $HOME 'urfael-src'
if (Test-Path (Join-Path $dest '.git')) {
  $origin = git -C $dest remote get-url origin 2>$null
  if ($origin -notmatch 'Grandillionaire/urfael') { Write-Host "x $dest exists but is not the official Urfael repo - move it aside and re-run."; exit 1 }
  Write-Host "> updating existing clone at $dest"
  git -C $dest pull --ff-only origin main
} elseif (Test-Path $dest) {
  Write-Host "x $dest exists and is not a git clone - move it aside and re-run."; exit 1
} else {
  Write-Host "> cloning Urfael to $dest"
  git clone --depth 1 https://github.com/Grandillionaire/urfael.git $dest
}
powershell -ExecutionPolicy Bypass -File (Join-Path $dest 'install.ps1')
