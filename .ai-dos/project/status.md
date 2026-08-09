# Project Status

- Last verified: 2026-08-09
- Primary branch: `claude/claude-md-docs-2ssrpy`
- Wave 0: complete (sharp production waiver `0.33.5`)
<<<<<<< HEAD
- Wave 1 / P1: MVP integrated from `ai/W1-ORCH-wave1-integration` (moadian foundation, HR snapshot, variants, pagination, E2E)
- Wave 2 / P2: MVP on primary (license, onboarding, B2B credit, bank recon, HR draft export, observability)
- PROD-P3: variable analysis ADR-011 on primary (`ecba58b`)
- Next: full Iran deploy of merged tip; tax-advisor sign-off for live moadian still open
- Production: do not blind-reset dirty VPS untracked secrets/`_recover`
=======
- **Wave 2 / P2:** MVP slices merged on `ai/W2-ORCH-wave2` @ `3b0c790` — license, onboarding, B2B credit, bank recon, HR draft export, observability. Exit gate (pilots/SLA) still open. Iran deploy `b4b653b`.
- **PROD-P3** (variable analysis / ADR-011): completed; merged to primary @ `fefedda`; Iran SFTP deploy ✅ (health/ready 200, SW `v144`); `test-production-variable.js` 27/27 PASS.
- Wave 1 / P1: other agents (`ai/W1-*`) — do not modify from unrelated owners.
- Production: healthy on `sharp@0.33.5`; dirty VPS trees must not be blindly reset.
>>>>>>> origin/claude/claude-md-docs-2ssrpy

## Working quality commands

- `git diff --check`
- `node server/scripts/check-audit-waivers.js`
- `node server/scripts/test-production-variable.js`
- `node server/scripts/test-license.js`
- `node server/scripts/test-onboarding.js`
- `node server/scripts/test-b2b-credit.js`
- `node server/scripts/test-bank-recon-import.js`
- `node server/scripts/test-list-pagination.js`
- `node server/scripts/test-moadian-foundation.js`
- `node server/scripts/test-product-variants.js`
- `node server/scripts/test-observability.js`
