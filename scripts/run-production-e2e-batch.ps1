# Production 0→100 live E2E batch (admin HTTP)
# Usage:
#   .\scripts\run-production-e2e-batch.ps1 -Password '***'
#   .\scripts\run-production-e2e-batch.ps1 -BaseUrl 'https://erp.poshaktaranom.com' -User 'admin' -Password '***'
param(
  [string]$BaseUrl = $(if ($env:ERP_BASE_URL) { $env:ERP_BASE_URL } else { 'https://erp.poshaktaranom.com' }),
  [string]$User = $(if ($env:ERP_ADMIN_USER) { $env:ERP_ADMIN_USER } else { 'admin' }),
  [Parameter(Mandatory = $false)]
  [string]$Password = $env:ERP_ADMIN_PASSWORD,
  [int]$TimeoutMs = 90000
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if (-not $Password) {
  Write-Host 'Password required. Pass -Password or set ERP_ADMIN_PASSWORD.' -ForegroundColor Red
  exit 2
}

# Local VPN proxy for Node (Windows) — optional
try {
  $proxy = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue).ProxyServer
  if ($proxy -match ':(\d+)$') {
    $env:HTTP_PROXY = "http://127.0.0.1:$($Matches[1])"
    $env:HTTPS_PROXY = $env:HTTP_PROXY
    Write-Host "Node proxy: $($env:HTTP_PROXY)"
  }
} catch {}

$env:ERP_BASE_URL = $BaseUrl.TrimEnd('/')
$env:ERP_ADMIN_USER = $User
$env:ERP_ADMIN_PASSWORD = $Password
$env:ERP_E2E_TIMEOUT_MS = "$TimeoutMs"

Write-Host "Running production E2E against $($env:ERP_BASE_URL) as $($env:ERP_ADMIN_USER) ..." -ForegroundColor Cyan
Set-Location (Join-Path $Root 'server')
node scripts/test-production-e2e-live-batch.js
$code = $LASTEXITCODE

# Do not leave password in process env for interactive shells longer than needed
Remove-Item Env:ERP_ADMIN_PASSWORD -ErrorAction SilentlyContinue
exit $code
