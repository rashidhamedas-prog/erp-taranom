# Project Status

- Last verified: 2026-08-10 (~11:20 +03:30)
- Primary branch: `claude/claude-md-docs-2ssrpy` @ `4306168` (PROD-P5 merge)
- Wave 0: complete (sharp production waiver `0.33.5`)
- **PROD-P5** completed: advanced BOM Module 4 (routing/co-by/full-cost). Tests 32/32. Iran SFTP ✅.
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
