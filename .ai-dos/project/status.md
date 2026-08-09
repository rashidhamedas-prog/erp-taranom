# Project Status

- Last verified: 2026-08-09
- Primary branch: `claude/claude-md-docs-2ssrpy`
- Current source state: Wave 0 Gate run `31265434377` passed 7/7 on commit `7460857`; final handoff commits are pushed through `97375fc`.
- Current production operations: encrypted Windows offsite pull and weekly restore drill are scheduled and previously returned result `0`; APK 2.0.33 and EXE 2.0.10 release feed is published and hash-verified.
- Production dependency exception: source uses `sharp@0.35.0`, but VPS runtime is healthy and deliberately rolled back to `sharp@0.33.5` after registry timeout. Deploying 0.35.0 safely is the active task.
- Known dirty state: VPS repository at `6390bcc` has operational modifications/untracked recovery and secret files; original local workspace has user-owned `server/routes/accounting.js` and untracked AI-DOS/docs changes. Blind pull/reset is prohibited.
- Next milestone: W0-OPS-002 safe production sharp deployment and state reconciliation; do not start Waves 1–4 without owner selection.

## Working quality commands

- `git diff --check`
- `node server/scripts/check-audit-waivers.js`
- `node server/scripts/test-upload-ssrf-sync-security.js`
- `node server/scripts/test-sync-file-security.js`
- `node server/scripts/test-offsite-pull-contract.js`
- `node scripts/prepare-embedded-server.js all`
- `node scripts/compare-embedded-hash.js`
