# Project Status

- Last verified: 2026-08-10 (~18:30 +03:30)
- Active corrective: **PROD-P5-R2** on `fix/PROD-P5-R2-review-remediation`
  worktree `D:/soft/Claud/porje/Run in the project/erp-taranom-prod-p5-r2` (base `a152086`).
- Code tip: `1728626` (+ docs stamp `97af788`).
- Status: **active** — NOT completed; **NO Iran deploy**.
- Independent Reviewer: **Approved with comments** (no open High/Medium).
- Security: re-review required on tip `1728626` only (prior review inspected wrong tree / stale `UPDATE products`).
- Gates on tip: `npm run test:production` ALL GREEN; embedded diff=0; P2 36/36; advanced 46/46.
- Production VPS hashes still pre-R2 (expected until Approved deploy). SW `erp-taranom-v146`.
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
- `npm.cmd --prefix server run test:production`
