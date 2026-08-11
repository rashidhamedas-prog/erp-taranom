# Project Status

- Last verified: 2026-08-11 (~20:20 +03:30)
- **Active task:** `ACC-CRM-UNIFY` (high risk) — accounting perpetual unify + normal invoice + CRM.
- **Progress:** waves 0–6 code-complete (normal invoice + perpetual sales/purchase/returns/void,
  cheque transition idempotency, user↔party unique, UI redirects, MDI bottom bar, CRM dashboard/timeline).
  Gates green: perpetual 34/34, party 5/5, dashboard 8/8, SMS 22/22, diag mismatches=[].
  Pending: test-sync (machine-load flake — concurrent Next.js build), test:production, dual review.
- Branch / worktree: `ai/ACC-CRM-UNIFY-accounting-crm` /
  `D:/soft/Claud/porje/Run in the project/erp-taranom-acc-crm-unify` @ base `448a8c1`.
- Roles: Orchestrator `cursor:orchestrator`; Implementer `cursor:implementer-acc-crm`;
  Reviewer `cursor:independent-reviewer-acc-crm`; Security `cursor:independent-security-acc-crm`
  (Reviewer/Security distinct from Implementer).
- **NO Iran deploy** until explicit owner approval after dual review.
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
