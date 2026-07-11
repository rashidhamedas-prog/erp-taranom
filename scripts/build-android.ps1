# Build CRM Taranom Android release APK (Windows).
# Prerequisites: Android SDK (sdkmanager), JDK 17, nodejs-mobile.aar in app/libs/
# Usage: powershell -ExecutionPolicy Bypass -File scripts/build-android.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Android = Join-Path $Root 'android'
$Sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }

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
  Write-Host '==> Installing SDK platform 34, build-tools, NDK, CMake...'
  & $sdkmanager --sdk_root=$Sdk 'platforms;android-34' 'build-tools;34.0.0' 'ndk;25.2.9519653' 'cmake;3.22.1' | Out-Host
  yes | & $sdkmanager --sdk_root=$Sdk --licenses 2>$null
}

# --- nodejs-mobile AAR ---
$libsDir = Join-Path $Android 'app\libs'
New-Item -ItemType Directory -Force -Path $libsDir | Out-Null
$aar = Join-Path $libsDir 'nodejs-mobile.aar'
if (-not (Test-Path $aar)) {
  $zipUrl = 'https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip'
  $zipPath = Join-Path $env:TEMP 'nodejs-mobile-v18.20.4-android.zip'
  if (-not (Test-Path $zipPath)) {
    Write-Host "==> Downloading nodejs-mobile..."
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath
  }
  $extract = Join-Path $env:TEMP 'nm-android-full'
  if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
  Expand-Archive -Path $zipPath -DestinationPath $extract -Force
  $foundAar = Get-ChildItem $extract -Recurse -Filter '*.aar' | Select-Object -First 1
  if (-not $foundAar) { throw 'nodejs-mobile.aar not found in zip' }
  Copy-Item $foundAar.FullName $aar -Force
  Write-Host "==> AAR copied to $aar"
}

# --- local.properties ---
$localProps = Join-Path $Android 'local.properties'
"sdk.dir=$($Sdk -replace '\\','\\')" | Set-Content $localProps -Encoding UTF8

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

Write-Host '==> assembleRelease (this may take several minutes)...'
& .\gradlew.bat assembleRelease --no-daemon
$apk = Join-Path $Android 'app\build\outputs\apk\release\app-release.apk'
if (-not (Test-Path $apk)) { throw "APK not found at $apk" }

$dest = Join-Path $Root 'server\public\releases\crm-taranom.apk'
Copy-Item $apk $dest -Force
Write-Host "==> APK ready: $dest"
Write-Host "    Size: $([math]::Round((Get-Item $dest).Length/1MB, 1)) MB"
