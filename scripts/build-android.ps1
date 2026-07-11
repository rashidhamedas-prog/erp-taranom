# Build CRM Taranom Android release APK (Windows).
# Prerequisites: Android SDK (sdkmanager), JDK 17, nodejs-mobile.aar in app/libs/
# Usage: powershell -ExecutionPolicy Bypass -File scripts/build-android.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Android = Join-Path $Root 'android'
$Sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$env:ANDROID_HOME = $Sdk

Write-Host "==> CRM Taranom Android build"
Write-Host "    Root: $Root"
Write-Host "    SDK:  $Sdk"

# --- JDK 17 ---
$java = Get-Command java -ErrorAction SilentlyContinue
if (-not $java) {
  $candidates = @(
    'C:\Program Files\Microsoft\jdk-17*\bin\java.exe',
    'C:\Program Files\Eclipse Adoptium\jdk-17*\bin\java.exe',
    'C:\Program Files\Android\Android Studio\jbr\bin\java.exe'
  )
  foreach ($pat in $candidates) {
    $found = Get-Item $pat -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $env:JAVA_HOME = $found.Directory.Parent.FullName; $env:Path = "$($found.Directory.FullName);$env:Path"; break }
  }
}
if (-not (Get-Command java -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing Microsoft OpenJDK 17...'
  winget install Microsoft.OpenJDK.17 --accept-package-agreements --accept-source-agreements
  $jdk = Get-Item 'C:\Program Files\Microsoft\jdk-17*\bin\java.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($jdk) { $env:JAVA_HOME = $jdk.Directory.Parent.FullName; $env:Path = "$($jdk.Directory.FullName);$env:Path" }
}
java -version

# --- SDK packages ---
$sdkmanager = Join-Path $Sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path $sdkmanager)) {
  $sdkmanager = Get-ChildItem (Join-Path $Sdk 'cmdline-tools') -Recurse -Filter 'sdkmanager.bat' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
}
if ($sdkmanager) {
  Write-Host '==> Installing SDK platform 36, build-tools, NDK, CMake...'
  & $sdkmanager --sdk_root=$Sdk 'platforms;android-36' 'build-tools;36.0.0' 'ndk;25.2.9519653' 'cmake;3.22.1' | Out-Host
  yes | & $sdkmanager --sdk_root=$Sdk --licenses 2>$null
}

# --- nodejs-mobile libnode (zip has bin/ + include/, not an AAR) ---
$libnodeDir = Join-Path $Android 'app\libnode'
$libnodeSo = Join-Path $libnodeDir 'bin\arm64-v8a\libnode.so'
if (-not (Test-Path $libnodeSo)) {
  $zipUrl = 'https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip'
  $zipPath = Join-Path $env:TEMP 'nodejs-mobile-v18.20.4-android.zip'
  if (-not (Test-Path $zipPath)) {
    Write-Host "==> Downloading nodejs-mobile..."
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
  }
  $extract = Join-Path $env:TEMP 'nm-android-full'
  if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
  Expand-Archive -Path $zipPath -DestinationPath $extract -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $libnodeDir 'bin') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $libnodeDir 'include') | Out-Null
  Copy-Item (Join-Path $extract 'bin\*') (Join-Path $libnodeDir 'bin') -Recurse -Force
  Copy-Item (Join-Path $extract 'include\*') (Join-Path $libnodeDir 'include') -Recurse -Force
  Write-Host "==> libnode copied to $libnodeDir"
}

# --- nodejs-project JS dependencies (pure-JS modules; better-sqlite3 needs NDK rebuild) ---
$npDir = Join-Path $Android 'app\src\main\assets\nodejs-project'
$bsPrebuilt = Join-Path $npDir 'node_modules\better-sqlite3\prebuilt\android\arm64-v8a\better_sqlite3.node'
if (-not (Test-Path $bsPrebuilt)) {
  Write-Host '==> better-sqlite3 Android native modules missing - cross-compiling...'
  & (Join-Path $Root 'scripts\build-better-sqlite3-android.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'build-better-sqlite3-android.ps1 failed' }
}
if (-not (Test-Path (Join-Path $npDir 'node_modules\express'))) {
  Write-Host '==> npm install (nodejs-project assets)...'
  Push-Location $npDir
  npm install --omit=dev
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'npm install failed' }
  Pop-Location
}

# --- strip pre-gzipped dist files: AAPT drops the .gz extension when merging
# assets, so foo.min.js + foo.min.js.gz collide as "Duplicate resources"
# (bcryptjs ships one). The runtime never reads .gz dists - safe to delete. ---
Get-ChildItem -Path $npDir -Recurse -Filter '*.gz' -File -ErrorAction SilentlyContinue | Remove-Item -Force
Get-ChildItem -Path $npDir -Recurse -Filter '*.br' -File -ErrorAction SilentlyContinue | Remove-Item -Force

# --- local.properties (UTF8 *without* BOM - java.util.Properties cannot read a BOM'd key) ---
$localProps = Join-Path $Android 'local.properties'
[IO.File]::WriteAllText($localProps, "sdk.dir=$($Sdk -replace '\\','/')`n")

# --- Gradle wrapper ---
Set-Location $Android
if (-not (Test-Path 'gradlew.bat')) {
  Write-Host '==> Generating Gradle wrapper...'
  $gradle = Get-Command gradle -ErrorAction SilentlyContinue
  if (-not $gradle) {
    $gw = Join-Path $env:TEMP 'gradle-8.4-bin.zip'
    if (-not (Test-Path $gw)) { Invoke-WebRequest 'https://services.gradle.org/distributions/gradle-8.4-bin.zip' -OutFile $gw }
    $gd = Join-Path $env:TEMP 'gradle-8.4'
    if (-not (Test-Path $gd)) { Expand-Archive $gw $gd -Force }
    $gradleBin = Join-Path $gd 'gradle-8.4\bin\gradle.bat'
    & $gradleBin wrapper --gradle-version 8.4
  } else {
    & gradle wrapper --gradle-version 8.4
  }
}

# Remove stale artifacts so a failed build can never be reported as success
$apk = Join-Path $Android 'app\build\outputs\apk\release\app-release.apk'
if (Test-Path $apk) { Remove-Item $apk -Force }

Write-Host '==> assembleRelease (this may take several minutes)...'
& .\gradlew.bat assembleRelease --no-daemon --rerun-tasks
if ($LASTEXITCODE -ne 0) { throw "gradlew assembleRelease failed (exit $LASTEXITCODE)" }
if (-not (Test-Path $apk)) { throw "APK not found at $apk" }

$dest = Join-Path $Root 'server\public\releases\crm-taranom.apk'
Copy-Item $apk $dest -Force
Write-Host "==> APK ready: $dest"
Write-Host "    Size: $([math]::Round((Get-Item $dest).Length/1MB, 1)) MB"
