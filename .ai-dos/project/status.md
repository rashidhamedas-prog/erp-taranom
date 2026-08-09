# Project Status

- Last verified: 2026-08-09
- Primary branch: `claude/claude-md-docs-2ssrpy`
- **PROD-P4 complete** on `ai/PROD-P4-overhead-labor` (`erp-taranom-prod-p4`): overhead + labor + cost-center rates API + tests **38/38 PASS**.
- Parallel context: PROD-P3 and Waves 1–2 may still be active; do not blind-merge/deploy over their claims.
- Wave 0: closed with permanent sharp runtime waiver (`0.33.5` on VPS).

## Working quality commands

- `git diff --check`
- `node --check server/lib/production/overhead.js`
- `node --check server/lib/production/labor.js`
- `node --check server/routes/production-cost-centers.js`
- `node server/scripts/test-production-overhead-labor.js` (set NODE_PATH to server/node_modules if needed)
