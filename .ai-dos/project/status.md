# Project Status

- Last verified: 2026-08-09
- Primary branch: `claude/claude-md-docs-2ssrpy`
- Wave 0: complete (sharp production waiver `0.33.5`)
- Wave 1 / P1: MVP integrated (moadian foundation, HR snapshot, variants, pagination, E2E)
- Wave 2 / P2: MVP on primary (license, onboarding, B2B credit, bank recon, HR draft export, observability)
- PROD-P3: variable analysis ADR-011 — Iran SFTP ✅
- PROD-P4: overhead + labor + cost-center rates — prior tip `a68d901`
- Active: MERGE-ALL-DEPLOY — push full W1+W2+P3+P4 tip to Iran
- Production: do not blind-reset dirty VPS untracked secrets/`_recover`; sharp stays `0.33.5`

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
