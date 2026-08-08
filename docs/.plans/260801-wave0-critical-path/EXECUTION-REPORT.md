# W0-OPS-001 Execution Report

Date: 2026-08-08

Branch: `ai/W0-OPS-001-wave0-ops-close`

Base: `a45b97c`

## Outcome

P0-C is operational: encrypted production backups are copied outside the VPS to the Windows PC every 15 minutes, verified before promotion, and restore-drilled from the downloaded copy. Signed RC APK 2.0.33 and EXE 2.0.10 were staged, verified, atomically promoted and HTTP re-hashed.

## Scope delivered

- DPAPI recovery key and fail-closed production-key provisioning.
- Path-confined, root-owned forced wrapper and dedicated Windows pull identity.
- Sidecar-before/archive/sidecar-after transfer, SHA-256, receipt, lock, retention and failure evidence.
- Limited Scheduled Task with S4U-first/Interactive fallback.
- Isolated multi-company restore/fingerprint drill.
- Resumable release uploader with pinned host, put/reput, digest stage, stale lock handling, SHA-256/SHA-512 feed validation, rollback and HTTP verification.
- Gate, runbook, changelog, task and AI-DOS evidence.

## Validation observed

- Offsite contract: 26/26 PASS.
- Backup policy: 4/4 PASS.
- Backup DR: 14/14 PASS.
- Uploader unit + real artifact metadata: 3/3 PASS.
- Real APK/EXE/feed SHA-256/SHA-512: PASS.
- Embedded desktop/android: 224/224 each, diff=0.
- Real Windows restore: fingerprints match, RTO estimate 3 seconds.
- Real release: all five artifacts verified/promoted/HTTP-hashed.
- `git diff --check`: PASS.
- Dependency gate after `sharp@0.35.0`: no unwaived high/critical; upload 55/55 and sync-file 19/19 PASS.

## Review and deviations

- Independent Reviewer: Approved.
- Independent Security: Approved with documented waivers.
- A dedicated Unix user approach was attempted but rolled back before use; the final design uses a tracked root-owned strict command wrapper. Temporary account/export files were removed.
- First release upload attempt failed safely before promotion because initial SFTP required `put`; implementation was corrected to initial `put` and resumed `reput`, then the full real publish passed.
- The first remote CI run exposed a new `sharp <0.35.0` high advisory; `sharp` was upgraded to 0.35.0 and the audit/image security suites passed locally before the follow-up push.

## Residual risks / follow-up

- Replace the broad admin release key with a restricted publisher account and server-side promote protocol.
- Reinstall Scheduled Task elevated as S4U to preserve RPO while logged out.
- Add immutable/cold backup and commercial OV/EV certificate if desired.
- Collect remote CI/staging automation evidence for the remaining P0-Q2 follow-up.
