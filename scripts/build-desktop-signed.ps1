# Build signed Windows installer without printing secrets.
# Reads password from desktop/certs/csc-password.txt (gitignored) if present.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Desktop = Join-Path $Root 'desktop'
$Pfx = Join-Path $Desktop 'certs\taranom-codesign.pfx'
$PassFile = Join-Path $Desktop 'certs\csc-password.txt'

if (-not (Test-Path $Pfx)) { throw "PFX missing: $Pfx" }

$env:CSC_LINK = $Pfx
if (Test-Path $PassFile) {
  $env:CSC_KEY_PASSWORD = (Get-Content $PassFile -Raw).Trim()
} elseif (-not $env:CSC_KEY_PASSWORD) {
  throw 'Set CSC_KEY_PASSWORD or create desktop/certs/csc-password.txt'
}

Write-Host "==> Desktop dist:win (version from package.json)"
Set-Location $Desktop
if ($env:HTTP_PROXY) { Write-Host "proxy=$env:HTTP_PROXY" }
npm run dist:win
if ($LASTEXITCODE -ne 0) { throw "dist:win failed: $LASTEXITCODE" }
Write-Host '==> dist:win OK'
Get-ChildItem (Join-Path $Desktop 'dist') -Filter '*.exe' | Select-Object Name, Length, LastWriteTime
