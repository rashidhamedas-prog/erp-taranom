---
name: erp-roadmap-wave0
description: >-
  Executes Wave 0 (موج صفر) of ERP ترنم master roadmap: P0-A BOM/CI through P0-Q2.
  Enforces §3 non-negotiables, Definition of Done, §19 task template, and §20
  forbidden list. Blocks production deploy until Wave 0 gate passes. Use when the
  user mentions Wave 0, موج صفر, P0-A, P0-B, P0-C, P0-S1, P0-Q1, master roadmap,
  or critical-path stabilization before new features.
---

# ERP ترنم — Wave 0 Execution Skill

Master roadmap: `docs/erp-taranom-master-roadmap.md` (authoritative backlog).

## Wave 0 scope and order (strict)

Execute **one phase at a time**. Do not start the next phase until the current phase gate passes.

| Order | Phase | Focus |
|-------|-------|-------|
| 1 | **P0-A** | BOM test hang / `npm run test:production` reliability |
| 2 | **P0-B** | Web ↔ desktop ↔ Android source drift (SHA-256 zero diff) |
| 3 | **P0-S1** | TLS-only remote sync; remove HTTP fallback |
| 4 | **P0-S2** | Android + Electron hardening |
| 5 | **P0-S3** | Web/API security (CSP, CORS, uploads, rate limits) |
| 6 | **P0-C** | Backup, restore, DR drill |
| 7 | **P0-Q1** | Test pyramid baseline |
| 8 | **P0-Q2** | CI/CD gates |

**Wave 0 exit gate:** full suite green; remote sync TLS-only; off-server backup + successful restore drill.

Living plan: `docs/.plans/260801-wave0-critical-path/SUMMARY.md` — update Progress / Surprises / Decision Log / Outcomes each session.

## Deploy override (Wave 0)

**Overrides** `.cursor/rules/auto-commit-deploy.mdc` until Wave 0 gate passes:

- ✅ Commit + push to working branch (`claude/claude-md-docs-2ssrpy` or owner-approved `codex/*`) is allowed.
- ❌ **No** `pm2 restart`, Iran VPS deploy, or production pull until Wave 0 gate passes.
- ❌ **No** full desktop/APK builds unless explicitly required to verify P0-B (use prepare + hash check first).
- CHANGE-LOG deploy status: `❌ Wave 0 — deploy blocked` or `⏳ post-gate`.

After gate passes, resume normal auto-commit-deploy.

## Pre-flight (every session)

1. Read `docs/CHANGE-LOG.md` (top entries), `CLAUDE.md`, `.cursorrules`, `docs/PROJECT-HANDOFF.md`.
2. Read current phase in `docs/.plans/260801-wave0-critical-path/`.
3. `git fetch` and align with `origin/claude/claude-md-docs-2ssrpy` before large work.

## §3 Non-negotiables (enforce always)

### Repository

- `SYNCABLE_TABLES` append-only; never reorder.
- Document numbers via `allocateNumber()` / `number_sequences` only — never `COUNT(*)+1`.
- Multi-table ops inside `db.transaction()`.
- Money: INTEGER rial + `money.js` guards.
- No physical delete of financial docs; cancel = full reverse (JE, stock, sub-ledger, settlement cascade).
- Feature/behavior changes → in-app Help (`ROUTES.help`) + `docs/CHANGE-LOG.md`.
- Device changes → sync registry, capture, FK map, backfill, files.js checklist (`.cursor/rules/sync-hygiene.mdc`).
- No secrets in Git.
- Phase work on dedicated branch; **no production deploy before phase gate**.

### Quality

- No fix without regression test.
- String-existence tests ≠ behavioral tests.
- Tests must not hang; controlled timeout + deterministic cleanup.
- Financial endpoints: success, validation, permission, idempotency, rollback, cancel/reverse.
- No empty catch on financial/security paths.
- Schema changes: version marker, empty + existing DB, re-run safety.

### Definition of Done (general)

Task is Done only when:

- Code + migration complete.
- New tests written and passing.
- `node server/scripts/test-sms.js` and `node server/scripts/test-sync.js` pass.
- Related suite exits cleanly (no open handles).
- Frontend `<script>` parses via `new Function()`.
- Help + CHANGE-LOG updated.
- Desktop/Android source synced via official prepare when device logic touched.
- Smoke on target build when applicable.

## §19 Task template (before coding)

Record in the response **before** implementation:

1. Problem and current evidence.
2. Files and tables involved.
3. Impact on accounting, inventory, sync, RBAC, UI.
4. Required migration.
5. Tests before and after.
6. Rollback risk and recovery.
7. Numeric acceptance criteria.

After implementation report:

- What changed.
- Tests run with pass/fail counts.
- Schema version / migration.
- Desktop/Android sync status.
- Help + CHANGE-LOG status.
- Commit/branch; deploy **only if Wave 0 gate allows**.

## §20 Forbidden list

- Declaring "complete" from UI/route presence alone.
- Empty catch in financial ops.
- Stock change only in `products.stock` without ledger/warehouse source.
- `COUNT(*)+1` numbering.
- Physical delete of financial documents.
- Trusting client-sent price, role, company id, or amount.
- Non-atomic company credit in split queries.
- Plaintext moudian keys or tokens in logs.
- Remote HTTP sync.
- APK/desktop from unverified embedded source.
- Migration without existing-DB + re-run tests.
- Direct deploy without backup, test gate, rollback plan.
- Full frontend rewrite in one step.
- Legal-compliance sales claims before expert sign-off.

## Phase quick reference

Detail: `reference-phases.md` in this skill folder.

### P0-A acceptance

- T1-01 through last BOM test run.
- Process exits ≤5s after summary.
- `npm run test:production` passes 3 consecutive runs.
- No unknown open handles (`node --trace-gc` / active handle inspection if needed).

### P0-B acceptance

- SHA-256 runtime diff = 0 after prepare.
- `/api/system/app-info` shared release id across surfaces.

### P0-S1 / S2 / S3

- Remote HTTP rejected; MITM cert failure blocks sync.
- Android backup/cleartext hardening; Electron sandbox/navigation limits.
- CSP, CORS fail-fast, upload validation, OWASP test subset.

### P0-C acceptance

- RPO≤15m, RTO≤4h documented; encrypted off-VPS backup; weekly isolated restore drill.

### P0-Q1 / Q2

- Unit/integration/browser/mobile test inventory with owners.
- CI: lint, parallel suites + timeout, drift check, migration test, staging smoke, approval gate.

## Verification commands (Wave 0)

```powershell
cd server
node scripts/test-sms.js
node scripts/test-sync.js
node scripts/test-production-bom.js
npm.cmd run test:production
node scripts/_diag-sync-gaps-b16e78.js
```

Frontend syntax (from repo root):

```powershell
node -e "const fs=require('fs');const h=fs.readFileSync('server/public/index.html','utf8');const m=h.match(/<script>([\s\S]*)<\/script>/i);if(!m)throw new Error('no script');new Function(m[1]);console.log('script ok');"
```

## Agent routing

| Situation | Agent |
|-----------|-------|
| Any Wave 0 phase end-to-end | `@erp-wave0-executor` |
| P0-A BOM hang / production CI | `@erp-p0-bom-ci` |
| Plan-driven batch work | `execute-plan` skill on `docs/.plans/260801-wave0-critical-path/SUMMARY.md` |

## Related skills

- `project-conventions` — R1–R13 production/accounting rules.
- `execute-plan` — living plan execution discipline.
