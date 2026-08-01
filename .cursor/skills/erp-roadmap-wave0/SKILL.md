---
name: erp-roadmap-wave0
description: >-
  Executes Wave 0 (critical path) of the ERP Taranom master roadmap: P0-A BOM/CI
  hang fix, P0-B source drift, P0-S1/S2/S3 security, P0-C backup/restore, and
  P0-Q1/Q2 test/CI gates. Use when the user mentions Wave 0, موج صفر, P0-A,
  P0-B, P0-C, P0-S1, P0-S2, P0-S3, P0-Q1, P0-Q2, BOM hang, test-production-bom,
  roadmap gate, or erp-taranom-master-roadmap.
---

# ERP ترنم — Wave 0 Execution Skill

Authoritative roadmap: [`docs/erp-taranom-master-roadmap.md`](../../../docs/erp-taranom-master-roadmap.md)  
Living plan: [`docs/.plans/260801-wave0-critical-path/SUMMARY.md`](../../../docs/.plans/260801-wave0-critical-path/SUMMARY.md)

Read those before coding. Prefer agent `erp-wave0-executor` (one phase at a time). For BOM hang diagnosis only, use `erp-p0-bom-ci`.

## Hard override — no production deploy

Until the **Wave 0 gate** passes (roadmap §17):

| Allowed | Forbidden |
|---------|-----------|
| Commit + push to working branch | `pm2 restart`, Iran SSH deploy, staging→prod |
| Local tests, temp DB, dry-run scripts | Full APK / `npm run dist:win` unless user explicitly asks |
| Updating CHANGE-LOG with Deploy `❌` / `⏳ no deploy (Wave 0)` | Marking Deploy `✅` for Iran |

This **overrides** `.cursor/rules/auto-commit-deploy.mdc` for all Wave 0 phases. After gate: restore normal deploy policy only when the user/plan opens the gate.

**Wave 0 gate:** full suite green, remote sync TLS-only, off-box backup + successful restore drill.

## Non-negotiables (roadmap §3)

### Repo
- Read `CLAUDE.md`, `.cursorrules`, `docs/PROJECT-HANDOFF.md`, top of `docs/CHANGE-LOG.md` before changes.
- `SYNCABLE_TABLES` append-only; never reorder/delete.
- Numbers only via `allocateNumber()` / `number_sequences`.
- Multi-table ops inside `db.transaction()`.
- Money: integer rial + `money.js` guards.
- No hard-delete of financial docs; cancel = full reverse (R13).
- Feature/behavior changes update in-app Help + CHANGE-LOG.
- Device-facing changes: sync tables, capture, FK, backfill, files.
- No secrets in Git.
- Each phase on its own branch (`codex/…` or owner-approved).
- **No prod deploy before that phase’s gate** (and no Iran deploy until Wave 0 gate).

### Quality
- Fix without regression test = incomplete.
- String/function existence tests ≠ behavioral tests.
- Tests must not hang; controlled timeout + definite cleanup.
- Financial endpoints: success, validation, permission, idempotency, rollback, cancel/reverse.
- Empty catch on financial/security paths forbidden.
- Schema changes: version/marker + empty DB + existing DB + re-run tests.
- Reports must reconcile to ledger/journal.

### Definition of Done (every task)
- [ ] Code + migration complete
- [ ] New/updated tests written and passing
- [ ] `node server/scripts/test-sms.js` and `test-sync.js` pass
- [ ] Related suite passes and exits (no open handles)
- [ ] Frontend `<script>` parses via `new Function()`
- [ ] Help + CHANGE-LOG updated
- [ ] Desktop/Android source sync via official prepare + hash check (when device-touched)
- [ ] Smoke on target build when applicable
- [ ] **No Iran/pm2 deploy** until Wave 0 gate

## Mandatory order

Do **not** skip or reorder:

1. **P0-A** — BOM hang + production CI reliability  
2. **P0-B** — Eliminate web/desktop/Android source drift  
3. **P0-S1 → P0-S2 → P0-S3** — TLS/sync, client hardening, web/API security  
4. **P0-C** — Backup, restore, DR  
5. **P0-Q1 → P0-Q2** — Test pyramid + CI/CD gates  

One phase per agent session unless the user names multiple. Update plan Progress checkboxes as you go.

## Task template (roadmap §19) — before coding

Record in the reply (and Decision Log if material):

1. Problem + current evidence  
2. Files and tables involved  
3. Impact on accounting, warehouse, sync, RBAC, UI  
4. Migration needed?  
5. Tests before/after  
6. Rollback risk + recovery  
7. Numeric acceptance criteria  

After execution report: what changed, pass/fail counts, schema/migration, desktop/Android sync status, Help/CHANGE-LOG, commit/branch, and deploy status (**must be none** until Wave 0 gate).

## Forbidden (roadmap §20)

- Claiming “done” from UI/route existence alone  
- Empty catch on financial ops  
- Stock change only on `products.stock` without warehouse/ledger  
- `COUNT(*)+1` for document numbers  
- Physical delete of financial documents  
- Trusting client price/role/company/amount  
- Non-atomic credit checks  
- Plaintext/log of tax private keys or tokens  
- Remote HTTP sync  
- APK/desktop build from unapproved embedded source  
- Migration without existing-DB + re-run tests  
- Deploy without backup, test gate, rollback plan  
- Full frontend rewrite in one step  
- Legal-compliance marketing claims before specialist sign-off  

## Phase cheat-sheet

| Phase | Goal | Primary targets | Verify |
|-------|------|-----------------|--------|
| P0-A | Suite finishes; BOM tests run | `server/lib/production/bom.js`, `server/scripts/test-production-bom.js`, `package.json` test:production | `npm run test:production` ×3; process exits ≤5s after summary |
| P0-B | Zero runtime hash drift | prepare scripts, `releases/manifest.json`, desktop/android embed | SHA-256 drift = 0; shared release id |
| P0-S1 | TLS-only remote sync | `normalizeCentralUrl`, sync client | HTTP remote rejected |
| P0-S2 | Android/Electron harden | AndroidManifest, network config, Electron main | deep-link / cleartext rejected |
| P0-S3 | Web/API harden | Helmet CSP, CORS, upload, rate-limit | OWASP-oriented suite |
| P0-C | Off-box encrypted backup + restore | `server/backup.js`, DR runbook | restore drill within RTO |
| P0-Q1 | Unit/integration/E2E pyramid | Playwright + production suites | critical money paths covered |
| P0-Q2 | CI gates | CI config, timeouts, drift check | fail on hang/drift/secret |

Details and checkboxes: living plan SUMMARY.md. BOM hang playbook: agent `erp-p0-bom-ci` + plan §P0-A.

## Progressive disclosure

- Full phase tasks/acceptance: roadmap §§ P0-* and §17 Wave 0  
- Forbidden/DoD: this skill (§3/§20 summarized above)  
- Hang diagnosis steps: `docs/.plans/260801-wave0-critical-path/SUMMARY.md` → P0-A  
- Project stack conventions: `.cursor/skills/project-conventions/SKILL.md`
