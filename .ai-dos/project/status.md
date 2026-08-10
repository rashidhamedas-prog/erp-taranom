# Project Status

- Last verified: 2026-08-10 (~14:30 +03:30)
- Primary branch: `claude/claude-md-docs-2ssrpy` (merge worktree `ai/PROD-P5-merge-primary` based on `11c5e85`)
- **PROD-P5 completed** after Independent Review remediation merge: tip `5fb2276` / docs `5ae889c` / ai-dos `d571af9` re-reviewed **Approved**; applying via this merge (`getBom`/`tree`/`compare` + mutate R11).
- Prior P5: Module 4 advanced BOM; security follow-up Iran SFTP ✅ (`c22c0fb` / docs `11c5e85`).
- **PROD-P3/P4** completed earlier.
- Wave 2 MVP merged; exit gate (pilots/SLA) still open.
- Wave 1 / P1: other agents (`ai/W1-*`) — do not modify from unrelated owners.
- Production: healthy; dirty VPS trees must not be blindly reset. SSH: `taranom@94.249.244.208`.

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
