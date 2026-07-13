# Validate CRM Taranom Android APK before upload (prevents dead/crash builds).
# Usage: powershell -ExecutionPolicy Bypass -File scripts/test-android-apk.ps1 [path-to-apk]
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$apk = if ($args[0]) { $args[0] } else { Join-Path $Root 'server\public\releases\crm-taranom.apk' }

if (-not (Test-Path $apk)) { throw "APK not found: $apk" }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $apk))
$fail = 0
function Assert($cond, $msg) {
  if (-not $cond) { Write-Host "FAIL: $msg"; $script:fail++ } else { Write-Host "OK: $msg" }
}
function Test-Elf($entry) {
  $s = $entry.Open(); $b = New-Object byte[] 4; [void]$s.Read($b, 0, 4); $s.Close()
  return ($b[0] -eq 0x7F -and $b[1] -eq 0x45 -and $b[2] -eq 0x4C -and $b[3] -eq 0x46)
}

$size = (Get-Item $apk).Length
$hash = (Get-FileHash $apk -Algorithm SHA256).Hash
Write-Host "APK: $apk"
Write-Host "Size: $([math]::Round($size/1MB, 1)) MB"
Write-Host "SHA256: $hash"

# 1) No nested APK (recursive packaging caused OOM crash on first launch)
$nested = @($zip.Entries | Where-Object { $_.FullName -match '\.apk$' })
Assert ($nested.Count -eq 0) "no nested .apk inside assets ($($nested.Count) found)"

# 2) libnode per ABI
foreach ($abi in 'arm64-v8a', 'armeabi-v7a', 'x86_64') {
  $e = $zip.Entries | Where-Object { $_.FullName -eq "lib/$abi/libnode.so" }
  Assert ($e) "lib/$abi/libnode.so present"
  if ($e) { Assert (Test-Elf $e) "lib/$abi/libnode.so is ELF" }
}

# 3) better_sqlite3 prebuilt per ABI
foreach ($abi in 'arm64-v8a', 'armeabi-v7a', 'x86_64') {
  $p = "assets/nodejs-project/node_modules/better-sqlite3/prebuilt/android/$abi/better_sqlite3.node"
  $e = $zip.Entries | Where-Object { $_.FullName -eq $p }
  Assert ($e) $p
  if ($e) { Assert (Test-Elf $e) "$abi better_sqlite3.node is ELF" }
}

# 4) main.js boot fix
$main = $zip.Entries | Where-Object { $_.FullName -eq 'assets/nodejs-project/main.js' }
Assert ($main) 'assets/nodejs-project/main.js present'
if ($main) {
  $sr = New-Object IO.StreamReader($main.Open())
  $txt = $sr.ReadToEnd(); $sr.Close()
  Assert ($txt -match 'ensureBetterSqlite3Native') 'main.js has sqlite path fix'
  Assert ($txt -match "APP_VERSION = '2.0.7'") 'main.js version 2.0.7'
}

# 5) Size sanity (nested APK builds were ~340MB; healthy ~120-200MB)
Assert ($size -lt 250MB) "APK size under 250MB (got $([math]::Round($size/1MB))MB)"

$zip.Dispose()
if ($fail -gt 0) { throw "$fail assertion(s) failed" }
Write-Host ''
Write-Host "ALL CHECKS PASSED ($fail failures)"
