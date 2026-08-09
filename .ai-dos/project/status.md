# Project Status

- Last verified: 2026-08-09
- Primary branch: `claude/claude-md-docs-2ssrpy` @ `ced58ef`
- Wave 0: complete (sharp production waiver `0.33.5`)
- Wave 1 / P1: MVP integrated on primary (moadian foundation, HR snapshot, variants, pagination, E2E)
- Wave 2 / P2: MVP on primary (license, onboarding, B2B credit, bank recon, HR draft export, observability)
- PROD-P3 / P4: on primary and deployed
- Active: none (MERGE-ALL-DEPLOY completed)
- Production Iran: HEAD `ced58ef`; health/ready/root 200; sharp `0.33.5`; do not blind-reset untracked secrets/`_recover`

## Working quality commands

- `git diff --check`
- `node server/scripts/check-audit-waivers.js`
- `node server/scripts/test-production-variable.js`
- `node server/scripts/test-production-overhead-labor.js`
- `node server/scripts/test-license.js`
- `node server/scripts/test-list-pagination.js`
- `node server/scripts/test-moadian-foundation.js`
- `node server/scripts/test-product-variants.js`
- `node server/scripts/test-observability.js`
