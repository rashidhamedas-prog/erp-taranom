# Project Status

- Last verified: 2026-08-10 (~19:00 +03:30)
- Corrective **PROD-P5-R2**: Independent Reviewer **Approved with comments**; Security **Approved**.
- Code tip: `1728626` (+ docs `97af788` / approval record `f2d6a51`).
- Gates on tip: `npm run test:production` ALL GREEN; embedded diff=0; P2 36/36; advanced 46/46.
- Apply phase: merge → primary `claude/claude-md-docs-2ssrpy` + Iran SFTP overlay (no blind pull / no `--update-env`).
- SW `erp-taranom-v146`. Do not implement in dirty `erp-taranom1`. Leave `ai/W1-*` alone.

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
