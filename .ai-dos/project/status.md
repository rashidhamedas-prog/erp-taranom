# Project Status

- Last verified: 2026-08-12 (~18:50 +03:30)
- **Active task:** `ACC-CRM-UNIFY` (high risk) — remediation after dual review.
- **Review disposition:** Independent Reviewer **CHANGES_REQUIRED**; Security **NOT APPROVED**
  (reviewed tip `d5a2f51` vs base `448a8c1`). Task remains `active` — NOT completed; claims retained.
- **Remediation:** Phases 0–8. **Phase 0+1 GREEN** (ports/cleanup; index.html UTF-8 restored + encoding guard + ui-baseline screenshots; SW v150).
  Phases 2–3 in parallel (money ×10 / CRM RBAC). Task still CHANGES_REQUIRED / Security NOT APPROVED.
- Branch / worktree: `ai/ACC-CRM-UNIFY-accounting-crm` /
  `D:/soft/Claud/porje/Run in the project/erp-taranom-acc-crm-unify`.
- Roles: Orchestrator `cursor:orchestrator`; Implementer `cursor:implementer-acc-crm`;
  Reviewer `cursor:independent-reviewer-acc-crm`; Security `cursor:independent-security-acc-crm`
  (Reviewer/Security distinct from Implementer — Implementer must not self-approve).
- **NO Iran deploy / merge** until explicit owner approval after dual Approved.
- Do not implement in dirty `erp-taranom1`. Leave `ai/W1-*` alone.
- Prior: PROD-P5-R2 completed (tip lineage from primary `448a8c1`).

## Working quality commands

- `git diff --check`
- `node server/scripts/check-audit-waivers.js`
- `node server/scripts/test-production-bom-advanced.js`
- `node server/scripts/test-production-overhead-labor.js`
- `node server/scripts/test-production-variable.js`
- `node server/scripts/test-sms.js`
- `node server/scripts/test-sync.js`
- `node server/scripts/_diag-sync-gaps-b16e78.js`
- `node --check server/server.js`
- `npm.cmd --prefix server run test:production`
- `node server/scripts/test-acc-crm-perpetual.js` (added by this task)
- `node server/scripts/test-acc-crm-party.js` (added by this task)
- `node server/scripts/test-acc-crm-dashboard.js` (added by this task)
- `node server/scripts/run-acc-crm-baseline.js` (Phase 0 serial runner; env ACC_CRM_TEST_PORT / SYNC_TEST_PORT_BASE)
