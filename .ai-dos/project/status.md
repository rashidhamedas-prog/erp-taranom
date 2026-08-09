# Project Status

- Last verified: 2026-08-09
- Primary branch: `claude/claude-md-docs-2ssrpy`
- Wave 0: complete (sharp production waiver `0.33.5`)
- **Wave 2 / P2:** MVP slices merged on `ai/W2-ORCH-wave2` @ `3b0c790`. Exit gate (pilots/SLA) still open. Iran deploy `b4b653b`.
- **PROD-P3** (variable analysis / ADR-011): completed; merged to primary @ `fefedda`; Iran SFTP deploy ✅ (health/ready 200, SW `v144`); `test-production-variable.js` 27/27 PASS.
- **PROD-P4** (overhead + labor + cost-center rates): completed (`d0465ac`); `test-production-overhead-labor.js` 38/38 PASS; Iran deploy ✅ at `a68d901` via SSH ff-pull + pm2 restart; root 200; SW `v144`.
- Wave 1 / P1: other agents (`ai/W1-*`) — do not modify from unrelated owners.
- Production: healthy on `sharp@0.33.5`; dirty VPS trees must not be blindly reset. SSH: `taranom@94.249.244.208` with `id_ed25519_taranom`.

## Working quality commands

- `git diff --check`
- `node server/scripts/check-audit-waivers.js`
- `node server/scripts/test-production-variable.js`
- `node server/scripts/test-production-overhead-labor.js`
- `node server/scripts/test-license.js`
- `node server/scripts/test-onboarding.js`
- `node server/scripts/test-b2b-credit.js`
- `node server/scripts/test-bank-recon-import.js`
- `node server/scripts/test-payroll-export.js`
- `node server/scripts/test-observability.js`
