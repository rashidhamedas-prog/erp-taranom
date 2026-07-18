#!/bin/bash
# Builds the complete delivery ZIP for CRM Taranom: source (server, desktop,
# android), docs and build scripts — everything needed to build, deploy and
# maintain the project. Excludes generated artifacts, dependencies and local
# data (node_modules, dist, databases, uploads).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/crm-taranom-release.zip}"

cd "$ROOT"
rm -f "$OUT"

zip -r -q "$OUT" \
  CLAUDE.md README.md docs scripts \
  server desktop android \
  -x "server/node_modules/*" \
  -x "server/*.db" -x "server/*.db-wal" -x "server/*.db-shm" \
  -x "server/backups/*" -x "server/public/uploads/*" -x "server/.env" \
  -x "desktop/node_modules/*" -x "desktop/dist/*" -x "desktop/server/*" \
  -x "android/.gradle/*" -x "android/build/*" -x "android/app/build/*" \
  -x "android/app/libs/*.aar" -x "android/app/libnode/*" -x "android/app/libnode-aar/*" \
  -x "android/app/src/main/assets/nodejs-project/server/*" \
  -x "android/app/src/main/assets/nodejs-project/node_modules/*" \
  -x "android/local.properties" -x "android/.idea/*"

echo "✅ $(du -h "$OUT" | cut -f1)  $OUT"
unzip -l "$OUT" | tail -1
