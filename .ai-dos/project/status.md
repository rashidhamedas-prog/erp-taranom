# Project Status

- Last verified: 2026-08-09
- Primary branch: `claude/claude-md-docs-2ssrpy`
- Wave 0 Gate: complete — permanent sharp runtime waiver on production `0.33.5`.
- **Active wave for this owner:** Wave 2 / P2 (`ai/W2-ORCH-wave2`) — آماده فروش کنترل‌شده.
- Wave 1 / P1: owned by other agents (`ai/W1-*` worktrees) — do not modify.
- Next milestone: land Wave 2 MVP slices (license, onboarding, B2B, treasury, HR export, observability).

## Working quality commands

- `git diff --check`
- `node server/scripts/check-audit-waivers.js`
- `node server/scripts/test-upload-ssrf-sync-security.js`
- `node server/scripts/test-sync-file-security.js`
- `node server/scripts/test-offsite-pull-contract.js`
- `node scripts/prepare-embedded-server.js all`
- `node scripts/compare-embedded-hash.js`
