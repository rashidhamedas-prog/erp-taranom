# Per-machine install of staged native package into Program Files.
# Run elevated if possible.
# Source: D:\proje\ERP EXE\native\TaranomNative
# Dest:   %ProgramFiles%\Taranom\ERP Native

$ErrorActionPreference = "Stop"
$Src = "D:\proje\ERP EXE\native\TaranomNative"
$Dest = Join-Path ${env:ProgramFiles} "Taranom\ERP Native"
$Data = Join-Path $env:ProgramData "Taranom\ERP"

if (-not (Test-Path $Src)) { throw "Stage not found: $Src — run build-native-desktop.ps1 first" }

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
New-Item -ItemType Directory -Force -Path $Data | Out-Null
Copy-Item "$Src\*" $Dest -Recurse -Force

$startMenu = Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs\Taranom"
New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $startMenu "ERP Taranom Native.lnk"))
$lnk.TargetPath = "powershell.exe"
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Dest\start-native-desktop.ps1`""
$lnk.WorkingDirectory = $Dest
$lnk.Save()

Write-Host "Installed to $Dest"
Write-Host "Data directory $Data"
Write-Host "Start Menu shortcut created."
