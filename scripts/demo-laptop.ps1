# Offline DEMO on a Windows laptop - the FULL app (central mode, every module
# visible including settings/users) with rich seeded sample data. No internet
# needed while presenting. Requires Node.js installed.
#
#   powershell -ExecutionPolicy Bypass -File scripts\demo-laptop.ps1
#
# Add -Reseed to wipe and rebuild the demo data. Login: demo / demo1234
# (keep this file pure ASCII - Windows PowerShell 5.1 breaks on multi-byte chars)
param([int]$Port = 3002, [switch]$Reseed)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$DemoDir = Join-Path $Root 'demo-data'
$Db = Join-Path $DemoDir 'demo.db'

if ($Reseed -and (Test-Path $Db)) { Remove-Item "$Db*" -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $DemoDir | Out-Null

Push-Location (Join-Path $Root 'server')
try {
  if (-not (Test-Path 'node_modules')) {
    npm install --omit=dev
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
  }
  if (-not (Test-Path $Db)) {
    Write-Host '==> seeding demo data (2-4 minutes, one time)...'
    node scripts/seed-demo.js $Db 4499
    if ($LASTEXITCODE -ne 0) { throw 'seed failed' }
  }

  $env:DB_PATH = $Db
  $env:UPLOADS_DIR = Join-Path $DemoDir 'uploads'
  $env:PORT = "$Port"
  $env:JWT_SECRET = 'laptop-demo-secret'

  $node = Start-Process node -ArgumentList 'server.js' -PassThru -WindowStyle Minimized
  for ($i = 0; $i -lt 30; $i++) {
    try { $r = Invoke-WebRequest "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { break } }
    catch { Start-Sleep -Seconds 1 }
  }
  Start-Process "http://127.0.0.1:$Port/"
  Write-Host ""
  Write-Host "DEMO running at http://127.0.0.1:$Port/  (login: demo / demo1234)"
  Write-Host "Server PID $($node.Id) - close its window (or Stop-Process) to stop."
} finally { Pop-Location }
