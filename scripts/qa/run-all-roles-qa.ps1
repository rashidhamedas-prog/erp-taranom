$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..\..')
$env:NODE_ENV = 'test'
& node scripts\qa\run-all-roles-qa.js @args
exit $LASTEXITCODE
