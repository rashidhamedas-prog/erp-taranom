# Cross-compile better-sqlite3 for nodejs-mobile Android (Windows + NDK make).
# Output: node_modules/better-sqlite3/prebuilt/android/<abi>/better_sqlite3.node
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Np = Join-Path $Root 'android\app\src\main\assets\nodejs-project'
$Nodedir = Join-Path $Root 'android\app\libnode'
$Sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$NdkVer = if ($env:NDK_VERSION) { $env:NDK_VERSION } else { '25.1.8937393' }
$NdkHome = if ($env:ANDROID_NDK_HOME) { $env:ANDROID_NDK_HOME } else { Join-Path $Sdk "ndk\$NdkVer" }
if (-not (Test-Path $NdkHome)) {
  $found = Get-ChildItem (Join-Path $Sdk 'ndk') -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
  if ($found) { $NdkHome = $found.FullName }
}
$Toolchain = Join-Path $NdkHome 'toolchains\llvm\prebuilt\windows-x86_64\bin'
$Make = Join-Path $Toolchain 'make.exe'
$Api = 24

if (-not (Test-Path $Make)) { throw "NDK make not found: $Make" }
if (-not (Test-Path (Join-Path $Nodedir 'include\node\node_version.h'))) {
  throw 'nodejs-mobile headers missing - run build-android.ps1 libnode step first'
}

Push-Location $Np
if (-not (Test-Path 'node_modules\better-sqlite3')) {
  Write-Host '==> npm install --omit=dev'
  npm install --omit=dev
  if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
}

$OutBase = 'node_modules\better-sqlite3\prebuilt\android'
New-Item -ItemType Directory -Force -Path $OutBase | Out-Null

function Build-Abi($Abi, $NpmArch, $Target) {
  Write-Host ""
  Write-Host "==> better-sqlite3: $Abi ($Target)"
  $env:ANDROID_NDK_HOME = $NdkHome
  $env:npm_config_nodedir = $Nodedir
  $env:npm_config_arch = $NpmArch
  $env:npm_config_platform = 'android'
  $env:npm_config_build_from_source = 'true'
  $env:CC = Join-Path $Toolchain "${Target}${Api}-clang.cmd"
  $env:CXX = Join-Path $Toolchain "${Target}${Api}-clang++.cmd"
  $env:AR = Join-Path $Toolchain 'llvm-ar.exe'
  $env:LINK = $env:CXX
  $env:CFLAGS = '-fPIC -O2'
  $env:CXXFLAGS = '-fPIC -O2'
  $env:LDFLAGS = '-shared'
  $env:MAKE = $Make
  $env:Path = "$Toolchain;$env:Path"

  $buildDir = Join-Path $Np 'node_modules\better-sqlite3\build'
  if (Test-Path $buildDir) { Remove-Item $buildDir -Recurse -Force }

  Push-Location (Join-Path $Np 'node_modules\better-sqlite3')
  npx --yes node-gyp@10.2.0 rebuild --release --arch=$NpmArch -f make
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "node-gyp failed for $Abi" }
  Pop-Location

  $dest = Join-Path $OutBase $Abi
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $outFile = Join-Path $dest 'better_sqlite3.node'
  Copy-Item (Join-Path $Np 'node_modules\better-sqlite3\build\Release\better_sqlite3.node') $outFile -Force
  $bytes = [System.IO.File]::ReadAllBytes($outFile)[0..3]
  $magic = -join ($bytes | ForEach-Object { '{0:X2}' -f $_ })
  Write-Host "    magic=$magic size=$((Get-Item $outFile).Length)"
  if ($magic -ne '7F454C46') { throw "Expected ELF for $Abi, got $magic" }
}

Build-Abi 'arm64-v8a'   'arm64' 'aarch64-linux-android'
Build-Abi 'armeabi-v7a' 'arm'   'armv7a-linux-androideabi'
Build-Abi 'x86_64'      'x64'   'x86_64-linux-android'

$rel = Join-Path $Np 'node_modules\better-sqlite3\build\Release'
New-Item -ItemType Directory -Force -Path $rel | Out-Null
Copy-Item (Join-Path $OutBase 'arm64-v8a\better_sqlite3.node') (Join-Path $rel 'better_sqlite3.node') -Force
Pop-Location
Write-Host '==> better-sqlite3 Android native modules ready'
