# Project Status

- Last verified: 2026-08-12 (~24:15 +03:30)
- **Active task:** none (ACC-CRM-UNIFY completed after dual Approved)
- **ACC-CRM-UNIFY:** Independent Reviewer **APPROVED** + Security **APPROVED** on code tip `c0ed4c9` (stamp `fe2f1da`)
  vs base `448a8c1`. Claims released. Branch `ai/ACC-CRM-UNIFY-accounting-crm` ready for owner merge.
- **NO Iran deploy / merge** until explicit owner approval (not performed).
- Roles used: Implementer `cursor:implementer-acc-crm`; Reviewer `cursor:independent-reviewer-acc-crm`;
  Security `cursor:independent-security-acc-crm` (distinct from Implementer).
- Prior: PROD-P5-R2 completed.

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
- `node server/scripts/test-acc-crm-perpetual.js`
- `node server/scripts/test-acc-crm-party.js`
- `node server/scripts/test-acc-crm-dashboard.js`
- `node server/scripts/test-acc-crm-reports.js`
- `node server/scripts/test-acc-crm-phase6.js`
- `node server/scripts/run-acc-crm-baseline.js`
- `node server/scripts/check-ui-encoding.js`
