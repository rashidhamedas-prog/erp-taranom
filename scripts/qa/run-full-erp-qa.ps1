$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')
$env:NODE_ENV = 'test'
& node scripts\qa\run-full-erp-qa.js @args
exit $LASTEXITCODE
