# Project Status

- Last verified: 2026-08-10 (~12:55 +03:30)
- Primary branch: `claude/claude-md-docs-2ssrpy`
- **Active now: PROD-P5 (reactivated)** — reviewer/security remediation; **do not mark completed / no Iran deploy** until High/Medium closed + full tests + independent re-review.
- Worktree: `D:/soft/Claud/porje/Run in the project/erp-taranom-prod-p5` · Branch: `ai/PROD-P5-advanced-bom`
- Prior P5 merge tip was `c22c0fb` / docs `11c5e85` (security remedia may already be present — verifying).
- Wave 1 `ai/W1-*`: do not touch.
- Production: dirty VPS — no blind reset.

## Working quality commands

- `node server/scripts/test-production-bom-advanced.js`
- `node server/scripts/test-production-overhead-labor.js`
- `node server/scripts/test-production-variable.js`
- `node server/scripts/test-sms.js`
- `node server/scripts/test-sync.js`
- `node server/scripts/_diag-sync-gaps-b16e78.js`
- `git diff --check`
- `node --check server/server.js`
- `node server/scripts/check-audit-waivers.js`
