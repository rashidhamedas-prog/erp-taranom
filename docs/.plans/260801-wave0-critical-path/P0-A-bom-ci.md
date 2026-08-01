# Phase P0-A — BOM hang & production CI reliability

**Status:** `[ ]` Not complete  
**Agent:** `@erp-p0-bom-ci` or `@erp-wave0-executor`  
**Roadmap:** `docs/erp-taranom-master-roadmap.md` — فاز P0-A

---

## Objective

All production test suites finish within bounded time; BOM tests T1-01…T1-27 run to completion; `npm run test:production` passes 3× consecutively; process exits ≤5s after summary with no stray handles.

---

## File targets

| File | Purpose |
|------|---------|
| `server/scripts/test-production-bom.js` | Stage logs, cleanup, optional per-file timeout |
| `server/lib/production/bom.js` | `explodeBom`, `detectCircular`, `resolveSubstitutes`, `validateBom` |
| `server/scripts/lib/test-harness.js` | `freshDb`, `cleanup`, `summary` |
| `server/package.json` | `test:production` chain; add timeout wrapper if needed |
| Other `server/scripts/test-production-*.js` | If hang is in later script in chain |

---

## Investigation steps (do in order)

### Step 1 — Reproduce with isolation

```powershell
cd server
node scripts/test-production-bom.js
echo exit=$LASTEXITCODE
```

- [ ] Record last printed test id if hang occurs
- [ ] Record time from summary to process exit

### Step 2 — Full suite bisect

`test:production` runs 18 scripts sequentially (`package.json`). If Step 1 passes, bisect:

```powershell
cd server
node scripts/test-production-schema.js && node scripts/test-production-bom.js && node scripts/test-production-fixed.js
# extend chain until hang appears
```

Scripts after BOM in chain:

1. `test-production-fixed.js`
2. `test-production-variable.js`
3. `test-production-bom-advanced.js`
4. … through `test-production-ui-smoke.js`

- [ ] Identify exact script that hangs or fails to exit

### Step 3 — Open handle inspection

If summary prints but process lives:

```powershell
node --trace-warnings scripts/test-production-bom.js
# or add temporary logging of process._getActiveHandles().length before/after cleanup
```

- [ ] Confirm `cleanup()` closes DB and removes WAL/SHM temp files
- [ ] Check for `setInterval`, HTTP servers, or sync client left running from `db.js` init

### Step 4 — Code review hotspots

**T1-08 path** (`test-production-bom.js` ~L119-133):

- Creates plain BOM on `P.p102`, activates, `explodeBom({ bomId, qty: 300 })`
- Expected fabric qty: 515.46

**`bom.js`:**

- `explodeBom` — recursion via `is_multilevel` + child `resolveBom` (try/catch swallows missing child)
- `detectCircular` — depth limit 10; roadmap requires path-based visited set for diamond graphs
- `resolveSubstitutes` — stock scan loops; verify no blocking query

- [ ] Add unit tests: one-level cycle, two-level cycle (T1-11), diamond multilevel if applicable

### Step 5 — CI hardening

- [ ] Wrapper script: per-file timeout (e.g. 120s) with labeled failure
- [ ] Artifact: save stdout on timeout
- [ ] Ensure every production test calls `cleanup()` + reaches `summary()` or `process.exit`

---

## Verification commands

```powershell
cd server
node scripts/test-production-bom.js
npm.cmd run test:production
# repeat npm run test:production 3 times
```

Post-summary timing:

```powershell
Measure-Command { node scripts/test-production-bom.js }
```

---

## Acceptance criteria

- [ ] T1-01 through T1-27 (and any extended ids) execute
- [ ] Process exits ≤5 seconds after summary line
- [ ] `npm run test:production` passes 3 consecutive runs on Node 20+ (and dev Node version)
- [ ] No unknown open handles after exit
- [ ] Regression tests for cycle detection if code changed
- [ ] `test-sms.js` + `test-sync.js` still pass
- [ ] CHANGE-LOG updated; Help only if user-visible behavior changed

---

## Current evidence (2026-08-01)

- Isolated run in worktree: **27/27 pass**, exit 0 (~125s total including initDB migrations).
- Roadmap audit still lists hang — treat full-suite ×3 as source of truth for gate.

---

## Notes for implementer

Do not declare P0-A done based on isolated BOM pass alone. The production npm script chains many files; prior audits reported `test:production` never finishing.
