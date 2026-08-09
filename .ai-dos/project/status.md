# Project Status

- Last verified: 2026-08-09
- Primary branch: `claude/claude-md-docs-2ssrpy`
- Task branch: `ai/W0-OPS-002-sharp-production-deploy` (worktree `erp-taranom-w0-ops-002`)
- Current source state: Wave 0 Gate run `31265434377` passed 7/7 on commit `7460857`; source pins `sharp@0.35.0`.
- Current production operations: encrypted Windows offsite pull and weekly restore drill previously returned result `0`; APK 2.0.33 and EXE 2.0.10 release feed published and hash-verified.
- Production sharp status: **BLOCKED on hardware**. Offline Linux x64 bundle deploy of `sharp@0.35.0` was attempted twice with automatic module restore; live runtime remains healthy on `sharp@0.33.5` (`REQUIRE_OK`, HTTP root/health `200`, PM2 online, no restart performed for the failed applies).
- Blocker evidence: VPS CPU is `QEMU Virtual CPU version 2.5+` missing x86-64-v2 flags (`popcnt`, `sse4_1`, `sse4_2`, `ssse3`). Native `0.35.0` fails with `Unsupported CPU: Prebuilt binaries for Linux x64 require v2 microarchitecture`. Wasm fallback also needs SSE4.1, which this CPU lacks.
- Required unblock: hypervisor/provider must expose at least x86-64-v2 (SSE4.2) — e.g. Proxmox CPU type `x86-64-v2`/`host` — then rerun `scripts/deploy-sharp-production.ps1 -Deploy`.
- Known dirty state: VPS repository at `6390bcc` still has operational modifications/untracked recovery and secret files; original local workspace `erp-taranom1` remains dirty/user-owned. Blind pull/reset remains prohibited.
- Next milestone: owner decision on CPU upgrade vs temporary production advisory waiver; do not start Waves 1–4 without owner selection.

## Working quality commands

- `git diff --check`
- `node server/scripts/check-audit-waivers.js`
- `node server/scripts/test-upload-ssrf-sync-security.js`
- `node server/scripts/test-sync-file-security.js`
- `node server/scripts/test-offsite-pull-contract.js`
- `node scripts/prepare-embedded-server.js all`
- `node scripts/compare-embedded-hash.js`
