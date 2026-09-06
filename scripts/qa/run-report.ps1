$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')
& node scripts\qa\run-report.js @args
exit $LASTEXITCODE
