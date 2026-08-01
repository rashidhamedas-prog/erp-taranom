---
name: erp-p0-bom-ci
description: >-
  Diagnoses and fixes the ERP Taranom production BOM test hang between T1-07
  and T1-08, and makes npm run test:production reliably finish. Use when
  test-production-bom hangs, T1-08 never runs, test:production never exits,
  or the user mentions P0-A / BOM CI / detectCircular / explodeBom hang.
model: inherit
color: orange
tools: [Read, Write, StrReplace, Grep, Glob, Shell, Delete, TodoWrite, ReadLints, UpdateCurrentStep]
---

# P0-A — BOM / production CI hang doctor

Scope: **P0-A only**. No Iran deploy. Commit+push OK after green local verification.

## Evidence already known

- Roadmap §2: `npm run test:production` does not finish; `test-production-bom.js` stops after T1-07 (T1-08+ never run).
- T1-08 first actions: `createBom` (plain BOM on `p102`) → `activateBom` → `explodeBom({ qty: 300 })`.
- `detectCircular` in `server/lib/production/bom.js` uses **depth limit only** (not a path visited-set); diamond/cycle graphs can mis-classify or recurse poorly.
- `explodeBom` multilevel path has an empty `catch` when resolving child BOMs.
- Harness `summary()` calls `process.exit`; open handles elsewhere in the chained `test:production` scripts can still strand the suite.
- Suite chain: `server/package.json` → `test:production` runs many scripts with `&&` and **no per-file timeout**.

## Diagnosis order (do this first)

1. Add temporary stage logs around T1-08:
   - before/after `createBom`
   - before/after `activateBom` (and inside `validateBom` / `detectCircular` entry/exit)
   - before/after `explodeBom`
2. Run with a hard kill:
   ```powershell
   cd server
   node --test-timeout=120000 scripts/test-production-bom.js
   # or: Start-Process + Wait-Process timeout; on hang dump stacks
   ```
3. On hang, inspect active handles (`process._getActiveHandles` / `why-is-node-running` pattern) after forcing a dump from a watchdog.
4. Re-read `createBom`, `activateBom`, `validateBom`, `detectCircular`, `resolveSubstitutes`, `explodeBom` for:
   - unbounded recursion / missing path set
   - sync bcrypt only at T1-20 (unlikely for T1-08)
   - DB lock / transaction never released
   - accidental server listen imported via `db.js` side effects

## Required fixes (acceptance-aligned)

- Path-based cycle detection (visited set on product path); depth alone insufficient.
- Recursions always terminate with typed errors; tests for 1-level, multi-level, and diamond graphs.
- `test-production-bom.js`: deterministic cleanup of DB/timers/handles; stage logging can stay behind `DEBUG_BOM_TEST=1`.
- Per-script timeout for production suite (wrapper or CI step) so one file cannot stall the chain.
- `npm run test:production` passes **three times** consecutively; process exits ≤5s after summary.

## Report format

Use roadmap §19 before/after. Update `docs/.plans/260801-wave0-critical-path/SUMMARY.md` Progress + Surprises with root cause once found. CHANGE-LOG: Deploy `❌ no deploy (Wave 0 gate)`.
