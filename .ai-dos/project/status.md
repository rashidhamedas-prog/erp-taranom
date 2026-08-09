# Project Status

- Last verified: 2026-08-09
- Primary branch: `claude/claude-md-docs-2ssrpy`
- Wave 0 Gate: complete — GitHub run `31265434377` on `7460857` was 7/7 green; P0-A through P0-Q2 closed.
- W0-OPS-001: completed (offsite backup + RC binary publish).
- W0-OPS-002: completed with **owner permanent production waiver** for runtime `sharp@0.33.5` (no expiry). Source/CI remains pinned to `sharp@0.35.0`.
- PROD-P3 (variable analysis / ADR-011): implemented on `ai/PROD-P3-variable-analysis`; `test-production-variable.js` 27/27 PASS; SW `v144`.
- Production: healthy on `sharp@0.33.5`; dirty VPS/`erp-taranom1` trees must not be blindly reset.
- Next milestone: merge/push PROD-P3 then owner-selected Wave 1 / next production phase.

## Working quality commands

- `git diff --check`
- `node server/scripts/check-audit-waivers.js`
- `node server/scripts/test-upload-ssrf-sync-security.js`
- `node server/scripts/test-sync-file-security.js`
- `node server/scripts/test-offsite-pull-contract.js`
- `node scripts/prepare-embedded-server.js all`
- `node scripts/compare-embedded-hash.js`
- `node server/scripts/test-production-variable.js`
