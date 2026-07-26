#!/usr/bin/env bash
# Cross-compile better-sqlite3 for nodejs-mobile Android (all shipped ABIs).
# Linux/macOS host. Output under node_modules/better-sqlite3/prebuilt/android/<abi>/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NP="$ROOT/android/app/src/main/assets/nodejs-project"
NODEDIR="$ROOT/android/app/libnode"
NDK_VERSION="${NDK_VERSION:-25.1.8937393}"
NDK_HOME="${ANDROID_NDK_HOME:-${ANDROID_NDK:-$HOME/Android/Sdk/ndk/$NDK_VERSION}}"

if [[ ! -d "$NDK_HOME/toolchains/llvm/prebuilt" ]]; then
  echo "ERROR: Android NDK not found at $NDK_HOME" >&2
  exit 1
fi
if [[ ! -f "$NODEDIR/include/node/node_version.h" ]]; then
  echo "ERROR: nodejs-mobile headers missing at $NODEDIR" >&2
  exit 1
fi

HOST="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$HOST" in
  linux)  PREBUILT=linux-x86_64 ;;
  darwin) PREBUILT=darwin-x86_64 ;;
  *)      echo "Unsupported host: $HOST" >&2; exit 1 ;;
esac
TOOLCHAIN="$NDK_HOME/toolchains/llvm/prebuilt/$PREBUILT/bin"
API=24

cd "$NP"
[[ -d node_modules/better-sqlite3 ]] || npm install --omit=dev

OUT_BASE="node_modules/better-sqlite3/prebuilt/android"
mkdir -p "$OUT_BASE"

build_one() {
  local abi="$1" npm_arch="$2" target="$3"
  echo ""
  echo "==> better-sqlite3: $abi"
  export ANDROID_NDK_HOME="$NDK_HOME"
  export npm_config_nodedir="$NODEDIR"
  export npm_config_arch="$npm_arch"
  export npm_config_platform="android"
  export npm_config_build_from_source="true"
  export CC="$TOOLCHAIN/${target}${API}-clang"
  export CXX="$TOOLCHAIN/${target}${API}-clang++"
  export AR="$TOOLCHAIN/llvm-ar"
  export LINK="$CXX"
  export CFLAGS="-fPIC -O2"
  export CXXFLAGS="-fPIC -O2"
  export LDFLAGS="-shared"
  export PATH="$TOOLCHAIN:$PATH"

  rm -rf node_modules/better-sqlite3/build
  ( cd node_modules/better-sqlite3 && npx --yes node-gyp@10.2.0 rebuild --release --arch="$npm_arch" )

  mkdir -p "$OUT_BASE/$abi"
  cp node_modules/better-sqlite3/build/Release/better_sqlite3.node "$OUT_BASE/$abi/"
  file "$OUT_BASE/$abi/better_sqlite3.node"
}

build_one arm64-v8a   arm64 aarch64-linux-android
build_one armeabi-v7a arm   armv7a-linux-androideabi
build_one x86_64      x64   x86_64-linux-android

mkdir -p node_modules/better-sqlite3/build/Release
cp "$OUT_BASE/arm64-v8a/better_sqlite3.node" node_modules/better-sqlite3/build/Release/better_sqlite3.node
echo "==> Done"
