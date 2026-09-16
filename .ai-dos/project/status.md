# Project Status

- Last verified: 2026-09-17
- **Active task:** none
- **Closed this turn:** `EXCEL-PRODUCTS-CATALOG-V216` (SW v216 catalog cap + v217 qty decimals)
- **Iran last:** overlay SW **erp-taranom-v217** @ `2a6bd6d` / docs `e368607`; invoices proforma-only API gate overlaid in this close-out
- **Primary tip:** `main` = `claude/claude-md-docs-2ssrpy` = `feat/EXCEL-PRODUCTS-CATALOG-V216`
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
