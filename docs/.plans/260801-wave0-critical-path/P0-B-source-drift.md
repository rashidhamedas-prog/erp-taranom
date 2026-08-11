# Phase P0-B — Source drift (web / desktop / Android)

**Status:** `[x]`
**Roadmap:** فاز P0-B

## Objective

`server/` is sole source of truth; prepare scripts copy runtime files only; SHA-256 diff = 0 after prepare.

## File targets

- `scripts/` prepare for desktop and Android
- `desktop/server/`, `android/.../server/` embedded copies
- `releases/manifest.json`, `/api/system/app-info`
- New: hash compare script (CI)

## Tasks

- [x] Document and enforce prepare pipeline
- [x] Exclude db, uploads, backup, logs, node_modules from copy
- [x] SHA-256 compare script; CI fails on drift in db.js, routes, lib, sync, UI, SW
- [x] Unified release id across web/desktop/Android
- [x] Smoke-test prepared sources and release metadata without building APK/EXE

## Verification

```powershell
# after implement: node scripts/compare-embedded-hash.js (to be created)
curl http://localhost:PORT/api/system/app-info
```

## Acceptance

- [x] Hash diff zero post-prepare
- [x] Shared release id in app-info
- [x] CI drift commands added to production workflow and pass locally

**Deploy:** ❌ Wave 0 blocked
