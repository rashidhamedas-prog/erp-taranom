# Project Status

- Last verified: 2026-09-23
- **Active task:** none — CRM user scope closed
- **Closed this turn:** CRM visibility matches the customer list. Activity drilldown reads `activity_date`. Inside sales and distribution office have no default production view.
- **Iran last:** SW **erp-taranom-v222** overlay SFTP @ `2da84ef` — health/ready/root 200 (dirty tree, no pull; server HEAD still `8a5cd54`)
- **Primary tip:** `main` @ `2da84ef`
- Prior: dashboard hotpath closed at SW v221.
- Prior history below kept for context.

## Working quality commands

- Isolated QA (temp DB, no production): `set NODE_ENV=test` then `node scripts/qa/run-full-erp-qa.js` (exit 0/1/2/3)
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
