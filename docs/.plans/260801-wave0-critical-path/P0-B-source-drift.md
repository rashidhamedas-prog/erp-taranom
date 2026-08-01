# Phase P0-B — Source drift (web / desktop / Android)

**Status:** `[ ]`  
**Roadmap:** فاز P0-B

## Objective

`server/` is sole source of truth; prepare scripts copy runtime files only; SHA-256 diff = 0 after prepare.

## File targets

- `scripts/` prepare for desktop and Android
- `desktop/server/`, `android/.../server/` embedded copies
- `releases/manifest.json`, `/api/system/app-info`
- New: hash compare script (CI)

## Tasks

- [ ] Document and enforce prepare pipeline
- [ ] Exclude db, uploads, backup, logs, node_modules from copy
- [ ] SHA-256 compare script; CI fails on drift in db.js, routes, lib, sync, UI, SW
- [ ] Unified release id across web/desktop/Android
- [ ] Mark stale builds; smoke test prepared exe/APK

## Verification

```powershell
# after implement: node scripts/compare-embedded-hash.js (to be created)
curl http://localhost:PORT/api/system/app-info
```

## Acceptance

- [ ] Hash diff zero post-prepare
- [ ] Shared release id in app-info
- [ ] CI drift job green

**Deploy:** ❌ Wave 0 blocked
