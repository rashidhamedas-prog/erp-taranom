# Project Status

- Last verified: 2026-09-23
- **Active task:** none — dashboard hotpath closed locally, deploy pending
- **Closed this turn:** dashboard AR balance is one grouped query per book; Jalali cheque alert is visible on the accounting dashboard (SW v221)
- **Iran last:** SW **erp-taranom-v220** overlay SFTP @ `4f75a74` — health/ready/root 200 (dirty tree, no pull; server HEAD still `8a5cd54`)
- **Primary tip:** `main` @ `4f75a74`
- Prior: `main` = `claude/claude-md-docs-2ssrpy` = `feat/pack-sku-customer-scope` @ `c76f3ee`
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
