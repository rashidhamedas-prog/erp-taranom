# Build and stage native Windows desktop package (WPF + Domain Host).
# Requires .NET 8 SDK (portable under .tools\dotnet8 or system install).
# Usage:
#   powershell -File scripts/native/build-native-desktop.ps1
# Output:
#   D:\proje\ERP EXE\native\TaranomNative\

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$OutRoot = "D:\proje\ERP EXE\native"
$Stage = Join-Path $OutRoot "TaranomNative"
$AppProj = Join-Path $Root "win-native\Taranom.App\Taranom.App.csproj"
$HostDir = Join-Path $Root "win-native\DomainHost"
$BrandDir = Join-Path $Root "branding\taranom"

function Find-DotNet {
  $candidates = @(
    (Join-Path $Root ".tools\dotnet8\dotnet.exe"),
    (Get-Command dotnet -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  $found = Get-ChildItem (Join-Path $Root ".tools\dotnet8") -Filter dotnet.exe -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
  if ($found) { return $found }
  throw "dotnet SDK not found. Install .NET 8 or place portable SDK in .tools\dotnet8"
}

$dotnet = Find-DotNet
Write-Host "Using $dotnet"

New-Item -ItemType Directory -Force -Path $Stage | Out-Null
$publishDir = Join-Path $Stage "app"
if (Test-Path $publishDir) { Remove-Item $publishDir -Recurse -Force }

# Framework-dependent publish (portable SDK often lacks NuGet runtime packs for --self-contained).
# We bundle Microsoft.NETCore.App + WindowsDesktop.App from the portable SDK next to the app.
& $dotnet publish $AppProj -c Release -o $publishDir --self-contained false
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }

$sdkRoot = Split-Path -Parent $dotnet
$runtimeOut = Join-Path $Stage "dotnet-runtime"
if (Test-Path $runtimeOut) { Remove-Item $runtimeOut -Recurse -Force }
New-Item -ItemType Directory -Force -Path $runtimeOut | Out-Null
foreach ($part in @("host", "shared")) {
  $src = Join-Path $sdkRoot $part
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $runtimeOut $part) -Recurse -Force
  }
}
# Minimal host: copy dotnet.exe + deps that exist beside SDK root
Copy-Item (Join-Path $sdkRoot "dotnet.exe") (Join-Path $runtimeOut "dotnet.exe") -Force
Get-ChildItem $sdkRoot -File -Filter "dotnet.*" | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $runtimeOut $_.Name) -Force
}

$hostOut = Join-Path $Stage "DomainHost"
New-Item -ItemType Directory -Force -Path $hostOut | Out-Null
Copy-Item (Join-Path $HostDir "*") $hostOut -Recurse -Force -Exclude @("node_modules")
$brandOut = Join-Path $Stage "branding\taranom"
New-Item -ItemType Directory -Force -Path $brandOut | Out-Null
Copy-Item (Join-Path $BrandDir "*") $brandOut -Recurse -Force

# Bundle a pointer to repo server/ for Host runtime (symlink-like copy instructions)
$serverPtr = Join-Path $Stage "SERVER_ROOT.txt"
Set-Content -Path $serverPtr -Value (Join-Path $Root "server") -Encoding UTF8

Copy-Item (Join-Path $Root "scripts\native\start-native-desktop.ps1") (Join-Path $Stage "start-native-desktop.ps1") -Force
Copy-Item (Join-Path $Root "scripts\native\start-native-desktop.cmd") (Join-Path $Stage "start-native-desktop.cmd") -Force
Copy-Item (Join-Path $Root "scripts\native\install-native-desktop.ps1") (Join-Path $Stage "install-native-desktop.ps1") -Force

$notes = @"
ERP Taranom Native Desktop (Phase 1 package)
1) Node 20 required for Domain Host (repo .tools\node20 or system).
2) Bundled portable .NET runtime under dotnet-runtime\ (DOTNET_ROOT set by start script).
3) Run start-native-desktop.ps1 (Host pipe + WPF).
4) Optional: install-native-desktop.ps1 for Program Files + ProgramData.
5) Full MSI/OV signing still open for GA; this is the stage package.
"@
Set-Content -Path (Join-Path $Stage "README.txt") -Value $notes -Encoding UTF8

Write-Host "OK staged at $Stage"
Get-ChildItem $Stage | Format-Table Name, Mode
