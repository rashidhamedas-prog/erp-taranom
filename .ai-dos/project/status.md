# Project Status

- Last verified: 2026-08-09
- Primary branch: `claude/claude-md-docs-2ssrpy`
- Wave 0: complete (sharp production waiver `0.33.5`)
- **Wave 2 / P2:** MVP slices merged on `ai/W2-ORCH-wave2` @ `3b0c790` — license, onboarding, B2B credit, bank recon import/match, HR draft export, observability. Exit gate (pilots/SLA) still open.
- Wave 1 / P1: other agents (`ai/W1-*`) — do not modify from this owner.
- Deploy: Wave 2 not deployed to Iran.

## Working quality commands

- `git diff --check`
- `node server/scripts/check-audit-waivers.js`
- `node server/scripts/test-license.js`
- `node server/scripts/test-onboarding.js`
- `node server/scripts/test-b2b-credit.js`
- `node server/scripts/test-bank-recon-import.js`
- `node server/scripts/test-payroll-export.js`
- `node server/scripts/test-observability.js`
