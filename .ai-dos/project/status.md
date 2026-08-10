# Project Status

- Last verified: 2026-08-09 (~17:05 +03:30)
- Primary branch: `claude/claude-md-docs-2ssrpy`
- Wave 0: complete (sharp production waiver `0.33.5`)
- **Wave 2 / P2:** MVP slices merged on `ai/W2-ORCH-wave2` @ `3b0c790`. Exit gate (pilots/SLA) still open. Iran deploy `b4b653b`.
- **PROD-P3** (variable analysis / ADR-011): completed; merged to primary @ `fefedda`; Iran SFTP deploy ✅.
- **PROD-P4** (overhead + labor + cost-center rates): completed (`d0465ac`); `test-production-overhead-labor.js` 38/38 PASS; merged + Iran tip sync ✅.
- **Active now: PROD-P5** — Production Module 4 (advanced BOM + routing + co/by). Owner `cursor:orchestrator`. Branch `ai/PROD-P5-advanced-bom`. Worktree `D:/soft/Claud/porje/Run in the project/erp-taranom-prod-p5`. Preflight complete; **no application code changes until implementer starts in that worktree.**
- Wave 1 / P1: other agents (`ai/W1-*`) — do not modify from unrelated owners.
- Production: healthy on `sharp@0.33.5`; dirty VPS trees must not be blindly reset. SSH: `taranom@94.249.244.208` with `id_ed25519_taranom`.
- Primary local `erp-taranom1`: dirty (untracked AI-DOS/docs/scripts) and often behind origin — **do not implement in primary**; use task worktree.

## Working quality commands

- `git diff --check`
- `node server/scripts/check-audit-waivers.js`
- `node --check server/server.js`
- `node server/scripts/test-production-bom-advanced.js`  ← PROD-P5 gate
- `node server/scripts/test-production-overhead-labor.js`
- `node server/scripts/test-production-variable.js`
- `node server/scripts/test-sms.js`
- `node server/scripts/test-sync.js`
- `node server/scripts/test-license.js`
- `node server/scripts/test-onboarding.js`
- `node server/scripts/test-b2b-credit.js`
- `node server/scripts/test-bank-recon-import.js`
- `node server/scripts/test-payroll-export.js`
- `node server/scripts/test-observability.js`
