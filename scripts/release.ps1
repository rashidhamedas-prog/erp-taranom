# One-command full release for CRM Taranom (run on the Windows dev machine).
#
#   powershell -ExecutionPolicy Bypass -File scripts\release.ps1
#
# Steps (each one checks its exit code - a failed build can never be published):
#   1. git pull
#   2. build Windows installer (electron-builder NSIS)
#   3. build Android release APK (scripts/build-android.ps1)
#   4. verify the APK is bootable: libnode.so per ABI + better_sqlite3 .node are real ELF
#   5. regenerate manifest.json + latest.yml (scripts/generate-release.js)
#   6. commit+push the metadata
#   7. scp the .exe + .apk to the production server
#   8. ssh deploy: git pull + npm install + pm2 restart, then health-check
#
# NOTE: keep this file pure ASCII - Windows PowerShell 5.1 parses BOM-less
# files as ANSI and multi-byte characters (em-dash etc.) break the parser.
param(
  [string]$Version = '1.0.11',
  [string]$AndroidVersion = '2.0.8',
  [int]$AndroidCode = 10,
  [switch]$SkipDesktop,
  [switch]$SkipAndroid,
  [switch]$SkipDeploy,
  [string]$SshKey = "$env:USERPROFILE\.ssh\taranom_server",
  [string]$Server = 'taranom-admin@45.90.98.99',
  [int]$SshPort = 2299
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root
$Branch = 'claude/claude-md-docs-2ssrpy'

Write-Host "==> CRM Taranom release $Version (android $AndroidVersion/$AndroidCode)"

# --- 0) fresh code ---
git pull origin $Branch
if ($LASTEXITCODE -ne 0) { throw 'git pull failed - resolve conflicts first' }

# --- 1) Desktop installer ---
$exeDash = Join-Path $Root "desktop\dist\CRM-Taranom-Setup-$Version.exe"
if (-not $SkipDesktop) {
  Push-Location (Join-Path $Root 'desktop')
  npm install;      if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'desktop npm install failed' }
  npm run dist:win; if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'desktop build failed' }
  Pop-Location
  $exeSpace = Join-Path $Root "desktop\dist\CRM Taranom Setup $Version.exe"
  if (Test-Path $exeSpace) { Move-Item $exeSpace $exeDash -Force }
  if (-not (Test-Path $exeDash)) { throw "installer for $Version not found in desktop\dist" }
  Write-Host "==> installer OK: $exeDash ($([math]::Round((Get-Item $exeDash).Length/1MB)) MB)"
}

# --- 2) Android APK ---
$apk = Join-Path $Root 'server\public\releases\crm-taranom.apk'
if (-not $SkipAndroid) {
  powershell -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\build-android.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'android build failed' }
  if (-not (Test-Path $apk)) { throw 'crm-taranom.apk not produced' }

  # --- 3) APK bootability check (a dead APK was shipped once - never again) ---
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($apk)
  try {
    function Test-Elf($entry) {
      $s = $entry.Open(); $b = New-Object byte[] 4; [void]$s.Read($b, 0, 4); $s.Close()
      return ($b[0] -eq 0x7F -and $b[1] -eq 0x45 -and $b[2] -eq 0x4C -and $b[3] -eq 0x46)
    }
    foreach ($abi in 'arm64-v8a', 'armeabi-v7a', 'x86_64') {
      $e = $zip.Entries | Where-Object { $_.FullName -eq "lib/$abi/libnode.so" }
      if (-not $e) { throw "lib/$abi/libnode.so missing from APK - app cannot boot" }
      if (-not (Test-Elf $e)) { throw "lib/$abi/libnode.so is not a real ELF binary" }
    }
    $sq = $zip.Entries | Where-Object { $_.FullName -match 'better.?sqlite3' -and $_.FullName -match '\.node$' }
    if (-not $sq) { throw 'better_sqlite3 .node missing from APK - DB cannot open, app will hang on boot' }
    foreach ($e in $sq) { if (-not (Test-Elf $e)) { throw "$($e.FullName) is not a real ELF binary" } }
    $prebuilt = @($sq | Where-Object { $_.FullName -match 'prebuilt/android/(arm64-v8a|armeabi-v7a|x86_64)/better_sqlite3\.node$' })
    if ($prebuilt.Count -lt 3) { throw 'prebuilt/android better_sqlite3.node missing for one or more ABIs' }
    $nested = @($zip.Entries | Where-Object { $_.FullName -match '\.apk$' })
    if ($nested.Count -gt 0) { throw "nested .apk inside release APK ($($nested.Count)) - will crash on boot" }
    if ((Get-Item $apk).Length -gt 250MB) { throw 'APK too large (>250MB) - likely nested packaging' }
    Write-Host "==> APK ELF check OK ($(@($sq).Count) better_sqlite3 module(s), 3 ABIs libnode)"
  } finally { $zip.Dispose() }
  Write-Host "    SHA256: $((Get-FileHash $apk -Algorithm SHA256).Hash)"
}

# --- 4) release metadata (manifest.json + latest.yml) ---
node (Join-Path $Root 'scripts\generate-release.js') (Join-Path $Root 'server\public\releases') $Version $AndroidVersion $AndroidCode
if ($LASTEXITCODE -ne 0) { throw 'generate-release failed' }

# --- 5) commit + push metadata ---
git add server/public/releases/manifest.json server/public/releases/latest.yml desktop/package.json android/app/build.gradle
git commit -m "release: desktop $Version / android $AndroidVersion (vc$AndroidCode)" 2>$null
git push origin $Branch
if ($LASTEXITCODE -ne 0) { throw 'git push failed' }

if ($SkipDeploy) { Write-Host '==> SkipDeploy: artifacts built, metadata pushed. Done.'; exit 0 }

# --- 6) upload artifacts to production ---
$dest = "${Server}:/home/taranom-admin/crm-taranom/server/public/releases/"
if (-not $SkipDesktop) {
  scp -P $SshPort -i $SshKey $exeDash $dest
  if ($LASTEXITCODE -ne 0) { throw 'scp installer failed' }
}
if (-not $SkipAndroid) {
  scp -P $SshPort -i $SshKey $apk $dest
  if ($LASTEXITCODE -ne 0) { throw 'scp apk failed' }
}

# --- 7) deploy web (pull + deps + restart) and health-check ---
# Release metadata on the server may have been hand-edited in the past and
# would block the pull; git is the source of truth for those two files, so
# drop the local copies first (never touches code or data).
ssh -p $SshPort -i $SshKey $Server "cd /home/taranom-admin/crm-taranom && git checkout -- server/public/releases/manifest.json server/public/releases/latest.yml 2>/dev/null; git pull origin $Branch && cd server && npm install --omit=dev && pm2 restart crm-taranom && sleep 3 && curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:3000/"
if ($LASTEXITCODE -ne 0) { throw 'remote deploy failed - check server manually' }

Write-Host ''
Write-Host "[OK] release $Version complete: web deployed, installer + APK live on /releases/"
Write-Host "   desktop: http://45.90.98.99/releases/CRM-Taranom-Setup-$Version.exe"
Write-Host "   android: http://45.90.98.99/releases/crm-taranom.apk"
