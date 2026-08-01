# Phase P0-A — BOM hang & production CI reliability

**Status:** `[x]` Complete (2026-08-01)  
**Agent:** `@erp-p0-bom-ci` or `@erp-wave0-executor`  
**Roadmap:** `docs/erp-taranom-master-roadmap.md` — فاز P0-A

---

## Objective

All production test suites finish within bounded time; BOM tests T1-01…T1-29 run to completion; `npm run test:production` passes 3× consecutively; process exits ≤5s after summary with no stray handles.

---

## Done evidence

- `detectCircular` path visited-set in `server/lib/production/bom.js`
- T1-28 mid-path cycle + T1-29 diamond in `test-production-bom.js` → 29/29
- `server/scripts/run-production-tests.js` (per-script timeout, artifact on fail)
- `npm run test:production` ×3: EXIT=0 in 10.6 / 8.9 / 8.0 min
- `test-sms.js` 22/22; `test-sync.js` 33/33

---

## File targets

| File | Purpose |
|------|---------|
| `server/scripts/test-production-bom.js` | Stage logs, cleanup, optional per-file timeout |
| `server/lib/production/bom.js` | `explodeBom`, `detectCircular`, `resolveSubstitutes`, `validateBom` |
| `server/scripts/lib/test-harness.js` | `freshDb`, `cleanup`, `summary` |
| `server/package.json` | `test:production` → `run-production-tests.js` |
| `server/scripts/run-production-tests.js` | Timeout wrapper + artifacts |

---

## Acceptance criteria

- [x] T1-01 through T1-29 execute
- [x] Process exits after summary (`process.exit` in harness + child exit in runner)
- [x] `npm run test:production` passes 3 consecutive runs
- [x] Cycle detection path-based + diamond allowed
- [x] `test-sms.js` + `test-sync.js` pass
- [x] CHANGE-LOG updated; Help N/A (no user-visible UI change)
---

## Current evidence (2026-08-01)

- Isolated run in worktree: **27/27 pass**, exit 0 (~125s total including initDB migrations).
- Roadmap audit still lists hang — treat full-suite ×3 as source of truth for gate.

---

## Notes for implementer

Do not declare P0-A done based on isolated BOM pass alone. The production npm script chains many files; prior audits reported `test:production` never finishing.
