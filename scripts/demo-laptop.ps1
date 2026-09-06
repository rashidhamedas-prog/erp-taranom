# DEPRECATED - fail-closed.
# The old body used wildcard deletes, a hardcoded JWT, and printed
# well-known passwords. Do not restore that behavior.
# (ASCII only - Windows PowerShell 5.1)
param()
$ErrorActionPreference = 'Stop'
Write-Host 'REFUSED: scripts/demo-laptop.ps1 is retired.'
Write-Host 'Use the isolated V2 demo tooling instead:'
Write-Host '  docs/runbooks/DEMO-V2-SECURE-SALES.md'
Write-Host '  node scripts/demo-v2/provision.js <absolute-demo-root>'
Write-Host '  node server/scripts/seed-demo.js <absolute-db-path>'
Write-Host '  node scripts/demo-v2/launch.js <absolute-demo-root>'
Write-Host '  powershell -File scripts/demo-v2/launch.ps1 <absolute-demo-root>'
Write-Host '  node scripts/demo-v2/reset.js <absolute-demo-root>'
exit 2
