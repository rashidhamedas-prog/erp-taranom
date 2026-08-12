# Project Status

- Last verified: 2026-08-13 (~01:06 +03:30)
- **Active task:** none (ACC-CRM-UNIFY merged + Iran deployed)
- **ACC-CRM-UNIFY:** dual Approved → owner OK → FF-merge primary `aa1ee64` + SFTP Iran ✅
  Stamp `.sftp-deploy-stamp-acc-crm-unify` hash=`aa1ee64` · SW `erp-taranom-v151` live.
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
