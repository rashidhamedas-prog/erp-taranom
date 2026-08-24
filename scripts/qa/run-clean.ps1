$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')
& node scripts\qa\run-clean.js @args
exit $LASTEXITCODE
