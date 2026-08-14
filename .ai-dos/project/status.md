# Project Status

- Last verified: 2026-08-14 (~13:20 +03:30)
- **Active task:** none
- **DEMO-V2-SECURE-SALES:** merge into primary in progress (owner-approved deploy)
- **CRM-PRO-ANALYTICS:** merged + Iran deployed ✅
  Primary tip before this merge `d3b6136` / stamp `1287a1a`
  SFTP stamp `.sftp-deploy-stamp-crm-pro-v154` = `2026-08-14T05:33:42Z hash=d3b6136`
  Task `completed`; Reviewer a092902a + Security 16b3d555 APPROVED
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
