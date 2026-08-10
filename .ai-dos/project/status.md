# Project Status

- Last verified: 2026-08-10 (~17:15 +03:30)
- Active corrective: **PROD-P5-R2** on `fix/PROD-P5-R2-review-remediation`
  worktree `D:/soft/Claud/porje/Run in the project/erp-taranom-prod-p5-r2` (base `a152086`).
- Status: **active** — NOT completed; **NO Iran deploy** until Independent + Security Approved.
- High-1/2/3 + Medium-1/2 implemented; gates green pending final `npm run test:production` tip commit.
- Production VPS hashes still pre-R2 (expected until Approved deploy). SW tip `erp-taranom-v146`.
- Do not implement in dirty `erp-taranom1`. Leave `ai/W1-*` alone.

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
