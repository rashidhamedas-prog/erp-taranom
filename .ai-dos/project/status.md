# Project Status

- Last verified: 2026-08-14 (~13:05 +03:30)
- **Active task:** none — DEMO-V2-SECURE-SALES `completed` (dual Approved).
  Merge / Iran deploy still require explicit owner approval.
- **Worktree:** `D:/soft/Claud/porje/Run in the project/erp-taranom-demo-v2`
- **Branch:** `ai/DEMO-V2-SECURE-SALES` @ base `eae0a14`
- **Constraint:** NO Iran/production deploy; do not touch `erp-taranom1` dirty file
  `scripts/_deploy-mdi-v152-sftp.py`. Do not reuse attached
  `feat/DEMO-V2-SECURE-SALES` worktree.
- **ACC-CRM-UNIFY:** dual Approved → owner OK → FF-merge primary `aa1ee64` + SFTP Iran ✅
  Stamp `.sftp-deploy-stamp-acc-crm-unify` hash=`aa1ee64` · later MDI SW `erp-taranom-v153`.
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
