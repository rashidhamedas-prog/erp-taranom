#!/usr/bin/env bash
# One-shot remote build: download NDK + nodejs-mobile headers, cross-compile better-sqlite3.
set -euo pipefail
WORKDIR="${WORKDIR:-$HOME/android-native-build}"
NP="$WORKDIR/nodejs-project"
NODEDIR="$WORKDIR/libnode"
NDK="$WORKDIR/ndk"
NDK_VERSION="25.1.8937393"
NODEJS_MOBILE_VER="18.20.4"
API=24

mkdir -p "$WORKDIR"
cd "$WORKDIR"

if [[ ! -f "$NODEDIR/include/node/node_version.h" ]]; then
  echo "==> Download nodejs-mobile headers"
  NMZIP="nodejs-mobile-v${NODEJS_MOBILE_VER}-android.zip"
  if [[ ! -f "$NMZIP" ]]; then
    curl -fsSL -o "$NMZIP" \
      "https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v${NODEJS_MOBILE_VER}/${NMZIP}"
  fi
  rm -rf nm-extract libnode
  unzip -q "$NMZIP" -d nm-extract
  mkdir -p libnode
  cp -a nm-extract/include libnode/
  cp -a nm-extract/bin libnode/ 2>/dev/null || true
fi

if [[ ! -d "$NDK/toolchains/llvm/prebuilt/linux-x86_64" ]]; then
  echo "==> Download Android NDK (this may take a few minutes)"
  NDKZIP="android-ndk-r25b-linux.zip"
  if [[ ! -f "$NDKZIP" ]]; then
    curl -fsSL -o "$NDKZIP" \
      "https://dl.google.com/android/repository/android-ndk-r25b-linux.zip"
  fi
  rm -rf ndk
  unzip -q "$NDKZIP"
  mv android-ndk-r25b ndk
fi

TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"

if [[ ! -d "$NP/node_modules/better-sqlite3" ]]; then
  echo "==> npm install (ignore host native build scripts)"
  mkdir -p "$NP"
  cp package.json package-lock.json "$NP/" 2>/dev/null || cp package.json "$NP/"
  ( cd "$NP" && npm install --omit=dev --ignore-scripts )
fi

OUT_BASE="$NP/node_modules/better-sqlite3/prebuilt/android"
mkdir -p "$OUT_BASE"

build_one() {
  local abi="$1" npm_arch="$2" target="$3"
  echo ""
  echo "==> better-sqlite3: $abi"
  export ANDROID_NDK_HOME="$NDK"
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

  rm -rf "$NP/node_modules/better-sqlite3/build"
  ( cd "$NP/node_modules/better-sqlite3" && npx --yes node-gyp@10.2.0 rebuild --release --arch="$npm_arch" )

  mkdir -p "$OUT_BASE/$abi"
  cp "$NP/node_modules/better-sqlite3/build/Release/better_sqlite3.node" "$OUT_BASE/$abi/"
  file "$OUT_BASE/$abi/better_sqlite3.node"
  ls -lh "$OUT_BASE/$abi/better_sqlite3.node"
}

build_one arm64-v8a   arm64 aarch64-linux-android
build_one armeabi-v7a arm   armv7a-linux-androideabi
build_one x86_64      x64   x86_64-linux-android

mkdir -p "$NP/node_modules/better-sqlite3/build/Release"
cp "$OUT_BASE/arm64-v8a/better_sqlite3.node" "$NP/node_modules/better-sqlite3/build/Release/"

echo ""
echo "==> SUCCESS — prebuilt modules:"
find "$OUT_BASE" -name '*.node' -exec file {} \;
