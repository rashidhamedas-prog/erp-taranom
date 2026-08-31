$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')
$env:NODE_ENV = 'test'
& node scripts\qa\run-admin-qa.js @args
exit $LASTEXITCODE
