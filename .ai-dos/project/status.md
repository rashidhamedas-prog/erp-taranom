# Project Status

- Last verified: 2026-08-14 (~04:10 +03:30)
- **Active task:** CRM-PRO-ANALYTICS (high risk; isolated worktree)
- **CRM-PRO-ANALYTICS:** implementation + dedicated tests green; still `active`
  Branch `ai/CRM-PRO-ANALYTICS-crm-dashboard`
  Worktree `D:/soft/Claud/porje/Run in the project/erp-taranom-crm-pro-analytics`
  Base `eae0a14`
  Roles: Implementer `cursor:implementer-crm-pro`; Reviewer `cursor:independent-reviewer-crm-pro`;
  Security `cursor:independent-security-crm-pro` (distinct from Implementer).
  Gates: analytics 33 · RBAC 17 · UI 17 · perf 8 · SMS 22 · sync 44 · diag []
  Security: APPROVED (16b3d555). Reviewer: APPROVED (a092902a). Task still active; no completed; no Iran deploy.
  **NO Iran deploy** and **NO completed** until Independent Reviewer + Security Approved + explicit owner deploy approval.
- Prior: ACC-CRM-UNIFY merged + Iran deployed (SW v151 lineage; later MDI v153).

## Working quality commands

- `git diff --check`
- `node --check server/server.js`
- `node --check server/public/app.js`
- `node server/scripts/check-ui-encoding.js`
- `node server/scripts/check-audit-waivers.js`
- `node server/scripts/test-crm-pro-analytics.js`
- `node server/scripts/test-crm-pro-rbac.js`
- `node server/scripts/test-crm-pro-ui-smoke.js`
- `node server/scripts/test-crm-pro-performance.js`
- `node server/scripts/test-acc-crm-dashboard.js`
- `node server/scripts/test-acc-crm-reports.js`
- `node server/scripts/test-acc-crm-phase6.js`
- `node server/scripts/test-acc-crm-perpetual.js`
- `node server/scripts/test-acc-crm-party.js`
- `node server/scripts/test-sms.js`
- `node server/scripts/test-sync.js`
- `node server/scripts/_diag-sync-gaps-b16e78.js`
- `npm.cmd --prefix server run test:production`
- `node scripts/prepare-embedded-server.js all`
- `node scripts/compare-embedded-hash.js`
