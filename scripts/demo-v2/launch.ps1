# Interactive demo launcher (Windows).
# Loads <demo-root>\secrets\demo.env via launch.js.
# Binds LISTEN_HOST=127.0.0.1 by default.
#
# Staging over a network must sit behind HTTPS (reverse proxy / TLS terminator).
# Do not put a public IP in this script.
#
# Never uses pm2 --update-env, pm2 save, or pm2 delete erp-taranom.
#
#   powershell -ExecutionPolicy Bypass -File scripts\demo-v2\launch.ps1 [absolute-demo-root]
param(
  [string]$DemoRoot = $env:ERP_DEMO_ROOT,
  [switch]$Pm2
)
$ErrorActionPreference = 'Stop'
$Repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
if (-not $DemoRoot) {
  Write-Error 'Pass an absolute demo root or set ERP_DEMO_ROOT'
}
$launch = Join-Path $Repo 'scripts\demo-v2\launch.js'
$argsList = @($launch, $DemoRoot)
if ($Pm2) { $argsList += '--pm2' }
& node @argsList
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
