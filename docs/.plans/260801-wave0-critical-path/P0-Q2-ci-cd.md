# Phase P0-Q2 — CI/CD pipeline

**Status:** `[x]` — remote Wave 0 Gate green and approved RC feed deploy/smoke complete
**Roadmap:** فاز P0-Q2

## Tasks

- [x] Lint + frontend script parse in CI
- [x] Parallel test suites with per-job timeout
- [x] Dependency/security scan
- [x] Migration test job
- [x] Source drift check (from P0-B)
- [x] Approved RC feed deploy + HTTP hash smoke (staging automation deferred outside P0)
- [x] Manual production approval + verify-before-promote/rollback uploader for RC feed
- [x] Versioned artifacts + SHA-256/SHA-512 + HTTP re-verification

## Verification

- [x] CI green on working branch (`7460857`, run `31265434377`)
- [x] Test suites publish logs artifacts on failure
- [x] Drift command is fail-closed on embedded mismatch

**Operational evidence:** APK 2.0.33 / EXE 2.0.10 and metadata were staged, verified, atomically promoted and HTTP-hash checked on 2026-08-08. GitHub Wave 0 Gate run `31265434377`: 7/7 jobs successful.
