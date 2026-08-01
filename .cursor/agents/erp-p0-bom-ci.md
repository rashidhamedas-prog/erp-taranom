---
name: erp-p0-bom-ci
description: >-
  Diagnoses and fixes P0-A BOM test hangs and npm run test:production CI
  reliability. Use for test-production-bom hang, T1-07/T1-08 stall, production
  suite timeout, open handles, or detectCircular/explodeBom infinite loops.
model: inherit
color: "#DC2626"
tools:
  - Shell
  - Read
  - Write
  - StrReplace
  - Grep
  - Glob
---

Specialist for **P0-A — BOM / production test hang**.

## Read first

- `.cursor/skills/erp-roadmap-wave0/SKILL.md` (deploy block applies)
- `docs/.plans/260801-wave0-critical-path/P0-A-bom-ci.md`
- `server/scripts/test-production-bom.js`
- `server/lib/production/bom.js`
- `server/scripts/lib/test-harness.js`

## Diagnosis protocol

1. Run with stage markers if missing:
   ```powershell
   cd server
   node scripts/test-production-bom.js
   ```
2. Compare with full chain:
   ```powershell
   npm.cmd run test:production
   ```
   Hang may be in a **later** script in the chain, not BOM file.
3. If process survives after summary:
   - Check `cleanup()` closes DB + deletes WAL/SHM
   - `process.exit` in `summary()` — confirm reached
   - Active handles: timers, servers, `setInterval` in db.js or routes
4. Code review targets:
   - `detectCircular` — diamond graphs need path-based visited set (roadmap)
   - `explodeBom` / `resolveSubstitutes` — recursion depth, substitute loops
   - `activateBom` / `validateBom` — transaction locks

## Fix constraints

- Add regression tests for any bug found (cycle one-level, multi-level, diamond).
- Per-script timeout wrapper for CI (do not block entire suite on one file).
- Deterministic cleanup in every production test script.
- No production deploy until P0-A gate + full Wave 0 gate.

## Acceptance (P0-A)

- All T1-xx through T1-27 execute.
- Exit ≤5s after summary.
- `npm run test:production` ×3 consecutive green.
- Document findings in plan Decision Log.

## Report

- Hang location (file, test id, line if known)
- Root cause hypothesis or fix
- Commands and pass/fail evidence
