# Project Status

- Last verified: 2026-08-10 (~20:10 +03:30)
- **PROD-P5-R2 completed** (reconfirmed by fresh Independent Reviewer session).
- Independent Reviewer: **APPROVED** (orchestrated re-review; no open Critical/High/Medium).
- Security: **Approved** (agent f3d138f1; no open Critical/High/Medium).
- Code tip: `1728626`; primary `claude/claude-md-docs-2ssrpy` @ `a1f219b` (same tip lineage).
- Iran: SFTP overlay stamp `.sftp-deploy-stamp-prod-p5-r2` hash=1728626; probe hashes YES; health/ready/root 200; SW `erp-taranom-v146`.
- Claims remain released (`file_claims: []`). Do not implement in dirty `erp-taranom1`. Leave `ai/W1-*` alone.

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
