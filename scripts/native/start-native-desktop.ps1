# Start Domain Host + WPF shell (dev / staged package).
# From repo root OR from staged TaranomNative folder.

$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Detect staged vs repo
if (Test-Path (Join-Path $Here "DomainHost\host-main.js")) {
  $Stage = $Here
  $RepoRoot = $null
  if (Test-Path (Join-Path $Stage "SERVER_ROOT.txt")) {
    $RepoRoot = (Get-Content (Join-Path $Stage "SERVER_ROOT.txt") -Raw).Trim()
    $RepoRoot = Split-Path -Parent $RepoRoot
  }
} else {
  $RepoRoot = Resolve-Path (Join-Path $Here "..\..")
  $Stage = $null
}

$node20 = Join-Path $RepoRoot ".tools\node20\node-v20.18.1-win-x64\node.exe"
if (-not (Test-Path $node20)) { $node20 = "node" }

$hostDir = if ($Stage) { Join-Path $Stage "DomainHost" } else { Join-Path $RepoRoot "win-native\DomainHost" }
$appExe = if ($Stage) {
  Get-ChildItem (Join-Path $Stage "app") -Filter "Taranom.App.exe" -Recurse | Select-Object -First 1 -ExpandProperty FullName
} else {
  $null
}

$dataDir = Join-Path $env:ProgramData "Taranom\ERP"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$env:ERP_HOST_DATA = $dataDir
$env:ERP_BRAND_ID = "taranom"
$env:ERP_HOST_AUTOSTART = "1"
$env:ERP_HOST_SYNC_ROLE = "central"
$env:ERP_HOST_PIPE = "\\.\pipe\erp-taranom-domain"
$env:ERP_HOST_PIPE_NAME = "erp-taranom-domain"
$env:NO_PROXY = "127.0.0.1,localhost"

# Prefer staged portable .NET runtime next to package
$portableRt = $null
if ($Stage -and (Test-Path (Join-Path $Stage "dotnet-runtime\dotnet.exe"))) {
  $portableRt = Join-Path $Stage "dotnet-runtime"
} elseif ($RepoRoot -and (Test-Path (Join-Path $RepoRoot ".tools\dotnet8\dotnet.exe"))) {
  $portableRt = Join-Path $RepoRoot ".tools\dotnet8"
}
if ($portableRt) {
  $env:DOTNET_ROOT = $portableRt
  $env:PATH = "$portableRt;$env:PATH"
  Write-Host "DOTNET_ROOT=$portableRt"
}

Write-Host "Starting Domain Host..."
$hostProc = Start-Process -FilePath $node20 -ArgumentList "host-main.js" -WorkingDirectory $hostDir -PassThru -WindowStyle Minimized
Start-Sleep -Seconds 3

if ($appExe -and (Test-Path $appExe)) {
  Write-Host "Starting WPF $appExe"
  Start-Process -FilePath $appExe -WorkingDirectory (Split-Path $appExe)
} else {
  Write-Host "WPF not published yet. Build with build-native-desktop.ps1 or:"
  Write-Host "  dotnet run --project win-native/Taranom.App"
  if ($RepoRoot) {
    $dotnet = Get-ChildItem (Join-Path $RepoRoot ".tools\dotnet8") -Filter dotnet.exe -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1 -ExpandProperty FullName
    if ($dotnet) {
      Start-Process -FilePath $dotnet -ArgumentList @("run","--project",(Join-Path $RepoRoot "win-native\Taranom.App\Taranom.App.csproj")) -WorkingDirectory $RepoRoot
    }
  }
}

Write-Host "Host PID=$($hostProc.Id)  data=$dataDir  pipe=erp-taranom-domain"
