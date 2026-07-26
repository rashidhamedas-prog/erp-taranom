# Finalize Android release APK after better-sqlite3 cross-compile.
# APK stays on the dev machine — NEVER upload to production server.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Report = Join-Path $Root 'android-build-report.txt'

Write-Host '==> Building APK (local only — no server upload)...'
& (Join-Path $Root 'scripts\build-android.ps1')

$apk = Join-Path $Root 'server\public\releases\erp-taranom.apk'
if (-not (Test-Path $apk)) { throw "APK missing: $apk" }

$hash = (Get-FileHash $apk -Algorithm SHA256).Hash
$size = (Get-Item $apk).Length

Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead($apk)
$elf = @{}
foreach ($abi in @('arm64-v8a','armeabi-v7a','x86_64')) {
  $e = $z.Entries | Where-Object { $_.FullName -like "*prebuilt/android/$abi/better_sqlite3.node" } | Select-Object -First 1
  if ($e) {
    $s = $e.Open(); $buf = New-Object byte[] 4; $s.Read($buf,0,4)|Out-Null; $s.Close()
    $elf[$abi] = -join ($buf | ForEach-Object { '{0:X2}' -f $_ })
  } else { $elf[$abi] = 'MISSING' }
}
$z.Dispose()

$lines = @(
  "BUILD=SUCCESS",
  "APK_SIZE=$size",
  "APK_SHA256=$hash",
  "ELF_arm64-v8a=$($elf['arm64-v8a'])",
  "ELF_armeabi-v7a=$($elf['armeabi-v7a'])",
  "ELF_x86_64=$($elf['x86_64'])"
)
$lines | Set-Content $Report -Encoding UTF8
$lines | ForEach-Object { Write-Host $_ }

foreach ($abi in $elf.Keys) {
  if ($elf[$abi] -ne '7F454C46') { throw "ELF check failed for $abi : $($elf[$abi])" }
}

Write-Host '==> Done. APK is local-only (sideload / USB):'
Write-Host "    $apk"
Write-Host '    Policy: do NOT scp APK to production — see docs/CHANGE-LOG.md'
